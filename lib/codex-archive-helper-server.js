'use strict';

/**
 * Hidden MCP process spawned by Codex Desktop.
 *
 * It exposes no model tools. It gives the Town Square relay a narrow local channel to Desktop's
 * dynamic set_thread_archived and send_message_to_thread tools. Those operations run through the
 * Desktop instance that owns the task, avoiding model inference and active-writer races.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { removeInactiveSocket } = require('./uds');

const PIPE_PATH = process.env.CODEX_APP_TOOLS_PIPE_PATH;
const ARCHIVE_SOCKET_PATH = process.env.TOWNSQUARE_ARCHIVE_HELPER_SOCK;
const STEERING_SOCKET_PATH = process.env.TOWNSQUARE_STEERING_HELPER_SOCK;
const TOKEN = process.env.TOWNSQUARE_ARCHIVE_HELPER_TOKEN;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const LEADERSHIP_RETRY_MS = 2000;

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class HostToolsClient {
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.socket = undefined;
    this.connecting = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const pending = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(socket, chunk));
        socket.on('error', (error) => this._disconnect(socket, error));
        socket.on('close', () => this._disconnect(socket, new Error('Codex host tools pipe closed')));
        resolve();
      });
    }).finally(() => {
      if (this.connecting === pending) this.connecting = undefined;
    });
    this.connecting = pending;
    return pending;
  }

  async request(method, params) {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error('Codex host tools pipe is unavailable');
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    socket.write(encodeFrame({ id, jsonrpc: '2.0', method, params }));
    return response;
  }

  _onData(socket, chunk) {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) return socket.destroy();
      if (this.buffer.length < length + 4) return;
      const raw = this.buffer.subarray(4, length + 4).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return socket.destroy();
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message || 'Codex host tool failed'));
      else pending.resolve(message.result);
    }
  }

  _disconnect(socket, error) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const host = PIPE_PATH ? new HostToolsClient(PIPE_PATH) : undefined;
const controlServers = new Map();
let leadershipTimer;

async function archiveProxy({ threadId, callerThreadId }) {
  if (!threadId || !callerThreadId || callerThreadId === threadId) {
    throw new Error('invalid archive request');
  }
  const callId = `townsquare-archive-${crypto.randomUUID()}`;
  const result = await host.request('tools/call', {
    arguments: { archived: true, threadId },
    callId,
    namespace: 'codex_app',
    threadId: callerThreadId,
    tool: 'set_thread_archived',
    turnId: callId,
  });
  if (!result?.success) {
    const detail = result?.contentItems?.find((item) => item.type === 'inputText')?.text;
    throw new Error(detail || 'Codex Desktop rejected the archive');
  }
  return { archived: true, threadId };
}

async function sendMessage({ targetThreadId, callerThreadId, text }) {
  const prompt = String(text ?? '').trim();
  if (!targetThreadId || !callerThreadId || callerThreadId === targetThreadId || !prompt) {
    throw new Error('invalid steering request');
  }
  const callId = `townsquare-steer-${crypto.randomUUID()}`;
  const result = await host.request('tools/call', {
    arguments: { threadId: targetThreadId, prompt },
    callId,
    namespace: 'codex_app',
    threadId: callerThreadId,
    tool: 'send_message_to_thread',
    turnId: callId,
  });
  if (!result?.success) {
    const detail = result?.contentItems?.find((item) => item.type === 'inputText')?.text;
    throw new Error(detail || 'Codex Desktop rejected the steering message');
  }
  return { delivered: true, threadId: targetThreadId };
}

function handleControlRequest(request) {
  if (request.action === 'send_message') return sendMessage(request);
  if (!request.action || request.action === 'archive') return archiveProxy(request);
  throw new Error('invalid helper request');
}

async function serveControlSocket(socketPath) {
  if (!socketPath || !TOKEN || !host || controlServers.has(socketPath)) return;
  try {
    await removeInactiveSocket(socketPath, {
      expectedDir: path.dirname(socketPath),
      expectedBasename: path.basename(socketPath),
    });
  } catch (error) {
    if (error.code === 'ETSQSOCKETACTIVE') return;
    process.stderr.write(`Town Square Desktop helper preserved unsafe socket path: ${error.message}\n`);
    return;
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.pause();
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.end(`${JSON.stringify({ id: null, error: 'invalid helper request' })}\n`);
        return;
      }
      if (request.token !== TOKEN) {
        socket.end(`${JSON.stringify({ id: request.id, error: 'unauthorized helper request' })}\n`);
        return;
      }
      Promise.resolve().then(() => handleControlRequest(request)).then(
        (result) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`),
        (error) => socket.end(`${JSON.stringify({ id: request.id, error: error.message })}\n`)
      );
    });
  });
  controlServers.set(socketPath, server);
  server.once('error', () => {
    controlServers.delete(socketPath);
  });
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
  });
}

async function serveControlSockets() {
  await Promise.all([
    serveControlSocket(ARCHIVE_SOCKET_PATH),
    serveControlSocket(STEERING_SOCKET_PATH),
  ]);
}

async function becomeArchiveHelper() {
  if (!host || (!ARCHIVE_SOCKET_PATH && !STEERING_SOCKET_PATH) || !TOKEN) return;
  try {
    const listed = await host.request('tools/list', { threadStartKind: 'all' });
    if (!listed?.tools?.some((tool) => tool.name === 'set_thread_archived')) {
      process.stderr.write('Town Square Desktop helper: set_thread_archived is unavailable\n');
      return;
    }
    if (!listed?.tools?.some((tool) => tool.name === 'send_message_to_thread')) {
      process.stderr.write('Town Square Desktop helper: send_message_to_thread is unavailable; steering will queue\n');
    }
    await serveControlSockets();
    leadershipTimer = setInterval(() => serveControlSockets().catch(() => {}), LEADERSHIP_RETRY_MS);
    leadershipTimer.unref?.();
  } catch (error) {
    process.stderr.write(`Town Square Desktop helper could not connect to Codex Desktop: ${error.message}\n`);
  }
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  for (;;) {
    const newline = stdinBuffer.indexOf('\n');
    if (newline < 0) break;
    const raw = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!raw.trim()) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'townsquare-desktop-helper', version: '0.2.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: [] };
    } else if (message.method === 'ping') {
      result = {};
    } else {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' },
      })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
});

function shutdown(exitProcess = false) {
  clearInterval(leadershipTimer);
  for (const server of controlServers.values()) server.close();
  controlServers.clear();
  host?.socket?.destroy();
  if (exitProcess) process.exit(0);
}
process.once('SIGINT', () => shutdown(true));
process.once('SIGTERM', () => shutdown(true));
process.stdin.once('close', shutdown);
process.stdin.once('end', shutdown);

becomeArchiveHelper();
