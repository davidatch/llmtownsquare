'use strict';
/**
 * Native name-based routing between Claude sessions and Codex tasks.
 *
 * Names are presentation addresses only. Every route is resolved to a stable Claude session ID
 * or Codex thread ID before delivery. Claude proxies are real, marked Codex tasks backed by a
 * local Responses provider; they are never exposed as a second logical agent.
 */

const { EventEmitter } = require('events');

const registry = require('./claude-registry');
const { VirtualPeer, gcStaleRecords } = require('./virtual-peer');
const { sendFrames, newMsgId } = require('./uds');
const w = require('./wrapper');
const {
  BOOTSTRAP_PROMPT,
  PROVIDER_HEADER,
  completedResponseSse,
  latestDelegation,
  latestUserText,
  safeTokenEqual,
  turnMetadata,
} = require('./codex-provider');
const { CodexSessions, claudeIdentity, nameKey } = require('./codex-session');

const LOG_CAP = 1000;
const SWEEP_MS = Number(process.env.TOWNSQUARE_SWEEP_MS || 5000);

class Relay extends EventEmitter {
  constructor({
    client,
    selfName = process.env.TOWNSQUARE_NAME || 'townsquare',
    fromMode,
    provider,
    providerToken,
    archiveHelper,
    steeringHelper,
  } = {}) {
    super();
    this.client = client;
    this.selfName = selfName;
    this.fromMode = fromMode || process.env.TOWNSQUARE_FROM_MODE || 'prompting';
    this.providerToken = providerToken;
    this.codex = new CodexSessions({ client, provider, archiveHelper, steeringHelper });
    this.codex.on('changed', () => this.emit('agents'));
    this.codex.on('warning', (text) => this.record({ kind: 'system', text, status: 'failed' }));

    this.peers = new Map(); // stable Codex thread ID -> Claude-visible virtual peer
    this._claudeSessions = [];
    this.addresses = new Map();
    this.conflicts = new Map();
    this._notifiedConflicts = new Set();
    this._loggedConflicts = new Set();
    this.pendingCodexDeliveries = new Map();
    this.log = [];
    this.seq = 0;
    this.sockDir = registry.defaultSockDir();
    this._claudeRefreshing = undefined;
    this._sweeping = undefined;
    this._lifecycle = Promise.resolve();
    this.stopping = false;
    this.ready = false;
  }

  async start() {
    this.stopping = false;
    await this.codex.start();
    await this.refreshClaudeSessions();
    const staleRemoved = await gcStaleRecords({
      sockDirs: [this.sockDir, registry.defaultSockDir()],
    });
    this.self = new VirtualPeer({
      name: this.selfName,
      cwd: process.cwd(),
      meta: { agent: 'townsquare', role: 'relay' },
      onFrame: (frame) => this.onInboundFrame(undefined, frame),
    });
    await this.self.start({ pid: process.pid, sockDir: this.sockDir });
    await this._reconcile();
    this.sweepTimer = setInterval(() => this.sweep().catch(() => {}), SWEEP_MS);
    this.sweepTimer.unref?.();
    this.ready = true;
    return { staleRemoved };
  }

  async stop() {
    this.ready = false;
    this.stopping = true;
    clearInterval(this.sweepTimer);
    if (this._sweeping) await this._sweeping.catch(() => {});
    await this._lifecycle.catch(() => {});
    for (const peer of this.peers.values()) await peer.close().catch(() => {});
    this.peers.clear();
    this.pendingCodexDeliveries.clear();
    if (this.self) await this.self.close().catch(() => {});
    await this.codex.stop();
  }

  // ---------------------------------------------------------------- identities

  claudeSessions() {
    return this._claudeSessions;
  }

  async refreshClaudeSessions() {
    if (this._claudeRefreshing) return this._claudeRefreshing;
    const pending = (async () => {
      this._claudeSessions = (await registry.listSessionsAsync())
        .filter((record) => !record.townsquare)
        .filter((record) => String(record.name || '').trim());
      this.sockDir = registry.sockDirFromRecords(this._claudeSessions);
      return this._claudeSessions;
    })().finally(() => {
      if (this._claudeRefreshing === pending) this._claudeRefreshing = undefined;
    });
    this._claudeRefreshing = pending;
    return pending;
  }

