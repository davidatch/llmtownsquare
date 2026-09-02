'use strict';
/**
 * Minimal client for the public Codex app-server protocol.
 *
 * Codex owns task discovery, names, threads, and turns. Town Square only translates between that
 * protocol and Claude Code's peer socket protocol.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { PROVIDER_HEADER, PROVIDER_ID } = require('./codex-provider');
const { archiveHelperSocketPath } = require('./codex-archive-helper-client');
const { steeringHelperSocketPath } = require('./codex-steering-helper-client');

const REQUEST_TIMEOUT_MS = duration(process.env.TOWNSQUARE_CODEX_REQUEST_TIMEOUT_MS, 30000);
const RECONNECT_MS = duration(process.env.TOWNSQUARE_CODEX_RECONNECT_MS, 2000);

function duration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function protocolError(error, method) {
  const message = error && typeof error === 'object' ? error.message : String(error || 'unknown error');
  const err = new Error(`Codex app-server ${method} failed: ${message}`);
  if (error && typeof error === 'object') {
    err.code = error.code;
    err.data = error.data;
  }
  return err;
}

function archiveHelperCommand({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const configured = env.TOWNSQUARE_ARCHIVE_HELPER_NODE || env.CODEX_MCP_NODE_PATH;
  const candidates = [
    configured,
    ...(platform === 'darwin' ? [
      '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',
      '/Applications/Codex.app/Contents/Resources/cua_node/bin/node',
    ] : []),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || process.execPath;
}

class CodexAppServerClient extends EventEmitter {
  constructor({
    command = process.env.TOWNSQUARE_CODEX_BIN || 'codex',
    args = ['app-server', '--stdio'],
    spawnProcess = spawn,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    reconnectMs = RECONNECT_MS,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = duration(requestTimeoutMs, REQUEST_TIMEOUT_MS);
    this.reconnectMs = duration(reconnectMs, RECONNECT_MS);
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.stopped = false;
    this.connecting = undefined;
    this.child = undefined;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.serverInfo = undefined;
    this.terminalTurns = new Map();
  }

  connect() {
    if (this.ready) return Promise.resolve(this.serverInfo);
    if (this.connecting) return this.connecting;
    this.stopped = false;
    const attempt = this._connect().finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    });
    this.connecting = attempt;
    return attempt;
  }

  async _connect() {
    const child = this.spawnProcess(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(child, chunk));
    child.stderr.on('data', (chunk) => this._onStderr(child, chunk));
    child.once('error', (err) => this._onProcessFailure(child, err));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      this._onProcessFailure(child, new Error(`Codex app-server stopped (${detail})`));
    });

    try {
      const result = await this._requestOn(child, 'initialize', {
        clientInfo: { name: 'llmtownsquare', title: 'LLM Town Square', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      if (this.child !== child) throw new Error('Codex app-server was replaced during initialization');
      this._write(child, { method: 'initialized', params: {} });
      this.serverInfo = result;
      this.ready = true;
      return result;
    } catch (err) {
      if (this.child === child) {
        this.child = undefined;
        try { child.kill(); } catch {}
      }
      throw err;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const child = this.child;
    this.child = undefined;
    const err = new Error('Codex app-server client stopped');
    this._rejectPending(err);
    this.ready = false;
    this.connecting = undefined;
    this.terminalTurns.clear();
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  /**
   * Create a separate app-server process with the same transport settings. Threads started by
   * this client are owned only until the isolated process exits, so durable proxy rollouts do not
   * retain a writer lock in the relay's long-lived inventory client.
   */
  createIsolatedClient() {
    return new CodexAppServerClient({
      command: this.command,
      args: [...this.args],
      spawnProcess: this.spawnProcess,
      requestTimeoutMs: this.requestTimeoutMs,
      reconnectMs: this.reconnectMs,
    });
  }

  /** Stop the owned app-server process and wait for its rollout writers to be released. */
  async close({ timeoutMs = 5000 } = {}) {
    const child = this.child;
    if (!child) {
      this.stop();
      return;
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    this.stop();
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  request(method, params = {}) {
    if (!this.ready || !this.child) {
      const err = new Error('Codex app-server is not connected');
      err.status = 503;
      return Promise.reject(err);
    }
    return this._requestOn(this.child, method, params);
  }

  _requestOn(child, method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { child, method, resolve, reject, timer });
      try {
        this._write(child, { id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _write(child, message) {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('Codex app-server stdin is unavailable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _onStdout(child, chunk) {
    if (child !== this.child) return;
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('warning', `ignored malformed Codex app-server output: ${line.slice(0, 200)}`);
        continue;
      }
      this._onMessage(child, message);
    }
  }

  _onMessage(child, message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.child !== child) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(protocolError(message.error, pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'turn/completed' && message.params?.turn?.id) {
      const key = `${String(message.params.threadId || '').toLowerCase()}:${message.params.turn.id}`;
      this.terminalTurns.set(key, message.params.turn);
      if (this.terminalTurns.size > 1000) this.terminalTurns.delete(this.terminalTurns.keys().next().value);
    }
    if (message.method) this.emit('notification', message.method, message.params);
  }

  _onStderr(child, chunk) {
    if (child !== this.child) return;
    this.stderrBuffer += chunk;
    for (;;) {
      const newline = this.stderrBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stderrBuffer.slice(0, newline).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line && !/^\d{4}-\d{2}-\d{2}T.*\b(INFO|DEBUG)\b/.test(line)) {
        this.emit('warning', `Codex app-server: ${line}`);
      }
    }
  }

  _onProcessFailure(child, err) {
    if (child !== this.child) return;
    this.child = undefined;
    this.ready = false;
    this._rejectPending(err);
    if (!this.stopped && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect().catch((failure) => this.emit('warning', failure.message));
      }, this.reconnectMs);
      this.reconnectTimer.unref?.();
    }
  }

  _rejectPending(err) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  async listThreads() {
    const [nativeThreads, proxySummaries] = await Promise.all([
      this._listThreadsForProviders(),
      this._listThreadsForProviders([PROVIDER_ID]),
    ]);
    const proxyThreads = await Promise.all(
      proxySummaries.map(async (summary) => {
        const result = await this.request('thread/read', { threadId: summary.id, includeTurns: false });
        return result?.thread || summary;
      })
    );
    const byId = new Map(nativeThreads.map((thread) => [thread.id, thread]));
    for (const thread of proxyThreads) byId.set(thread.id, thread);
    return [...byId.values()];
  }

  async _listThreadsForProviders(modelProviders) {
    const threads = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('thread/list', {
        archived: false,
        useStateDbOnly: true,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        limit: 100,
        ...(modelProviders && { modelProviders }),
        ...(cursor && { cursor }),
      });
      threads.push(...(result?.data || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return threads;
  }

  async queueMessage(threadId, text, clientUserMessageId) {
    const result = await this.request('thread/queue/add', {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text', text: String(text), text_elements: [] }],
    });
    return result?.queuedSubmission;
  }

  async listQueuedSubmissions(threadId) {
    const submissions = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('thread/queue/list', {
        threadId,
        limit: 100,
        ...(cursor && { cursor }),
      });
      submissions.push(...(result?.data || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return submissions;
  }

  async configureProvider(config) {
    const helperToken = config?.http_headers?.[PROVIDER_HEADER];
    return this.request('config/batchWrite', {
      edits: [
        { keyPath: `model_providers.${PROVIDER_ID}`, value: config, mergeStrategy: 'replace' },
        {
          keyPath: 'mcp_servers.townsquare_archive_helper',
          value: {
            // Desktop's dynamic-tools pipe rejects ad-hoc/unsigned clients on macOS. Its bundled
            // Node has the required signing identity; a normal system Node remains sufficient on
            // platforms where peer authorization is not enabled.
            command: archiveHelperCommand(),
            args: [path.join(__dirname, 'codex-archive-helper-server.js')],
            enabled: true,
            env_vars: ['CODEX_APP_TOOLS_PIPE_PATH'],
            env: {
              TOWNSQUARE_ARCHIVE_HELPER_SOCK: archiveHelperSocketPath(),
              TOWNSQUARE_STEERING_HELPER_SOCK: steeringHelperSocketPath(),
              ...(helperToken && { TOWNSQUARE_ARCHIVE_HELPER_TOKEN: helperToken }),
            },
            startup_timeout_sec: 10,
            tool_timeout_sec: 30,
          },
          mergeStrategy: 'replace',
        },
        {
          keyPath: 'mcp_servers.townsquare_steering_helper',
          value: {
            // Migration cleanup: steering now shares the Desktop-owned helper process. Keeping a
            // disabled valid entry stops older configurations from spawning a second process.
            command: archiveHelperCommand(),
            args: [path.join(__dirname, 'codex-archive-helper-server.js')],
            enabled: false,
          },
          mergeStrategy: 'replace',
        },
      ],
      reloadUserConfig: true,
    });
  }

  async startThread(params) {
    return this.request('thread/start', params);
  }

  async setThreadName(threadId, name) {
    return this.request('thread/name/set', { threadId, name });
  }

  async deleteThread(threadId) {
    return this.request('thread/delete', { threadId });
  }

  async archiveThread(threadId) {
    return this.request('thread/archive', { threadId });
  }

  async startTurn(threadId, text) {
    return this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: String(text), text_elements: [] }],
    });
  }

  async waitForTurn(threadId, turnId, { timeoutMs = 30000 } = {}) {
    const key = `${String(threadId).toLowerCase()}:${turnId}`;
    const cached = this.terminalTurns.get(key);
    if (cached) {
      this.terminalTurns.delete(key);
      return cached;
    }
    return new Promise((resolve, reject) => {
      const finish = (turn) => {
        clearTimeout(timer);
        this.removeListener('notification', onNotification);
        this.terminalTurns.delete(key);
        resolve(turn);
      };
      const onNotification = (method, params) => {
        if (
          method === 'turn/completed' &&
          String(params?.threadId || '').toLowerCase() === String(threadId).toLowerCase() &&
          params?.turn?.id === turnId
        ) finish(params.turn);
      };
      const timer = setTimeout(() => {
        this.removeListener('notification', onNotification);
        reject(new Error(`Codex turn ${turnId} did not complete in time`));
      }, timeoutMs);
      timer.unref?.();
      this.on('notification', onNotification);
      const raced = this.terminalTurns.get(key);
      if (raced) finish(raced);
    });
  }
}

module.exports = {
  CodexAppServerClient,
  archiveHelperCommand,
};
