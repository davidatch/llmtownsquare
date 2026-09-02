'use strict';
/**
 * NDJSON-over-unix-socket transport used by Claude Code's cross-session messaging.
 *
 * Wire format (verified against claude 2.1.238, functions gXd / niw / eiw):
 *   line 1: {"type":"auth","token":"<32 hex>"}
 *   line 2: the payload frame ({"type":"user",...} or {"type":"control",...})
 *   then the sender half-closes. One connection per message.
 */

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const LINE_CAP = 1048576; // H$r in the bundle
const CONNECT_TIMEOUT_MS = 5000;
const CLEANUP_PROBE_TIMEOUT_MS = 250;

function newMsgId() {
  return crypto.randomBytes(12).toString('hex'); // 24 hex chars, matches RId=24
}

function cleanupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Distinguish a stale socket from a live or uncertain path without sending application data. */
function probeSocket(sockPath, { connectSocket = net.connect, timeoutMs = CLEANUP_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(state);
    };
    try {
      socket = connectSocket({ path: sockPath });
    } catch {
      finish('uncertain');
      return;
    }
    timer = setTimeout(() => finish('uncertain'), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish('active'));
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED') finish('inactive');
      else if (error?.code === 'ENOENT') finish('missing');
      else finish('uncertain');
    });
  });
}

/**
 * Remove only a socket at an exact caller-owned location that is proven inactive.
 * Regular files, symlinks, live sockets, uncertain probes, and inode swaps fail closed.
 */
async function removeInactiveSocket(
  sockPath,
  { expectedDir, expectedBasename, probe = probeSocket } = {}
) {
  if (!expectedDir) throw cleanupError('ETSQUNSAFEPATH', 'socket cleanup requires an expected directory');
  const resolved = path.resolve(String(sockPath));
  const resolvedDir = path.resolve(String(expectedDir));
  if (path.dirname(resolved) !== resolvedDir) {
    throw cleanupError('ETSQUNSAFEPATH', `refusing to remove a socket outside ${resolvedDir}`);
  }
  if (expectedBasename && path.basename(resolved) !== expectedBasename) {
    throw cleanupError('ETSQUNSAFEPATH', `refusing to remove unexpected socket path ${resolved}`);
  }

  let directory;
  try {
    directory = fs.lstatSync(resolvedDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const ownedByProcess = typeof process.getuid !== 'function' || directory.uid === process.getuid();
  if (!directory.isDirectory() || !ownedByProcess || (directory.mode & 0o022) !== 0) {
    throw cleanupError(
      'ETSQUNSAFEDIR',
      `refusing socket cleanup in a non-private directory: ${resolvedDir}`
    );
  }

  let original;
  try {
    original = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!original.isSocket()) {
    throw cleanupError('ETSQNOTSOCKET', `refusing to remove non-socket path ${resolved}`);
  }

  const state = await probe(resolved);
  if (state === 'missing') return false;
  if (state !== 'inactive') {
    throw cleanupError(
      state === 'active' ? 'ETSQSOCKETACTIVE' : 'ETSQSOCKETUNCERTAIN',
      `refusing to remove ${state} socket ${resolved}`
    );
  }

  let current;
  try {
    current = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
    throw cleanupError('ETSQSOCKETCHANGED', `refusing to remove changed socket path ${resolved}`);
  }
  fs.unlinkSync(resolved);
  return true;
}

function encodeLine(obj) {
  const line = JSON.stringify(obj);
  if (line.length + 1 > LINE_CAP) {
    const err = new Error(`cross-session message exceeds the line cap (${line.length + 1} > ${LINE_CAP})`);
    err.code = 'ETSQLINECAP';
    throw err;
  }
  return `${line}\n`;
}

/**
 * Send frames to a peer socket.
 * @param {string} sockPath        absolute path of the receiver's socket
 * @param {string|undefined} token peerToken of the receiver (omitted => unauthenticated)
 * @param {object[]} frames        payload frames, sent after the auth line
 */
function sendFrames(sockPath, token, frames) {
  return new Promise((resolve, reject) => {
    // Refuse to follow a symlink, exactly like the reference sender does.
    let st;
    try {
      st = fs.lstatSync(sockPath);
    } catch (err) {
      err.code = err.code || 'ENOENT';
      return reject(err);
    }
    if (st.isSymbolicLink()) {
      const err = new Error(`refusing to send to a symlinked socket: ${sockPath}`);
      err.code = 'ETSQSYMLINK';
      return reject(err);
    }

    let payload = '';
    try {
      if (token) payload += encodeLine({ type: 'auth', token });
      for (const frame of frames) payload += encodeLine(frame);
    } catch (err) {
      return reject(err);
    }

    const sock = net.connect({ path: sockPath });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };

    sock.setTimeout(CONNECT_TIMEOUT_MS, () => {
      const err = new Error(`timed out talking to ${sockPath}`);
      err.code = 'ETSQTIMEOUT';
      done(err);
    });
    sock.on('error', done);
    sock.on('connect', () => {
      sock.end(payload, () => {
        // macOS delays the FIN; give the receiver a moment before tearing down.
        setTimeout(() => done(null), 60);
      });
    });
  });
}

/**
 * Create an NDJSON server that mimics a Claude inbox: it requires an auth line first and
 * hands each subsequent parsed frame to onFrame.
 *
 * @param {object} opts
 * @param {() => string} opts.token
 * @param {(frame: object) => void} opts.onFrame
 */
function createInboxServer({ token, onFrame }) {
  return net.createServer((conn) => {
    conn.setEncoding('utf8');
    let buffer = '';
    let authenticated = false;
    let sawFirstLine = false;

    const handleLine = (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      const first = !sawFirstLine;
      sawFirstLine = true;
      if (frame && frame.type === 'auth') {
        if (first) {
          const expected = token();
          authenticated =
            typeof frame.token === 'string' &&
            typeof expected === 'string' &&
            safeEqual(frame.token, expected);
          if (!authenticated) conn.destroy();
        }
        return;
      }
      if (!authenticated) {
        conn.destroy();
        return;
      }
      try {
        onFrame(frame);
      } catch {
        /* never let a bad frame kill the server */
      }
    };

    conn.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > LINE_CAP) {
        conn.destroy();
        buffer = '';
        return;
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) handleLine(line);
        if (conn.destroyed) {
          buffer = '';
          return;
        }
      }
    });
    conn.on('end', () => {
      if (buffer.trim() && !conn.destroyed) handleLine(buffer);
      buffer = '';
      if (!conn.destroyed) conn.end();
    });
    conn.on('error', () => {});
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { sendFrames, createInboxServer, newMsgId, removeInactiveSocket };
