'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { until } = require('./helpers');
const { CodexArchiveHelperClient } = require('../lib/codex-archive-helper-client');
const { CodexSteeringHelperClient } = require('../lib/codex-steering-helper-client');

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

test('Desktop helper supplies Codex caller identity for steering and archival', async (t) => {
  const dir = fs.mkdtempSync('/tmp/tsq-desktop-');
  const pipePath = path.join(dir, 'host.sock');
  const archivePath = path.join(dir, 'archive.sock');
  const steeringPath = path.join(dir, 'steering.sock');
  const token = 'test-helper-token';
  const calls = [];
  const sockets = new Set();
  const host = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        let response;
        if (request.method === 'tools/list') {
          response = { result: { tools: [
            { name: 'send_message_to_thread', namespace: 'codex_app' },
            { name: 'set_thread_archived', namespace: 'codex_app' },
          ] } };
        } else if (request.method === 'tools/call' && request.params.callerSource === 'codex') {
          calls.push(request.params);
          response = { result: { success: true, contentItems: [] } };
        } else {
          // Current Desktop rejects the old request before executing the tool.
          response = { error: { code: -32602, message: 'Invalid app tool request' } };
        }
        socket.write(frame({ jsonrpc: '2.0', id: request.id, ...response }));
      }
    });
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  host.listen(pipePath);
  await once(host, 'listening');
  child = spawn(process.execPath, [path.resolve(__dirname, '../lib/codex-archive-helper-server.js')], {
    env: {
      ...process.env,
      CODEX_APP_TOOLS_PIPE_PATH: pipePath,
      TOWNSQUARE_ARCHIVE_HELPER_SOCK: archivePath,
      TOWNSQUARE_STEERING_HELPER_SOCK: steeringPath,
      TOWNSQUARE_ARCHIVE_HELPER_TOKEN: token,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await until(() => {
    assert.equal(child.exitCode, null, stderr);
    return fs.existsSync(steeringPath) && fs.existsSync(archivePath);
  });

  const steering = new CodexSteeringHelperClient({ socketPath: steeringPath, token });
  assert.deepEqual(await steering.sendMessage('target', 'claude-proxy', 'new direction'), {
    delivered: true, threadId: 'target',
  });
  const archive = new CodexArchiveHelperClient({ socketPath: archivePath, token });
  assert.deepEqual(await archive.archiveThread('claude-proxy', 'caller'), {
    archived: true, threadId: 'claude-proxy',
  });
  assert.deepEqual(calls.map(({ tool, threadId, arguments: args }) => ({ tool, threadId, args })), [
    { tool: 'send_message_to_thread', threadId: 'claude-proxy', args: { threadId: 'target', prompt: 'new direction' } },
    { tool: 'set_thread_archived', threadId: 'caller', args: { archived: true, threadId: 'claude-proxy' } },
  ]);
});
