'use strict';
/**
 * A "virtual peer" is a Claude-visible identity owned by this relay on behalf of a non-Claude
 * agent (a Codex session). It consists of:
 *   - a live pid          (the real Codex process when we know it, else a placeholder child)
 *   - a unix socket        <sockDir>/<pid>.sock, bound and served by THIS process
 *   - a registry record    ~/.claude/sessions/<pid>.json
 *   - a key file           ~/.claude/sessions/<pid>.<sha256(sock)>.key
 *
 * Claude then lists it in ListAgents and SendMessage(to:"<name>") lands on our socket.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const registry = require('./claude-registry');
const { createInboxServer, removeInactiveSocket } = require('./uds');
const { udsAddress } = require('./wrapper');

const PEER_PROTOCOL = 1;
const CLAUDE_VERSION = '2.1.238';

/**
 * Socket paths this relay currently owns. A registry record is named <pid>.json and a socket
 * <pid>.sock, so two peers sharing a pid would clobber each other's identity. Automatic native
 * reconciliation prevents that; this backstop turns a silent clobber into an error.
 */
const boundPaths = new Set();

/** A process that exits on pipe EOF, including when the relay is killed without cleanup. */
function spawnPlaceholder() {
  const child = spawn('/bin/sh', ['-c', 'while IFS= read -r line; do :; done'], {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: false,
  });
  child.stdin.on('error', () => {});
  child.stdin.unref?.();
  child.unref();
  return child;
}

class VirtualPeer {
  constructor({ name, cwd, onFrame, sessionId, meta = {} }) {
    this.name = name;
    this.cwd = cwd || process.cwd();
    this.sessionId = sessionId || `tsq-${crypto.randomBytes(6).toString('hex')}`;
    this.meta = meta;
    this.onFrame = onFrame;
    this.startedAt = Date.now();
    this.peerToken = crypto.randomBytes(16).toString('hex');
    this.closed = false;
  }

  async start({ pid, sockDir } = {}) {
    const dir = registry.ensureSockDir(sockDir);

    // Prefer the real agent process: when it dies, Claude's own liveness check GCs us.
    if (pid && registry.pidAlive(pid)) {
      this.pid = pid;
      this.ownsProcess = false;
    } else {
      this.placeholder = spawnPlaceholder();
      this.pid = this.placeholder.pid;
      this.ownsProcess = true;
    }
    try {
      this.procStart = (await registry.procStartsOf([this.pid])).get(this.pid);
    } catch {
      // A missing start-time verification must not make the relay unavailable. The placeholder
      // pipe and pidAlive still provide conservative liveness, and later GC will retry.
      this.procStart = undefined;
    }

    this.sockPath = path.join(dir, `${this.pid}.sock`);
    if (boundPaths.has(this.sockPath)) {
      if (this.ownsProcess && this.placeholder) {
        try {
          this.placeholder.stdin?.end();
          this.placeholder.kill('SIGTERM');
        } catch {}
      }
      const err = new Error(
        `refusing to bind ${this.sockPath}: this relay already runs an agent on pid ${this.pid}`
      );
      err.status = 409;
      throw err;
    }
    boundPaths.add(this.sockPath);
    try {
      await removeInactiveSocket(this.sockPath, {
        expectedDir: dir,
        expectedBasename: `${this.pid}.sock`,
      });

      this.server = createInboxServer({
        token: () => this.peerToken,
        onFrame: (frame) => this.onFrame?.(frame),
      });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.sockPath, () => {
          this.server.removeListener('error', reject);
          resolve();
        });
      });
      try {
        fs.chmodSync(this.sockPath, 0o600);
      } catch {}

      registry.writeKeyFile(this.pid, this.sockPath, this.peerToken, this.procStart);
      this.publish();
      return this;
    } catch (err) {
      await this.close().catch(() => {});
      throw err;
    }
  }

  /** (Re)write the public registry record. Mirrors the field set Claude reads. */
  publish() {
    if (this.closed) return;
    const now = Date.now();
    const record = {
      pid: this.pid,
      sessionId: this.sessionId,
      cwd: this.cwd,
      startedAt: this.startedAt,
      ...(this.procStart !== undefined && { procStart: this.procStart }),
      version: CLAUDE_VERSION,
      peerProtocol: PEER_PROTOCOL,
      peerFeatures: [], // we do not implement notify_when_idle
      kind: 'interactive',
      entrypoint: 'cli',
      messagingSocketPath: this.sockPath,
      name: this.name,
      nameSource: 'derived',
      nameSince: this.nameSince || this.startedAt,
      status: 'idle',
      updatedAt: now,
      statusUpdatedAt: now,
      // our own marker: lets the relay GC records it created and lets humans see the truth
      townsquare: { relayPid: process.pid, agent: this.meta.agent || 'codex', ...this.meta },
    };
    registry.writeRecord(this.pid, record);
  }

  rename(name) {
    this.name = name;
    this.nameSince = Date.now();
    this.publish();
  }

  address() {
    return udsAddress(this.sockPath);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.server) await new Promise((r) => this.server.close(r));
    } catch {}
    boundPaths.delete(this.sockPath);
    if (this.sockPath) {
      await removeInactiveSocket(this.sockPath, {
        expectedDir: path.dirname(this.sockPath),
        expectedBasename: `${this.pid}.sock`,
      }).catch(() => {});
    }
    registry.removeRecord(this.pid, this.sockPath);
    if (this.ownsProcess && this.placeholder) {
      try {
        this.placeholder.stdin?.end();
        this.placeholder.kill('SIGTERM');
      } catch {}
    }
  }
}

/** Remove registry records this relay left behind (crash, SIGKILL, pid gone). */
async function gcStaleRecords({ sockDirs = [registry.defaultSockDir()] } = {}) {
  let removed = 0;
  const allowedDirs = new Set(sockDirs.filter(Boolean).map((dir) => path.resolve(dir)));
  for (const rec of await registry.staleTownsquareRecordsAsync()) {
    registry.removeRecord(rec.pid, rec.messagingSocketPath);
    if (rec.messagingSocketPath) {
      const sockPath = path.resolve(rec.messagingSocketPath);
      const expectedDir = path.dirname(sockPath);
      if (allowedDirs.has(expectedDir) && path.basename(sockPath) === `${rec.pid}.sock`) {
        await removeInactiveSocket(sockPath, {
          expectedDir,
          expectedBasename: `${rec.pid}.sock`,
        }).catch(() => {});
      }
    }
    removed += 1;
  }
  return removed;
}

module.exports = { VirtualPeer, gcStaleRecords };
