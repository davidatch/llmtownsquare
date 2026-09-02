'use strict';

/** LLM Town Square local relay and JSON API. */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const registry = require('./lib/claude-registry');
const { CodexAppServerClient } = require('./lib/codex-app-server');
const { CodexArchiveHelperClient } = require('./lib/codex-archive-helper-client');
const { CodexSteeringHelperClient } = require('./lib/codex-steering-helper-client');
const { ensureProviderToken, providerConfig } = require('./lib/codex-provider');
const { Relay } = require('./lib/relay');

const HOST = '127.0.0.1';
const PORT = Number(process.env.TOWNSQUARE_PORT || 7777);
const BODY_CAP = 1024 * 1024;
const STATE_DIR = process.env.TOWNSQUARE_STATE_DIR || path.join(os.homedir(), '.townsquare');
const PROVIDER_TOKEN_FILE =
  process.env.TOWNSQUARE_PROVIDER_TOKEN_FILE || path.join(STATE_DIR, 'codex-provider-token');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) reject(httpError(413, 'request body too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    throw httpError(415, 'content-type must be application/json');
  }
  const raw = await readBody(req);
  if (!raw.trim()) throw httpError(400, 'request body must be a JSON object');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw httpError(400, 'request body contains malformed JSON');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw httpError(400, 'request body must be a JSON object');
  }
  return body;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function createHttpServer({ relay, client, indexFile = path.join(__dirname, 'public', 'index.html'), port = PORT }) {
  if (!relay || !client) throw new Error('createHttpServer requires relay and client');
  const sseClients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of sseClients) {
      try {
        response.write(payload);
      } catch {}
    }
  }

  const onMessage = (message) => broadcast('message', message);
  const onStatus = (message) => broadcast('status', message);
  const onAgents = () => broadcast('agents', relay.listAgents());
  relay.on('message', onMessage);
  relay.on('status', onStatus);
  relay.on('agents', onAgents);

  async function route(req, res, url) {
    const { pathname } = url;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const body = fs.readFileSync(indexFile);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
      });
      res.end(body);
      return;
    }

    // Proxy bootstrap requests can arrive while relay.start() is still reconciling tasks.
    if (req.method === 'POST' && pathname === '/v1/responses') {
      const body = await readJson(req);
      const stream = await relay.handleResponses(req.headers, body);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(stream),
      });
      res.end(stream);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const live = relay.codex.liveConversations();
      const agents = relay.listAgents();
      const claudeSessions = relay.claudeSessions();
      const healthy = relay.ready && client.ready;
      sendJson(res, healthy ? 200 : 503, {
        ok: healthy,
        ready: healthy,
        pid: process.pid,
        name: relay.selfName,
        uptimeSec: Math.round(process.uptime()),
        agents: agents.length,
        claudeSessions: claudeSessions.length,
        codexAgents: relay.codex.list().length,
        claudeProxies: relay.codex.proxies().length,
        codexNative: {
          connected: client.ready,
          command: client.command,
          threads: live.length,
          addressable: relay.codex.list().length,
          refreshedAt: relay.codex.lastRefreshAt || null,
          ...(relay.codex.lastError && { error: relay.codex.lastError }),
        },
        sessionsDir: registry.sessionsDir(),
        sockDir: relay.sockDir,
        port,
      });
      return;
    }

    if (!relay.ready) throw httpError(503, 'relay is still initializing');

    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, { agents: relay.listAgents() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/threads') {
      sendJson(res, 200, { threads: relay.codex.liveConversations() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/send') {
      const body = await readJson(req);
      const result = await relay.send({
        from: body.from,
        fromThread: body.fromThread,
        to: body.to,
        text: body.text,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/messages') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 200);
      sendJson(res, 200, { messages: relay.history({ since, limit }) });
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: agents\ndata: ${JSON.stringify(relay.listAgents())}\n\n`);
      for (const message of relay.history({ limit: 50 })) {
        res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      }
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 20000);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }

    throw httpError(404, `no route for ${req.method} ${pathname}`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);
    route(req, res, url).catch((error) => {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message });
      else res.end();
    });
  });

  function dispose() {
    relay.off('message', onMessage);
    relay.off('status', onStatus);
    relay.off('agents', onAgents);
    for (const response of sseClients) {
      try {
        response.end();
      } catch {}
    }
    sseClients.clear();
  }

  return { server, dispose };
}

function listen(server, port = PORT) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function main() {
  const client = new CodexAppServerClient();
  const archiveHelper = new CodexArchiveHelperClient();
  const steeringHelper = new CodexSteeringHelperClient();
  const relay = new Relay({ client, archiveHelper, steeringHelper });
  const { server, dispose } = createHttpServer({ relay, client });

  await listen(server);
  try {
    const providerToken = await ensureProviderToken(PROVIDER_TOKEN_FILE);
    relay.providerToken = providerToken;
    archiveHelper.token = providerToken;
    steeringHelper.token = providerToken;
    relay.codex.provider = providerConfig(`http://${HOST}:${PORT}/v1`, providerToken);
    const { staleRemoved } = await relay.start();

    console.log(`[townsquare] relay "${relay.selfName}" listening on http://${HOST}:${PORT}`);
    console.log(`[townsquare] peer socket ${relay.self.sockPath} (pid ${relay.self.pid})`);
    console.log(
      `[townsquare] claude sessions visible: ${relay.claudeSessions().length}` +
        (staleRemoved ? `, cleaned ${staleRemoved} stale record(s)` : '')
    );
    console.log(
      `[townsquare] native Codex tasks: ${relay.codex.liveConversations().length}, ` +
        `addressable: ${relay.codex.list().length}`
    );
  } catch (error) {
    dispose();
    await relay.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[townsquare] ${signal} — cleaning up`);
    dispose();
    try {
      await relay.stop();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => shutdown(signal));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[townsquare] failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { createHttpServer };
