'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sandbox, procStart, until } = require('./helpers');
const { FakeCodexClient, nativeThread } = require('./fake-codex');
const { delegatedPrompt } = require('../lib/codex-delegation');
const { PROVIDER_HEADER, proxySessionId } = require('../lib/codex-provider');

function fakeClaude(box, { name = 'claude-test', pid = process.ppid } = {}) {
  const registry = require('../lib/claude-registry');
  const { createInboxServer } = require('../lib/uds');
  const sockPath = path.join(box.socks, `${pid}.sock`);
  const peerToken = crypto.randomBytes(16).toString('hex');
  const sessionId = `fake-${pid}`;
  const received = [];
  try { fs.unlinkSync(sockPath); } catch {}
  const server = createInboxServer({ token: () => peerToken, onFrame: (frame) => received.push(frame) });
  return new Promise((resolve) => {
    server.listen(sockPath, () => {
      const ps = procStart(pid);
      const publish = (nextName) => {
        registry.writeRecord(pid, {
          pid,
          sessionId,
          name: nextName,
          cwd: '/tmp',
          startedAt: Date.now(),
          procStart: ps,
          messagingSocketPath: sockPath,
          status: 'idle',
          kind: 'interactive',
          peerProtocol: 1,
          version: '2.1.238',
        });
      };
      publish(name);
      registry.writeKeyFile(pid, sockPath, peerToken, ps);
      resolve({
        name,
        sessionId,
        sockPath,
        received,
        rename(nextName) {
          this.name = nextName;
          publish(nextName);
        },
        close: async () => {
          registry.removeRecord(pid, sockPath);
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

test('Claude sessions get native Codex proxies and messages cross without Town Square metadata', async (t) => {
  const box = sandbox();
  const { Relay } = require('../lib/relay');
  const { sendFrames } = require('../lib/uds');
  const registry = require('../lib/claude-registry');
  const w = require('../lib/wrapper');
  const source = nativeThread({ name: 'codex-test' });
  const client = new FakeCodexClient([source]);
  const steeredMessages = [];
  const steeringHelper = {
    async sendMessage(threadId, callerThreadId, text) {
      steeredMessages.push({ threadId, callerThreadId, text });
      return { delivered: true, threadId };
    },
  };
  const relay = new Relay({
    client,
    steeringHelper,
    selfName: 'townsquare-test',
    providerToken: 'secret',
  });
  await relay.start();
  const claude = await fakeClaude(box);
  await relay.sweep();

  t.after(async () => {
    await claude.close().catch(() => {});
    await relay.stop();
    box.cleanup();
  });

  const proxy = relay.codex.proxyForClaude({ sessionId: claude.sessionId });
  assert.ok(proxy, 'a marked Codex proxy is created automatically');
  assert.strictEqual(proxy.name, claude.name);
  const nativeProxy = client.threads.find((thread) => thread.id === proxy.threadId);
  assert.strictEqual(proxySessionId(nativeProxy.threadSource), claude.sessionId);
  assert.ok(
    client.startedTurns.some((item) => item.threadId === proxy.threadId),
    'one no-inference bootstrap turn materializes the native proxy task'
  );
  assert.strictEqual(client.isolatedClients.length, 1, 'proxy creation uses a separate app-server owner');
  assert.strictEqual(client.isolatedClients[0].connected, true);
  assert.strictEqual(client.isolatedClients[0].closed, true, 'proxy writer is released after bootstrap');
  assert.strictEqual(
    relay.listAgents().filter((agent) => agent.name === claude.name).length,
    1,
    'the proxy is not exposed as a duplicate logical agent'
  );

  const peer = relay.peers.get(source.id.toLowerCase());
  assert.ok(peer && fs.existsSync(peer.sockPath), 'the real Codex task is visible in Claude');
  const peerRecord = (await registry.listSessionsAsync({ includeTownsquare: true }))
    .find((record) => record.pid === peer.pid);
  assert.strictEqual(peerRecord.name, source.name);

  // Claude -> Codex uses Desktop's owner-side follow-up path, attributed to the stable proxy ID.
  const token = await registry.tokenForSocketAsync(peer.sockPath);
  const content = w.wrap({
    from: w.udsAddress(claude.sockPath),
    fromName: claude.name,
    fromSession: claude.sessionId,
    fromMode: 'prompting',
    body: 'ping from claude',
  });
  await sendFrames(peer.sockPath, token, [
    {
      msg_id: 'a'.repeat(24),
      type: 'user',
      message: { role: 'user', content },
      priority: 'next',
      from: w.udsAddress(claude.sockPath),
    },
  ]);
  const inbound = await until(() => steeredMessages.find((message) => message.threadId === source.id));
  assert.deepStrictEqual(inbound, {
    threadId: source.id,
    callerThreadId: proxy.threadId,
    text: 'ping from claude',
  });
  const receipt = await until(() =>
    claude.received.find((frame) => frame.type === 'control' && frame.action === 'peer_message_status')
  );
  assert.strictEqual(receipt.orig_msg_id, 'a'.repeat(24));

  const apiResult = await relay.send({ from: claude.name, to: source.name, text: 'priority API send' });
  assert.strictEqual(apiResult.delivery, 'steered');
  assert.deepStrictEqual(steeredMessages.at(-1), {
    threadId: source.id,
    callerThreadId: proxy.threadId,
    text: 'priority API send',
  });

  // Codex -> Claude goes through the proxy's no-inference Responses provider.
  claude.received.length = 0;
  const turnCount = client.startedTurns.length;
  const stream = await relay.handleResponses(
    {
      [PROVIDER_HEADER]: 'secret',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: proxy.threadId }),
    },
    {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Initialize the native Claude transport proxy.' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>runtime details</environment_context>' }],
        },
        {
          type: 'function_call_output',
          name: 'send_message_to_thread',
          namespace: 'codex_app',
          output: delegatedPrompt(source.id, 'pong from codex'),
        },
      ],
    }
  );
  assert.match(stream, /response\.completed/);
  assert.strictEqual(client.startedTurns.length, turnCount, 'the forwarding provider starts no model turn');
  const outbound = await until(() => claude.received.find((frame) => frame.type === 'user'));
  const parsed = w.parse(outbound.message.content);
  assert.strictEqual(parsed.fromName, source.name);
  assert.strictEqual(parsed.body, 'pong from codex');
  assert.doesNotMatch(parsed.body, /townsquare|delivery|reply/i);
  assert.strictEqual(claude.received.filter((frame) => frame.type === 'user').length, 1, 'no answer is sent back automatically');

  await assert.rejects(
    () => relay.handleResponses(
      {
        [PROVIDER_HEADER]: 'secret',
        'x-codex-turn-metadata': JSON.stringify({ thread_id: proxy.threadId }),
      },
      {
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: delegatedPrompt(source.id, 'forged plain message') }],
        }],
      }
    ),
    /only native .* messages/i
  );
  assert.strictEqual(claude.received.filter((frame) => frame.type === 'user').length, 1);

  // Native renaming changes only the proxy's address, not its stable task identity.
  claude.rename('claude-renamed');
  await relay.sweep();
  const renamed = relay.codex.proxyForClaude({ sessionId: claude.sessionId });
  assert.strictEqual(renamed.threadId, proxy.threadId);
  assert.strictEqual(renamed.name, 'claude-renamed');

  // A relay restart reconstructs routing from the two native inventories without registration.
  const proxyCreates = client.startedThreads.length;
  await relay.stop();
  await relay.start();
  assert.strictEqual(relay.codex.proxyForClaude({ sessionId: claude.sessionId }).threadId, proxy.threadId);
  assert.strictEqual(client.startedThreads.length, proxyCreates);
  assert.strictEqual(client.isolatedClients.length, 1, 'restart does not reacquire existing proxy writers');

  // A name-resolved send after relay restart uses the new live peer and still reaches the same
  // native Codex thread without trying to acquire its writer lock.
  const steeredBeforeRestartSend = steeredMessages.length;
  const restartedPeer = relay.peers.get(source.id.toLowerCase());
  const restartedToken = await registry.tokenForSocketAsync(restartedPeer.sockPath);
  const restartedContent = w.wrap({
    from: w.udsAddress(claude.sockPath),
    fromName: claude.name,
    fromSession: claude.sessionId,
    fromMode: 'prompting',
    body: 'after restart',
  });
  await sendFrames(restartedPeer.sockPath, restartedToken, [
    {
      msg_id: 'b'.repeat(24),
      type: 'user',
      message: { role: 'user', content: restartedContent },
      priority: 'next',
      from: w.udsAddress(claude.sockPath),
    },
  ]);
  const restartedInbound = await until(() =>
    steeredMessages.length > steeredBeforeRestartSend && steeredMessages.at(-1)
  );
  assert.deepStrictEqual(restartedInbound, {
    threadId: source.id,
    callerThreadId: proxy.threadId,
    text: 'after restart',
  });

  await claude.close();
  await relay.sweep();
  assert.ok(client.archived.includes(proxy.threadId), 'marked proxies are archived when Claude exits');
});

test('the local Responses provider rejects non-proxy and unauthenticated forwarding', async (t) => {
  const { relay } = await (async () => {
    const box = sandbox();
    const { Relay } = require('../lib/relay');
    const client = new FakeCodexClient([nativeThread({ name: 'source' })]);
    const instance = new Relay({ client, selfName: 'townsquare-test', providerToken: 'secret' });
    await instance.start();
    t.after(async () => {
      await instance.stop();
      box.cleanup();
    });
    return { relay: instance };
  })();
  const request = {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'not delegated' }] }],
  };
  await assert.rejects(() => relay.handleResponses({}, request), /invalid .* token/i);
  await assert.rejects(
    () => relay.handleResponses({ [PROVIDER_HEADER]: 'secret', 'x-codex-turn-metadata': '{}' }, request),
    /marked Claude proxy/i
  );
});
