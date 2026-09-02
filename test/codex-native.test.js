'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { sandbox } = require('./helpers');
const { FakeCodexClient, nativeThread } = require('./fake-codex');
const { delegatedPrompt, parseDelegation } = require('../lib/codex-delegation');
const { latestDelegation } = require('../lib/codex-provider');

async function boot(t, threads = [nativeThread()]) {
  const box = sandbox();
  const { Relay } = require('../lib/relay');
  const client = new FakeCodexClient(threads);
  const relay = new Relay({ client, selfName: 'townsquare-test' });
  await relay.start();
  t.after(async () => {
    await relay.stop();
    box.cleanup();
  });
  return { client, relay };
}

test('all native Codex titles are bare, case-insensitive names backed by stable thread IDs', async (t) => {
  const thread = nativeThread({ name: 'Generated task title' });
  const { client, relay } = await boot(t, [thread]);

  assert.strictEqual(relay.codex.get('generated TASK title')?.threadId, thread.id);
  const peer = relay.peers.get(thread.id.toLowerCase());
  assert.ok(peer, 'the real Codex task is exposed to Claude without registration');
  assert.strictEqual(peer.name, 'Generated task title');

  client.threads[0].name = 'renamed';
  await relay.sweep();
  assert.strictEqual(relay.codex.get('renamed')?.threadId, thread.id);
  assert.strictEqual(relay.peers.get(thread.id.toLowerCase()), peer, 'rename preserves stable identity');
  assert.strictEqual(peer.name, 'renamed', 'Claude-visible address follows the native title');

  client.threads[0].archived = true;
  await relay.sweep();
  assert.strictEqual(relay.codex.get('renamed'), undefined);
  assert.strictEqual(relay.peers.get(thread.id.toLowerCase()), undefined);
});

