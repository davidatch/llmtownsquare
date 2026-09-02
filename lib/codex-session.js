'use strict';

/** Native Codex task inventory plus durable Claude proxy task lifecycle. */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const { delegatedPrompt } = require('./codex-delegation');
const {
  BOOTSTRAP_PROMPT,
  PROVIDER_ID,
  PROVIDER_MODEL,
  proxySessionId,
  proxySource,
} = require('./codex-provider');

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function threadStatus(thread) {
  return thread?.status?.type || thread?.status || 'notLoaded';
}

function claudeIdentity(record) {
  return String(record?.sessionId || `pid-${record?.pid || 'unknown'}`);
}

function isActiveWriterConflict(error) {
  return /\balready has an active writer\b/i.test(String(error?.message || error || ''));
}

function proxyIdentity(thread) {
  if (thread?.modelProvider !== PROVIDER_ID) return undefined;
  return proxySessionId(thread.threadSource);
}

function sessionFromThread(thread, previous) {
  const claudeSessionId = proxyIdentity(thread);
  const oldName = previous?.name;
  const oldStatus = previous?.nativeStatus;
  const session = previous || {};
  Object.assign(session, {
    name: typeof thread.name === 'string' ? thread.name.trim() : '',
    threadId: thread.id,
    cwd: thread.cwd,
    createdAt: (thread.createdAt || Math.floor(Date.now() / 1000)) * 1000,
    nativeStatus: threadStatus(thread),
    busy: threadStatus(thread) === 'active',
    proxy: Boolean(claudeSessionId),
    claudeSessionId,
  });
  return { session, changed: !previous || oldName !== session.name || oldStatus !== session.nativeStatus };
}

class CodexSessions extends EventEmitter {
  constructor({ client, provider, archiveHelper, steeringHelper } = {}) {
    super();
    if (!client) throw new Error('CodexSessions requires a Codex app-server client');
    this.client = client;
    this.provider = provider;
    this.archiveHelper = archiveHelper;
    this.steeringHelper = steeringHelper;
    this.byThread = new Map();
    this.byName = new Map();
    this.threads = [];
    this.lastRefreshAt = undefined;
    this.lastError = undefined;
    this.proxyArchiveWarnings = new Map();
    this.client.on?.('warning', (message) => this.emit('warning', message));
  }

  async start() {
    await this.client.connect();
    if (this.provider && this.client.configureProvider) await this.client.configureProvider(this.provider);
    await this.refresh();
  }

  async stop() {
    this.byName.clear();
    this.byThread.clear();
    this.proxyArchiveWarnings.clear();
    this.client.stop?.();
  }

  /** Every real, named Codex task. Duplicate names remain visible but are not name-addressable. */
  list() {
    return [...this.byThread.values()].filter((session) => !session.proxy && session.name);
  }

  proxies() {
    return [...this.byThread.values()].filter((session) => session.proxy);
  }

  get(name) {
    return this.byName.get(nameKey(name));
  }

  getRealByThread(threadId) {
    const session = this.byThread.get(String(threadId || '').toLowerCase());
    return session && !session.proxy ? session : undefined;
  }

  getProxyByThread(threadId) {
    const session = this.byThread.get(String(threadId || '').toLowerCase());
    return session?.proxy ? session : undefined;
  }

  getByThread(threadId) {
    return this.byThread.get(String(threadId || '').toLowerCase());
  }

  proxyForClaude(record) {
    const id = claudeIdentity(record);
    return this.proxies().find((proxy) => proxy.claudeSessionId === id);
  }

  liveConversations() {
    return this.threads.map((thread) => {
      const session = this.getByThread(thread.id);
      return {
        id: thread.id,
        threadId: thread.id,
        name: thread.name,
        cwd: thread.cwd,
        status: threadStatus(thread),
        addressable: Boolean(session && !session.proxy && session.name && this.get(session.name) === session),
        proxy: Boolean(session?.proxy),
        claudeSessionId: session?.claudeSessionId,
        lastActive: (thread.recencyAt || thread.updatedAt || thread.createdAt) * 1000,
        parentThreadId: thread.parentThreadId || null,
      };
    });
  }

