'use strict';

const { EventEmitter } = require('events');

class FakeCodexClient extends EventEmitter {
  constructor(threads = []) {
    super();
    this.threads = threads.map((thread) => ({ ...thread }));
    this.turns = new Map();
    this.startedTurns = [];
    this.startedThreads = [];
    this.queuedMessages = [];
    this.consumedQueuedMessages = new Set();
    this.archived = [];
    this.isolatedClients = [];
    this.nextThread = 1;
    this.nextTurn = 1;
    this.nextQueuedMessage = 1;
  }

  async connect() {
  }

  stop() {}

  async configureProvider() {}

  createIsolatedClient() {
    const parent = this;
    const isolated = {
      connected: false,
      closed: false,
      async connect() {
        this.connected = true;
      },
      startThread: (...args) => parent.startThread(...args),
      setThreadName: (...args) => parent.setThreadName(...args),
      startTurn: (...args) => parent.startTurn(...args),
      waitForTurn: (...args) => parent.waitForTurn(...args),
      deleteThread: (...args) => parent.deleteThread(...args),
      async close() {
        this.closed = true;
      },
    };
    this.isolatedClients.push(isolated);
    return isolated;
  }

  async listThreads() {
    return this.threads.filter((thread) => !thread.archived).map((thread) => ({ ...thread }));
  }

  async startThread(params = {}) {
    const suffix = String(this.nextThread++).padStart(12, '0');
    const thread = nativeThread({
      id: `01a00000-0000-7000-8000-${suffix}`,
      name: '',
      cwd: params.cwd,
      threadSource: params.threadSource,
      model: params.model,
      modelProvider: params.modelProvider,
    });
    this.threads.unshift(thread);
    this.startedThreads.push({ params: { ...params }, thread });
    return { thread: { ...thread } };
  }

  async queueMessage(threadId, text, clientUserMessageId) {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`unknown fake thread ${threadId}`);
    const queued = {
      id: `queued-${this.nextQueuedMessage++}`,
      threadId,
      text,
      clientUserMessageId,
    };
    this.queuedMessages.push(queued);
    return { id: queued.id };
  }

  async listQueuedSubmissions(threadId) {
    return this.queuedMessages
      .filter((queued) => queued.threadId === threadId && !this.consumedQueuedMessages.has(queued.id))
      .map((queued) => ({
        id: queued.id,
        clientUserMessageId: queued.clientUserMessageId,
        input: [{ type: 'text', text: queued.text, text_elements: [] }],
      }));
  }

  consumeQueuedMessage(queuedSubmissionId) {
    this.consumedQueuedMessages.add(queuedSubmissionId);
  }

  async setThreadName(threadId, name) {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`unknown fake thread ${threadId}`);
    thread.name = name;
    return {};
  }

  async deleteThread(threadId) {
    this.threads = this.threads.filter((thread) => thread.id !== threadId);
    this.turns.delete(threadId);
    return {};
  }

  async archiveThread(threadId) {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`unknown fake thread ${threadId}`);
    thread.archived = true;
    this.archived.push(threadId);
    return {};
  }

  async startTurn(threadId, text) {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error(`unknown fake thread ${threadId}`);
    const turn = {
      id: `turn-${this.nextTurn++}`,
      status: 'completed',
      items: [{ type: 'userMessage', content: [{ type: 'text', text }] }],
    };
    const turns = this.turns.get(threadId) || [];
    turns.unshift(turn);
    this.turns.set(threadId, turns);
    this.startedTurns.push({ threadId, text, turn });
    return { turn: { ...turn } };
  }

  async waitForTurn(threadId, turnId) {
    const turn = (this.turns.get(threadId) || []).find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`unknown fake turn ${turnId}`);
    return { ...turn };
  }
}

function nativeThread({
  id = '01a02e5d-ffc7-7ea2-8f01-40d17cad8b0e',
  name = 'test',
  cwd = '/tmp/project',
  status = 'idle',
  createdAt = 1_700_000_000,
  modelProvider = 'openai',
  ...rest
} = {}) {
  return {
    id,
    name,
    cwd,
    status: { type: status, ...(status === 'active' && { activeFlags: [] }) },
    createdAt,
    updatedAt: createdAt,
    recencyAt: createdAt,
    ephemeral: false,
    modelProvider,
    ...rest,
  };
}

module.exports = { FakeCodexClient, nativeThread };