test('Codex-to-Codex delivery retains Codex 0.151 owner-aware queue ingress', async (t) => {
  const source = nativeThread({ name: 'source' });
  const target = nativeThread({ id: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b10', name: 'target' });
  const { client, relay } = await boot(t, [source, target]);

  const result = await relay.send({ fromThread: source.id, to: 'TARGET', text: 'Use <native> & safe.' });
  assert.strictEqual(result.delivery, 'queued');
  const queued = client.queuedMessages.at(-1);
  assert.strictEqual(queued.threadId, target.id);
  assert.match(queued.clientUserMessageId, /^townsquare:/);
  assert.strictEqual(queued.text, delegatedPrompt(source.id, 'Use <native> & safe.'));
  assert.deepStrictEqual(parseDelegation(queued.text), {
    sourceThreadId: source.id,
    input: 'Use <native> & safe.',
  });
  assert.doesNotMatch(queued.text, /townsquare-message|delivery=|reply/i);
  assert.strictEqual(client.startedTurns.length, 0, 'real tasks are never resumed or started by the bridge');
  assert.strictEqual(relay.history().find((entry) => entry.id === result.id)?.status, 'queued');

  await relay.sweep();
  assert.strictEqual(
    relay.history().find((entry) => entry.id === result.id)?.status,
    'queued',
    'the inspector remains queued while Codex still holds the native submission'
  );
  client.consumeQueuedMessage(queued.id);
  await relay.sweep();
  assert.strictEqual(
    relay.history().find((entry) => entry.id === result.id)?.status,
    'delivered',
    'the inspector advances when Codex consumes the native submission'
  );
});

test('Claude proxy cleanup releases a Desktop writer and archives automatically', async (t) => {
  const box = sandbox();
  const { Relay } = require('../lib/relay');
  const lockedId = '01a02e5d-ffc7-7ea2-8f01-40d17cad8b21';
  const userOwnedId = '01a02e5d-ffc7-7ea2-8f01-40d17cad8b23';
  const sessionId = 'closed-claude-session';
  const client = new FakeCodexClient([
    nativeThread({
      id: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b20',
      name: 'archive-caller',
    }),
    nativeThread({
      id: lockedId,
      name: 'plygo-b6',
      createdAt: 1_700_000_002,
      modelProvider: 'llmtownsquare_bridge',
      threadSource: `townsquare_claude_proxy:${sessionId}`,
    }),
    nativeThread({
      id: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b22',
      name: 'plygo-b6',
      createdAt: 1_700_000_001,
      modelProvider: 'llmtownsquare_bridge',
      threadSource: `townsquare_claude_proxy:${sessionId}`,
    }),
    nativeThread({
      id: userOwnedId,
      name: 'user-owned-prefix-match',
      modelProvider: 'openai',
      threadSource: 'townsquare_claude_proxy:not-owned-by-town-square',
    }),
  ]);
  const archiveThread = client.archiveThread.bind(client);
  let writerActive = true;
  let lockedArchiveAttempts = 0;
  client.archiveThread = async (threadId) => {
    if (threadId === lockedId && writerActive) {
      lockedArchiveAttempts += 1;
      throw new Error(`Codex app-server thread/archive failed: thread ${threadId} already has an active writer`);
    }
    return archiveThread(threadId);
  };

  const helperArchives = [];
  const archiveHelper = {
    async archiveThread(threadId, callerThreadId) {
      helperArchives.push({ threadId, callerThreadId });
      writerActive = false;
      return archiveThread(threadId);
    },
  };

  const relay = new Relay({ client, archiveHelper, selfName: 'townsquare-test' });
  await relay.start();
  t.after(async () => {
    await relay.stop();
    box.cleanup();
  });

  assert.deepStrictEqual(relay.codex.proxies(), []);
  assert.deepStrictEqual(helperArchives, [{
    threadId: lockedId,
    callerThreadId: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b20',
  }]);
  assert.ok(lockedArchiveAttempts >= 1);
  assert.ok(client.archived.includes(lockedId));
  assert.strictEqual(relay.codex.getRealByThread(userOwnedId)?.name, 'user-owned-prefix-match');
  assert.strictEqual(client.archived.includes(userOwnedId), false);
  assert.strictEqual(
    relay.history().some((entry) => /could not archive .*Claude proxy/i.test(entry.text || '')),
    false,
    'a recovered writer race must not become a Town Square failure'
  );
});

test('archive helper client sends one authenticated owner-side request', async () => {
  const { CodexArchiveHelperClient } = require('../lib/codex-archive-helper-client');
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.messages = [];
  socket.setEncoding = () => {};
  socket.write = (raw) => {
    const message = JSON.parse(raw.trim());
    socket.messages.push(message);
    setImmediate(() => socket.emit('data', `${JSON.stringify({
      id: message.id,
      result: { archived: true, threadId: message.threadId },
    })}\n`));
    return true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };

  const helper = new CodexArchiveHelperClient({
    socketPath: '/tmp/fake-codex-archive-helper.sock',
    token: 'helper-secret',
    connectSocket: () => {
      setImmediate(() => socket.emit('connect'));
      return socket;
    },
  });
  await helper.archiveThread('proxy-thread-id', 'caller-thread-id');
  assert.strictEqual(socket.messages.at(-1).token, 'helper-secret');
  assert.strictEqual(socket.messages.at(-1).action, 'archive');
  assert.strictEqual(socket.messages.at(-1).threadId, 'proxy-thread-id');
  assert.strictEqual(socket.messages.at(-1).callerThreadId, 'caller-thread-id');
});

test('steering helper client sends one authenticated owner-side message request', async () => {
  const { CodexSteeringHelperClient } = require('../lib/codex-steering-helper-client');
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.messages = [];
  socket.setEncoding = () => {};
  socket.write = (raw) => {
    const message = JSON.parse(raw.trim());
    socket.messages.push(message);
    setImmediate(() => socket.emit('data', `${JSON.stringify({
      id: message.id,
      result: { delivered: true, threadId: message.targetThreadId },
    })}\n`));
    return true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };

  const helper = new CodexSteeringHelperClient({
    socketPath: '/tmp/fake-codex-steering-helper.sock',
    token: 'helper-secret',
    connectSocket: () => {
      setImmediate(() => socket.emit('connect'));
      return socket;
    },
  });
  await helper.sendMessage('target-thread-id', 'claude-proxy-thread-id', 'steer me');
  assert.strictEqual(socket.messages.at(-1).token, 'helper-secret');
  assert.strictEqual(socket.messages.at(-1).action, 'send_message');
  assert.strictEqual(socket.messages.at(-1).targetThreadId, 'target-thread-id');
  assert.strictEqual(socket.messages.at(-1).threadId, undefined);
  assert.strictEqual(socket.messages.at(-1).callerThreadId, 'claude-proxy-thread-id');
  assert.strictEqual(socket.messages.at(-1).text, 'steer me');
});

test('Claude priority delivery falls back to the durable queue only when no helper submission occurred', async () => {
  const { CodexSessions } = require('../lib/codex-session');
  const target = nativeThread({ name: 'target' });
  const client = new FakeCodexClient([target]);
  const unavailable = new Error('helper socket is not available');
  unavailable.deliveryStage = 'not-sent';
  const codex = new CodexSessions({
    client,
    steeringHelper: { sendMessage: async () => { throw unavailable; } },
  });
  await codex.start();
  const result = await codex.deliver(codex.get('target'), {
    text: 'keep this message',
    sourceThreadId: 'claude-proxy-thread-id',
    steer: true,
  });
  assert.strictEqual(result.delivery, 'queued');
  assert.deepStrictEqual(parseDelegation(client.queuedMessages.at(-1).text), {
    sourceThreadId: 'claude-proxy-thread-id',
    input: 'keep this message',
  });
  await codex.stop();
});

test('an uncertain steering outcome is never duplicated into the durable queue', async () => {
  const { CodexSessions } = require('../lib/codex-session');
  const target = nativeThread({ name: 'target' });
  const client = new FakeCodexClient([target]);
  const uncertain = new Error('helper response was lost');
  uncertain.deliveryStage = 'outcome-unknown';
  const codex = new CodexSessions({
    client,
    steeringHelper: { sendMessage: async () => { throw uncertain; } },
  });
  await codex.start();
  await assert.rejects(() => codex.deliver(codex.get('target'), {
    text: 'send exactly once',
    sourceThreadId: 'claude-proxy-thread-id',
    steer: true,
  }), /response was lost/);
  assert.strictEqual(client.queuedMessages.length, 0);
  await codex.stop();
});

test('provider selects the current delegation without replaying older turns', () => {
  const message = (text) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
  const nativeMessage = (text, namespace = 'codex_app') => ({
    type: 'function_call_output',
    name: 'send_message_to_thread',
    namespace,
    output: text,
  });
  const old = delegatedPrompt('old-source', 'old message');
  const current = delegatedPrompt('current-source', 'current message');
  const runtime = '<environment_context>runtime details</environment_context>';

  assert.deepStrictEqual(latestDelegation({ input: [message('bootstrap'), nativeMessage(current), message(runtime)] }), {
    sourceThreadId: 'current-source',
    input: 'current message',
  });
  assert.strictEqual(
    latestDelegation({ input: [nativeMessage(old), message('plain direct follow-up'), message(runtime)] }),
    undefined,
    'a non-delegated current turn must not replay an older delegation'
  );
  assert.strictEqual(
    latestDelegation({ input: [message(current)] }),
    undefined,
    'delegation markup in a plain user message is not native task transport'
  );
  assert.strictEqual(latestDelegation({ input: [nativeMessage(current, 'untrusted')] }), undefined);
  assert.strictEqual(
    latestDelegation({
      input: [{ ...nativeMessage(current), name: 'some_other_tool' }],
    }),
    undefined
  );
});

test('duplicate names are unroutable, receive one notice, and recover after a rename', async (t) => {
  const first = nativeThread({ name: 'test' });
  const second = nativeThread({ id: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b11', name: 'TEST' });
  const { client, relay } = await boot(t, [first, second]);

  assert.strictEqual(relay.findAgent('test'), undefined);
  await assert.rejects(
    () => relay.send({ fromThread: first.id, to: 'test', text: 'blocked' }),
    /ambiguous recipient/i
  );
  const notices = client.queuedMessages.filter((message) => /Please rename this session/.test(message.text));
  assert.strictEqual(notices.length, 2, 'each conflicting native task gets one notice');
  await relay.sweep();
  assert.strictEqual(
    client.queuedMessages.filter((message) => /Please rename this session/.test(message.text)).length,
    2,
    'the same conflict is not announced twice'
  );

  client.threads.find((thread) => thread.id === second.id).name = 'other';
  await relay.sweep();
  assert.strictEqual(relay.findAgent('test')?.session.threadId, first.id);
  assert.strictEqual(relay.findAgent('OTHER')?.session.threadId, second.id);
  const sent = await relay.send({ fromThread: first.id, to: 'other', text: 'recovered' });
  assert.strictEqual(sent.delivery, 'queued');
});

function fakeAppServer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0, null);
  const requests = [];
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      requests.push(message);
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
      let result = {};
      if (message.method === 'initialize') result = { userAgent: 'codex/0.151.0' };
      if (message.method === 'thread/list') {
        result = message.params.modelProviders
          ? {
              data: [
                nativeThread({
                  id: '01a02e5d-ffc7-7ea2-8f01-40d17cad8b12',
                  name: 'claude-proxy',
                  modelProvider: 'llmtownsquare_bridge',
                  threadSource: null,
                }),
              ],
              nextCursor: null,
            }
          : { data: [nativeThread()], nextCursor: null };
      }
      if (message.method === 'thread/read') {
        result = {
          thread: nativeThread({
            id: message.params.threadId,
            name: 'claude-proxy',
            modelProvider: 'llmtownsquare_bridge',
            threadSource: 'townsquare_claude_proxy:session-1',
          }),
        };
      }
      if (message.method === 'thread/start') result = { thread: nativeThread({ id: 'proxy-id', name: '' }) };
      if (message.method === 'turn/start') result = { turn: { id: 'turn-id', status: 'completed' } };
      if (message.method === 'thread/queue/add') result = { queuedSubmission: { id: 'queued-id' } };
      if (message.method === 'thread/queue/list') {
        result = {
          data: [{ id: 'queued-id', input: [], clientUserMessageId: 'client-message-id' }],
          nextCursor: null,
        };
      }
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  return { child, requests };
}

test('app-server client speaks the Codex 0.151 native JSON-RPC methods', async () => {
  const { CodexAppServerClient } = require('../lib/codex-app-server');
  const fake = fakeAppServer();
  const client = new CodexAppServerClient({ spawnProcess: () => fake.child });
  await client.connect();
  await client.configureProvider({ base_url: 'http://127.0.0.1:7777/v1', wire_api: 'responses' });
  const threads = await client.listThreads();
  assert.strictEqual(threads.find((thread) => thread.name === 'claude-proxy').threadSource, 'townsquare_claude_proxy:session-1');
  await client.queueMessage(threads[0].id, 'hello', 'client-message-id');
  const queue = await client.listQueuedSubmissions(threads[0].id);
  assert.deepStrictEqual(queue.map((submission) => submission.id), ['queued-id']);
  await client.startThread({ threadSource: 'townsquare_claude_proxy:session-1' });
  await client.setThreadName(threads[0].id, 'new-name');
  await client.startTurn(threads[0].id, 'bootstrap');
  await client.archiveThread(threads[0].id);
  await client.deleteThread(threads[0].id);

  assert.strictEqual(fake.requests[0].method, 'initialize');
  assert.strictEqual(fake.requests[0].params.capabilities.experimentalApi, true);
  assert.ok(fake.requests.some((request) => request.method === 'initialized'));
  const configure = fake.requests.find((request) => request.method === 'config/batchWrite');
  assert.deepStrictEqual(
    configure.params.edits.map((edit) => edit.keyPath),
    [
      'model_providers.llmtownsquare_bridge',
      'mcp_servers.townsquare_archive_helper',
      'mcp_servers.townsquare_steering_helper',
    ]
  );
  assert.match(configure.params.edits[1].value.args[0], /codex-archive-helper-server\.js$/);
  assert.match(configure.params.edits[2].value.args[0], /codex-archive-helper-server\.js$/);
  assert.strictEqual(configure.params.edits[2].value.enabled, false);
  const list = fake.requests.find((request) => request.method === 'thread/list');
  assert.deepStrictEqual(
    { archived: list.params.archived, stateDb: list.params.useStateDbOnly, sort: list.params.sortKey },
    { archived: false, stateDb: true, sort: 'recency_at' }
  );
  assert.strictEqual(fake.requests.some((request) => request.method === 'thread/resume'), false);
  const queued = fake.requests.find((request) => request.method === 'thread/queue/add');
  assert.strictEqual(queued.params.threadId, threads[0].id);
  assert.strictEqual(queued.params.clientUserMessageId, 'client-message-id');
  assert.deepStrictEqual(queued.params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  const queueList = fake.requests.find((request) => request.method === 'thread/queue/list');
  assert.strictEqual(queueList.params.threadId, threads[0].id);
  assert.strictEqual(queueList.params.limit, 100);
  assert.ok(fake.requests.some((request) => request.method === 'thread/start'));
  assert.ok(fake.requests.some((request) => request.method === 'thread/name/set'));
  const turn = fake.requests.find((request) => request.method === 'turn/start');
  assert.deepStrictEqual(turn.params.input, [{ type: 'text', text: 'bootstrap', text_elements: [] }]);
  assert.ok(fake.requests.some((request) => request.method === 'thread/archive'));
  assert.ok(fake.requests.some((request) => request.method === 'thread/delete'));
  client.stop();
});

test('archive helper uses Codex Desktop signed Node on macOS', () => {
  const { archiveHelperCommand } = require('../lib/codex-app-server');
  const signedNode = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
  assert.strictEqual(archiveHelperCommand({
    env: {},
    platform: 'darwin',
    existsSync: (candidate) => candidate === signedNode,
  }), signedNode);
  assert.strictEqual(archiveHelperCommand({
    env: { TOWNSQUARE_ARCHIVE_HELPER_NODE: '/custom/signed-node' },
    platform: 'darwin',
    existsSync: (candidate) => candidate === '/custom/signed-node',
  }), '/custom/signed-node');
});