  async refresh() {
    let threads;
    try {
      threads = await this.client.listThreads();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
    this.threads = threads;
    this.lastRefreshAt = Date.now();

    const next = new Map();
    let changed = false;
    for (const thread of threads) {
      if (thread.ephemeral || !thread.id) continue;
      const isProxy = Boolean(proxyIdentity(thread));
      if (!isProxy && (typeof thread.name !== 'string' || !thread.name.trim())) continue;
      const key = String(thread.id).toLowerCase();
      const materialized = sessionFromThread(thread, this.byThread.get(key));
      next.set(key, materialized.session);
      changed = changed || materialized.changed;
    }
    changed = changed || next.size !== this.byThread.size;
    this.byThread = next;

    const grouped = new Map();
    for (const session of this.list()) {
      const key = nameKey(session.name);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(session);
    }
    this.byName = new Map(
      [...grouped].filter(([, sessions]) => sessions.length === 1).map(([key, sessions]) => [key, sessions[0]])
    );
    if (changed) this.emit('changed');
    return this.list();
  }

  /**
   * Claude-originated messages use Desktop's owner-side follow-up path, which steers an active
   * turn and starts a normal turn when idle. Other native task messages retain durable queuing.
   */
  async deliver(session, { text, sourceThreadId, steer = false }) {
    if (!session || session.proxy || this.getRealByThread(session.threadId) !== session) {
      const err = new Error('native Codex task is no longer available');
      err.status = 404;
      throw err;
    }
    if (steer && this.steeringHelper?.sendMessage) {
      try {
        await this.steeringHelper.sendMessage(session.threadId, sourceThreadId, text);
        this.emit('changed');
        return { delivery: 'steered' };
      } catch (error) {
        // A helper that has not started cannot have submitted the message. Preserve the existing
        // durable queue path on CLI-only hosts and during Desktop configuration reloads.
        if (!['not-sent', 'rejected'].includes(error?.deliveryStage)) throw error;
      }
    }
    const clientUserMessageId = `townsquare:${crypto.randomUUID()}`;
    const queued = await this.client.queueMessage(
      session.threadId,
      delegatedPrompt(sourceThreadId, text),
      clientUserMessageId
    );
    this.emit('changed');
    return {
      delivery: 'queued',
      queuedSubmissionId: queued?.id,
      clientUserMessageId,
    };
  }

  async sendConflictNotice(session, text) {
    if (!session || session.proxy) return false;
    await this.client.queueMessage(
      session.threadId,
      text,
      `townsquare-conflict:${crypto.randomUUID()}`
    );
    return true;
  }

  /** Keep exactly one marked proxy for every supplied Claude session. */
  async reconcileClaudeProxies(records) {
    const desired = new Map();
    for (const record of records) {
      const name = String(record?.name || '').trim();
      if (!name) continue;
      desired.set(claudeIdentity(record), { record, name });
    }

    const existing = new Map();
    for (const proxy of this.proxies()) {
      if (!existing.has(proxy.claudeSessionId)) existing.set(proxy.claudeSessionId, []);
      existing.get(proxy.claudeSessionId).push(proxy);
    }

    for (const [sessionId, proxies] of existing) {
      proxies.sort((left, right) => right.createdAt - left.createdAt);
      const wanted = desired.get(sessionId);
      const keep = wanted ? proxies.shift() : undefined;
      for (const stale of proxies) {
        await this._archiveProxy(stale, wanted ? 'duplicate' : 'stale');
      }
      if (!wanted) continue;
      if (keep && keep.name !== wanted.name) {
        try {
          await this.client.setThreadName(keep.threadId, wanted.name);
        } catch (err) {
          this.emit('warning', `could not rename Claude proxy ${keep.name}: ${err.message}`);
        }
      }
      desired.delete(sessionId);
    }

    await this.refresh();
    for (const [, wanted] of desired) {
      try {
        await this._createProxy(wanted.record, wanted.name);
      } catch (err) {
        this.emit('warning', `could not create Claude proxy ${wanted.name}: ${err.message}`);
      }
    }
    await this.refresh();
    this._pruneProxyArchiveState();
    return this.proxies();
  }

  /**
   * A Desktop window can retain a proxy's rollout writer after its Claude session exits. Tell the
   * Desktop owner to evict that proxy, then persist the archive through official app-server RPC.
   */
  async _archiveProxy(proxy, reason) {
    const threadId = String(proxy.threadId).toLowerCase();
    try {
      await this.client.archiveThread(proxy.threadId);
      this.proxyArchiveWarnings.delete(threadId);
      return true;
    } catch (err) {
      if (isActiveWriterConflict(err) && this.archiveHelper?.archiveThread) {
        const caller = this.list().find((session) => session.threadId !== proxy.threadId);
        try {
          await this.archiveHelper.archiveThread(proxy.threadId, caller?.threadId);
          this.proxyArchiveWarnings.delete(threadId);
          return true;
        } catch {}
      }
      if (isActiveWriterConflict(err)) {
        this.proxyArchiveWarnings.delete(threadId);
        return false;
      }
      const warning = `could not archive ${reason} Claude proxy ${proxy.name}: ${err.message}`;
      if (this.proxyArchiveWarnings.get(threadId) !== warning) this.emit('warning', warning);
      this.proxyArchiveWarnings.set(threadId, warning);
      return false;
    }
  }

  _pruneProxyArchiveState() {
    const live = new Set(this.proxies().map((proxy) => proxy.threadId.toLowerCase()));
    for (const threadId of this.proxyArchiveWarnings.keys()) {
      if (!live.has(threadId)) this.proxyArchiveWarnings.delete(threadId);
    }
  }

  async _createProxy(record, name) {
    if (typeof this.client.createIsolatedClient !== 'function') {
      throw new Error('Codex client cannot create an isolated proxy owner');
    }
    const owner = this.client.createIsolatedClient();
    let threadId;
    try {
      await owner.connect();
      const started = await owner.startThread({
        cwd: record.cwd || process.cwd(),
        ephemeral: false,
        model: PROVIDER_MODEL,
        modelProvider: PROVIDER_ID,
        threadSource: proxySource(claudeIdentity(record)),
      });
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('thread/start returned no thread id');
      await owner.setThreadName(threadId, name);
      const turn = await owner.startTurn(threadId, BOOTSTRAP_PROMPT);
      const turnId = turn?.turn?.id;
      if (!turnId) throw new Error('proxy bootstrap returned no turn id');
      const completed = await owner.waitForTurn(threadId, turnId);
      if (completed.status !== 'completed') {
        throw new Error(completed.error?.message || `proxy bootstrap ${completed.status}`);
      }
      return threadId;
    } catch (err) {
      if (threadId) await owner.deleteThread(threadId).catch(() => {});
      throw err;
    } finally {
      await owner.close();
    }
  }
}

module.exports = { CodexSessions, nameKey, claudeIdentity };
