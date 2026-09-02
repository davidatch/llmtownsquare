'use strict';

const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('events');

const { createHttpServer } = require('../server');

class FakeRelay extends EventEmitter {
  constructor() {
    super();
    this.ready = true;
    this.selfName = 'townsquare-test';
    this.sockDir = '/tmp/tsq-test-socks';
    this.sent = [];
    this.historyRequests = [];
    this.messages = [{ id: 1, kind: 'message', from: 'source', to: 'target', text: 'hello' }];
    this.agents = [{ name: 'source', kind: 'codex', status: 'idle' }];
    this.threads = [{ id: 'thread-1', name: 'source', status: 'idle' }];
    this.codex = {
      lastRefreshAt: 1234,
      lastError: undefined,
      list: () => this.agents,
      proxies: () => [],
      liveConversations: () => this.threads,
    };
  }

  listAgents() {
    return this.agents;
  }

  claudeSessions() {
    return [];
  }

  history(options) {
    this.historyRequests.push(options);
    return this.messages;
  }

  async send(message) {
    this.sent.push(message);
    if (!message.text) {
      const error = new Error('message must not be empty');
      error.status = 400;
      throw error;
    }
    return { id: 2, delivery: 'queued' };
  }

  async handleResponses(headers, body) {
    this.providerRequest = { headers, body };
    return 'event: response.completed\ndata: {}\n\n';
  }
}

async function boot(t) {
  const relay = new FakeRelay();
  const client = { ready: true, command: 'codex' };
  const app = createHttpServer({ relay, client, port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.dispose();
    await new Promise((resolve) => app.server.close(resolve));
  });
  return { relay, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

async function json(response) {
  const body = await response.json();
  return { status: response.status, contentType: response.headers.get('content-type'), body };
}

test('web inspector renders runtime data without HTML injection sinks', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  assert.match(html, /textContent/);
});

test('HTTP API exposes health, identities, threads, and message history as JSON', async (t) => {
  const { relay, baseUrl } = await boot(t);

  const health = await json(await fetch(`${baseUrl}/api/health`));
  assert.strictEqual(health.status, 200);
  assert.match(health.contentType, /^application\/json/);
  assert.strictEqual(health.body.ok, true);
  assert.strictEqual(health.body.name, 'townsquare-test');
  assert.strictEqual(health.body.codexNative.connected, true);

  const agents = await json(await fetch(`${baseUrl}/api/agents`));
  assert.deepStrictEqual(agents.body.agents, relay.agents);

  const threads = await json(await fetch(`${baseUrl}/api/threads`));
  assert.deepStrictEqual(threads.body.threads, relay.threads);

  const messages = await json(await fetch(`${baseUrl}/api/messages?since=7&limit=12`));
  assert.deepStrictEqual(messages.body.messages, relay.messages);
  assert.deepStrictEqual(relay.historyRequests.at(-1), { since: 7, limit: 12 });
});

test('HTTP API sends only the canonical JSON message fields', async (t) => {
  const { relay, baseUrl } = await boot(t);
  const response = await json(await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'ignored-by-from-thread',
      fromThread: 'thread-1',
      to: 'target',
      text: 'hello',
      threadId: 'legacy-thread',
      message: 'legacy-message',
    }),
  }));

  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(response.body, { id: 2, delivery: 'queued' });
  assert.deepStrictEqual(relay.sent, [{
    from: 'ignored-by-from-thread',
    fromThread: 'thread-1',
    to: 'target',
    text: 'hello',
  }]);
});

test('HTTP API rejects malformed, non-JSON, empty, and oversized sends', async (t) => {
  const { baseUrl } = await boot(t);

  const malformed = await json(await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  }));
  assert.strictEqual(malformed.status, 400);
  assert.match(malformed.body.error, /malformed JSON/);

  const nonJson = await json(await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  }));
  assert.strictEqual(nonJson.status, 415);

  const empty = await json(await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.strictEqual(empty.status, 400);
  assert.match(empty.body.error, /must not be empty/);

  const oversized = await json(await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'target', text: 'x'.repeat(1024 * 1024) }),
  }));
  assert.strictEqual(oversized.status, 413);
});

test('HTTP API serves the internal provider stream and JSON 404 errors', async (t) => {
  const { relay, baseUrl } = await boot(t);
  const provider = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-llmtownsquare-token': 'secret' },
    body: JSON.stringify({ input: [] }),
  });
  assert.strictEqual(provider.status, 200);
  assert.match(provider.headers.get('content-type'), /^text\/event-stream/);
  assert.match(await provider.text(), /response\.completed/);
  assert.deepStrictEqual(relay.providerRequest.body, { input: [] });

  const missing = await json(await fetch(`${baseUrl}/api/missing`));
  assert.strictEqual(missing.status, 404);
  assert.match(missing.body.error, /no route/);
});

test('event stream starts with current agents and message history', async (t) => {
  const { baseUrl } = await boot(t);
  const initialEvents = await new Promise((resolve, reject) => {
    let body = '';
    const timer = setTimeout(() => reject(new Error('timed out waiting for initial SSE events')), 2000);
    const request = http.get(`${baseUrl}/events`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (!body.includes('event: message')) return;
        clearTimeout(timer);
        request.destroy();
        resolve(body);
      });
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.match(initialEvents, /event: agents/);
  assert.match(initialEvents, /event: message/);
});