  _members() {
    const members = [];
    for (const session of this._claudeSessions) {
      members.push({ type: 'claude', id: claudeIdentity(session), name: session.name, session });
    }
    for (const session of this.codex.list()) {
      members.push({ type: 'codex', id: session.threadId, name: session.name, session });
    }
    if (this.self) members.push({ type: 'self', id: 'relay', name: this.selfName, peer: this.self });
    return members;
  }

  _rebuildNameIndex() {
    const groups = new Map();
    for (const member of this._members()) {
      const key = nameKey(member.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(member);
    }
    this.addresses = new Map();
    this.conflicts = new Map();
    for (const [key, members] of groups) {
      if (members.length === 1) this.addresses.set(key, members[0]);
      else this.conflicts.set(key, members);
    }
  }

  listAgents() {
    const out = this._members().map((member) => {
      const common = { name: member.name, kind: member.type, conflict: this.conflicts.has(nameKey(member.name)) };
      if (member.type === 'claude') {
        return {
          ...common,
          status: member.session.status || 'unknown',
          cwd: member.session.cwd,
          pid: member.session.pid,
          sessionId: claudeIdentity(member.session),
          startedAt: member.session.startedAt,
        };
      }
      if (member.type === 'codex') {
        const peer = this.peers.get(member.session.threadId.toLowerCase());
        return {
          ...common,
          status: member.session.busy ? 'active' : 'idle',
          cwd: member.session.cwd,
          threadId: member.session.threadId,
          startedAt: member.session.createdAt,
          peerPid: peer?.pid,
        };
      }
      return {
        ...common,
        kind: 'townsquare',
        status: 'idle',
        cwd: this.self.cwd,
        pid: this.self.pid,
        startedAt: this.self.startedAt,
      };
    });
    return out.sort((left, right) => left.name.localeCompare(right.name));
  }

  knownNames() {
    return this.listAgents().map((agent) => agent.name);
  }

  findAgent(name) {
    return this.addresses.get(nameKey(name));
  }

  _memberForCodexThread(threadId) {
    const session = this.codex.getRealByThread(threadId);
    return session && { type: 'codex', id: session.threadId, name: session.name, session };
  }

  // ------------------------------------------------------------- reconciliation

  async _reconcile() {
    await this.codex.refresh();
    await this.refreshClaudeSessions();
    this._rebuildNameIndex();

    // Proxies mirror every live Claude identity, including temporarily ambiguous names. They are
    // representations of those sessions, not additional members of the shared namespace.
    await this.codex.reconcileClaudeProxies(this._claudeSessions);
    await this.codex.refresh();
    this._rebuildNameIndex();
    await this._syncCodexPeers();
    await this._notifyConflicts();
    await this._refreshCodexDeliveryStatuses();
    this.emit('agents');
  }

  _trackCodexDelivery(entry, session, result) {
    this.updateStatus(entry.id, result.delivery);
    if (result.delivery !== 'queued' || !result.queuedSubmissionId) return;
    const threadId = String(session.threadId).toLowerCase();
    const key = `${threadId}:${result.queuedSubmissionId}`;
    this.pendingCodexDeliveries.set(key, {
      entryId: entry.id,
      threadId,
      queuedSubmissionId: result.queuedSubmissionId,
    });
  }

  async _refreshCodexDeliveryStatuses() {
    if (!this.pendingCodexDeliveries.size) return;
    const byThread = new Map();
    for (const [key, pending] of this.pendingCodexDeliveries) {
      if (!byThread.has(pending.threadId)) byThread.set(pending.threadId, []);
      byThread.get(pending.threadId).push({ key, ...pending });
    }

    for (const [threadId, pending] of byThread) {
      if (!this.codex.getRealByThread(threadId)) {
        for (const delivery of pending) {
          this.updateStatus(delivery.entryId, 'failed', 'native Codex task is no longer available');
          this.pendingCodexDeliveries.delete(delivery.key);
        }
        continue;
      }

      let queued;
      try {
        queued = await this.client.listQueuedSubmissions(threadId);
      } catch {
        // Inventory and queue access can briefly race an app-server reconnect. Keep the durable
        // submission pending and retry on the next sweep instead of reporting a false failure.
        continue;
      }
      const queuedIds = new Set(queued.map((submission) => submission.id));
      for (const delivery of pending) {
        if (queuedIds.has(delivery.queuedSubmissionId)) continue;
        this.updateStatus(delivery.entryId, 'delivered');
        this.pendingCodexDeliveries.delete(delivery.key);
      }
    }
  }

  async _syncCodexPeers() {
    return this._serializeLifecycle(async () => {
      const desired = new Map();
      for (const session of this.codex.list()) {
        if (!this.conflicts.has(nameKey(session.name))) desired.set(session.threadId.toLowerCase(), session);
      }

      for (const [threadId, peer] of [...this.peers]) {
        if (desired.has(threadId)) continue;
        this.peers.delete(threadId);
        await peer.close().catch((err) =>
          this.record({ kind: 'system', text: `could not close native peer ${peer.name}: ${err.message}`, status: 'failed' })
        );
      }

      for (const [threadId, session] of desired) {
        const existing = this.peers.get(threadId);
        if (existing) {
          if (existing.name !== session.name) existing.rename(session.name);
          continue;
        }
        const peer = new VirtualPeer({
          name: session.name,
          cwd: session.cwd,
          sessionId: `codex-${session.threadId.replace(/-/g, '').slice(0, 48)}`,
          meta: { agent: 'codex', threadId: session.threadId },
          onFrame: (frame) => this.onInboundFrame(session.threadId, frame),
        });
        try {
          await peer.start({ sockDir: this.sockDir });
          if (this.stopping || !this.codex.getRealByThread(session.threadId)) {
            await peer.close().catch(() => {});
            continue;
          }
          this.peers.set(threadId, peer);
        } catch (err) {
          this.record({
            kind: 'system',
            text: `could not expose native Codex task ${session.name} to Claude: ${err.message}`,
            status: 'failed',
          });
        }
      }
    });
  }

  async _notifyConflicts() {
    const current = new Set();
    for (const [key, members] of this.conflicts) {
      if (!this._loggedConflicts.has(key)) {
        this.record({
          kind: 'system',
          text: `name conflict for "${members[0].name}"; messaging is paused until every session has a unique name`,
          status: 'failed',
        });
      }
      this._loggedConflicts.add(key);
      for (const member of members) {
        const noticeKey = `${key}:${member.type}:${member.id}`;
        current.add(noticeKey);
        if (this._notifiedConflicts.has(noticeKey)) continue;
        const text =
          `The session name "${member.name}" conflicts with another live Codex or Claude session. ` +
          'Please rename this session in its native app. Cross-agent messaging for this name will resume automatically once it is unique.';
        let delivered = false;
        try {
          if (member.type === 'claude') {
            await this.deliverToClaude({ peer: this.self, session: member.session, fromName: this.selfName, body: text });
            delivered = true;
          } else if (member.type === 'codex') {
            delivered = await this.codex.sendConflictNotice(member.session, text);
          }
        } catch (err) {
          this.record({ kind: 'system', text: `could not send rename notice to ${member.name}: ${err.message}`, status: 'failed' });
        }
        if (delivered) this._notifiedConflicts.add(noticeKey);
      }
    }
    for (const key of [...this._notifiedConflicts]) if (!current.has(key)) this._notifiedConflicts.delete(key);
    for (const key of [...this._loggedConflicts]) if (!this.conflicts.has(key)) this._loggedConflicts.delete(key);
  }

  _serializeLifecycle(operation) {
    const pending = this._lifecycle.then(operation);
    this._lifecycle = pending.catch(() => {});
    return pending;
  }

  sweep() {
    if (this.stopping) return Promise.resolve();
    if (this._sweeping) return this._sweeping;
    const pending = (async () => {
      await this._reconcile();
      await gcStaleRecords({ sockDirs: [this.sockDir, registry.defaultSockDir()] });
    })().finally(() => {
      if (this._sweeping === pending) this._sweeping = undefined;
    });
    this._sweeping = pending;
    return pending;
  }

  // ---------------------------------------------------------------- log

  record(entry) {
    this.seq += 1;
    const item = { id: this.seq, at: Date.now(), status: 'sent', ...entry };
    this.log.push(item);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.emit('message', item);
    return item;
  }

  updateStatus(id, status, detail) {
    const item = this.log.find((message) => message.id === id);
    if (!item) return;
    item.status = status;
    if (detail) item.statusDetail = detail;
    this.emit('status', item);
  }

  history({ since = 0, limit = 200 } = {}) {
    return this.log.filter((message) => message.id > since).slice(-limit);
  }

  // --------------------------------------------------------------- routing

  async send({ from, fromThread, to, text }) {
    const body = String(text ?? '').trim();
    if (!body) {
      const err = new Error('message must not be empty');
      err.status = 400;
      throw err;
    }
    await this.sweep();

    let sender;
    if (fromThread) sender = this._memberForCodexThread(fromThread);
    else if (from) sender = this.findAgent(from);
    else sender = this.findAgent(this.selfName);
    if (!sender) throw this._addressError('sender', from || fromThread || this.selfName);

    const target = this.findAgent(to);
    if (!target) throw this._addressError('recipient', to);
    if (target.type === 'self') {
      const entry = this.record({ kind: 'message', from: sender.name, to: this.selfName, text: body, status: 'delivered' });
      return { id: entry.id, delivery: 'inbox' };
    }

    const entry = this.record({ kind: 'message', from: sender.name, to: target.name, text: body });
    try {
      if (target.type === 'claude') {
        const peer = sender.type === 'codex' ? this.peers.get(sender.session.threadId.toLowerCase()) : this.self;
        await this.deliverToClaude({ peer, session: target.session, fromName: sender.name, body, entry });
        return { id: entry.id, delivery: 'claude' };
      }
      const sourceThreadId = this._sourceThreadId(sender);
      const result = await this.codex.deliver(target.session, {
        text: body,
        sourceThreadId,
        steer: sender.type === 'claude',
      });
      this._trackCodexDelivery(entry, target.session, result);
      return { id: entry.id, ...result };
    } catch (err) {
      this.updateStatus(entry.id, 'failed', err.message);
      throw err;
    }
  }

  _sourceThreadId(sender) {
    if (sender.type === 'codex') return sender.session.threadId;
    if (sender.type === 'claude') {
      const proxy = this.codex.proxyForClaude(sender.session);
      if (proxy) return proxy.threadId;
      const err = new Error(`Claude proxy for ${sender.name} is not ready`);
      err.status = 503;
      throw err;
    }
    const err = new Error('the relay identity cannot originate a native Codex delegation');
    err.status = 409;
    throw err;
  }

  _addressError(role, name) {
    const key = nameKey(name);
    const err = this.conflicts.has(key)
      ? new Error(`ambiguous ${role} "${name}"; rename the conflicting sessions and retry`)
      : new Error(`unknown ${role} "${name}". Known agents: ${this.knownNames().join(', ')}`);
    err.status = this.conflicts.has(key) ? 409 : 404;
    return err;
  }

  /** Write one native peer message onto a Claude session's socket. */
  async deliverToClaude({ peer, session, fromName, body, entry }) {
    const origin = peer || this.self;
    const token = await registry.tokenForSocketAsync(session.messagingSocketPath);
    const content = w.wrap({
      from: origin.address(),
      fromName,
      fromSession: origin.sessionId,
      fromMode: this.fromMode,
      body,
    });
    const msgId = newMsgId();
    if (entry) entry.msgId = msgId;
    await sendFrames(session.messagingSocketPath, token, [
      { msg_id: msgId, type: 'user', message: { role: 'user', content }, priority: 'next', from: origin.address() },
    ]);
    if (entry) this.updateStatus(entry.id, 'delivered');
  }

  // ---------------------------------------------------- Codex proxy provider

  async handleResponses(headers, body) {
    const supplied = headers?.[PROVIDER_HEADER] || headers?.[PROVIDER_HEADER.toLowerCase()];
    if (!safeTokenEqual(supplied, this.providerToken)) {
      const err = new Error('invalid Codex bridge provider token');
      err.status = 401;
      throw err;
    }
    const text = latestUserText(body);
    const metadata = turnMetadata(headers, body);
    if (text === BOOTSTRAP_PROMPT) return completedResponseSse();
    if (!this.ready) {
      const err = new Error('relay is still initializing');
      err.status = 503;
      throw err;
    }

    const proxyThreadId = metadata?.thread_id || metadata?.threadId || metadata?.session_id;
    let proxy = this.codex.getProxyByThread(proxyThreadId);
    if (!proxy) {
      await this.codex.refresh();
      proxy = this.codex.getProxyByThread(proxyThreadId);
    }
    if (!proxy) {
      const err = new Error('Responses request did not originate from a marked Claude proxy');
      err.status = 403;
      throw err;
    }
    const claude = this._claudeSessions.find((session) => claudeIdentity(session) === proxy.claudeSessionId);
    if (!claude) {
      const err = new Error('the Claude session behind this proxy has exited');
      err.status = 410;
      throw err;
    }
    if (this.conflicts.has(nameKey(claude.name))) throw this._addressError('recipient', claude.name);

    const delegation = latestDelegation(body);
    if (!delegation) {
      const err = new Error('Claude proxies accept only native <codex_delegation> messages');
      err.status = 400;
      throw err;
    }
    const source = this.codex.getRealByThread(delegation.sourceThreadId);
    if (!source) {
      const err = new Error(`unknown source Codex thread ${delegation.sourceThreadId}`);
      err.status = 404;
      throw err;
    }
    if (this.conflicts.has(nameKey(source.name))) throw this._addressError('sender', source.name);
    const peer = this.peers.get(source.threadId.toLowerCase());
    if (!peer) {
      const err = new Error(`Claude-visible peer for ${source.name} is not ready`);
      err.status = 503;
      throw err;
    }

    const entry = this.record({ kind: 'message', from: source.name, to: claude.name, text: delegation.input });
    try {
      await this.deliverToClaude({ peer, session: claude, fromName: source.name, body: delegation.input, entry });
    } catch (err) {
      this.updateStatus(entry.id, 'failed', err.message);
      throw err;
    }
    return completedResponseSse();
  }

  // -------------------------------------------------------- inbound Claude

  onInboundFrame(targetThreadId, frame) {
    this._handleInboundFrame(targetThreadId, frame).catch((err) =>
      this.record({ kind: 'system', text: `native Claude delivery failed: ${err.message}`, status: 'failed' })
    );
  }

  async _handleInboundFrame(targetThreadId, frame) {
    if (!frame || frame.type !== 'user') return;
    const content = frame.message?.content;
    if (typeof content !== 'string' || !content) return;
    const parsed = w.parse(content);
    const body = parsed ? parsed.body : content;

    if (!targetThreadId) {
      const fromName = parsed?.fromName || 'claude';
      this.record({ kind: 'message', from: fromName, to: this.selfName, text: body, status: 'delivered' });
      await this.sendReceipt(this.self, frame, parsed, 'delivered').catch(() => {});
      return;
    }

    await this.sweep();
    const target = this.codex.getRealByThread(targetThreadId);
    if (!target || this.conflicts.has(nameKey(target.name))) {
      const peer = this.peers.get(String(targetThreadId).toLowerCase());
      await this.sendReceipt(peer, frame, parsed, 'failed').catch(() => {});
      throw this._addressError('recipient', target?.name || targetThreadId);
    }
    let claude;
    if (parsed?.fromSession) {
      claude = this._claudeSessions.find((session) => claudeIdentity(session) === parsed.fromSession);
    }
    if (!claude && parsed?.fromName) {
      const member = this.findAgent(parsed.fromName);
      if (member?.type === 'claude') claude = member.session;
    }
    if (!claude) {
      const peer = this.peers.get(target.threadId.toLowerCase());
      await this.sendReceipt(peer, frame, parsed, 'failed').catch(() => {});
      const err = new Error('could not resolve the sending Claude session');
      err.status = 404;
      throw err;
    }
    const proxy = this.codex.proxyForClaude(claude);
    if (!proxy) {
      const err = new Error(`Claude proxy for ${claude.name} is not ready`);
      err.status = 503;
      throw err;
    }

    const entry = this.record({ kind: 'message', from: claude.name, to: target.name, text: body });
    try {
      const result = await this.codex.deliver(target, {
        text: body,
        sourceThreadId: proxy.threadId,
        steer: true,
      });
      this._trackCodexDelivery(entry, target, result);
      await this.sendReceipt(this.peers.get(target.threadId.toLowerCase()), frame, parsed, 'delivered').catch(() => {});
    } catch (err) {
      this.updateStatus(entry.id, 'failed', err.message);
      await this.sendReceipt(this.peers.get(target.threadId.toLowerCase()), frame, parsed, 'failed').catch(() => {});
      throw err;
    }
  }

  async sendReceipt(peer, frame, parsed, status) {
    const replyTo = parsed?.from;
    if (!peer || typeof replyTo !== 'string' || !replyTo.startsWith('uds:')) return;
    const targetPath = w.addressToPath(replyTo);
    const token = await registry.tokenForSocketAsync(targetPath);
    await sendFrames(targetPath, token, [
      {
        type: 'control',
        action: 'peer_message_status',
        status,
        ...(typeof frame.msg_id === 'string' && { orig_msg_id: frame.msg_id }),
        from: peer.address(),
      },
    ]);
  }
}

module.exports = { Relay };
