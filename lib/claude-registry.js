'use strict';
/**
 * Reads (and writes) Claude Code's on-disk peer registry.
 *
 * Layout, verified against claude 2.1.238:
 *   ~/.claude/sessions/<pid>.json                       public record, mode 0600 dir
 *   ~/.claude/sessions/<pid>.<sha256(sockPath)>.key      {"peerToken","procStart"}, mode 0600
 *   <XDG_RUNTIME_DIR|CLAUDE_CODE_TMPDIR|/tmp>/cc-socks/<pid>.sock
 *
 * A record counts as live only when the pid exists AND `ps -o lstart=` still matches the
 * recorded procStart (guards against pid reuse).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const KEY_RE = /^(\d+)\.[0-9a-f]{64}\.key$/;
const JSON_RE = /^\d+\.json$/;

function sessionsDir() {
  return process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
}

function privateSessionsDir({ create = false } = {}) {
  const dir = path.resolve(sessionsDir());
  let created;
  try {
    if (create) created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else fs.lstatSync(dir);
  } catch (err) {
    if (!create && err && err.code === 'ENOENT') return undefined;
    throw err;
  }
  if (created !== undefined) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
  const stat = fs.lstatSync(dir);
  const ownedByProcess = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (!stat.isDirectory() || !ownedByProcess || (stat.mode & 0o022) !== 0) {
    const err = new Error(`Refusing to modify unsafe Claude sessions directory: ${dir}`);
    err.code = 'ETSQUNSAFESESSIONSDIR';
    throw err;
  }
  return dir;
}

function registryPid(pid) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== String(pid)) {
    const err = new Error(`Invalid registry pid: ${pid}`);
    err.code = 'ETSQINVALIDPID';
    throw err;
  }
  return value;
}

function defaultSockDir() {
  if (process.env.TOWNSQUARE_SOCK_DIR) return process.env.TOWNSQUARE_SOCK_DIR;
  const base = process.env.XDG_RUNTIME_DIR || process.env.CLAUDE_CODE_TMPDIR || '/tmp';
  return path.join(base, 'cc-socks');
}

function sockDirFromRecords(records) {
  if (process.env.TOWNSQUARE_SOCK_DIR) return process.env.TOWNSQUARE_SOCK_DIR;
  const counts = new Map();
  for (const rec of records || []) {
    if (!rec.messagingSocketPath) continue;
    const dir = path.dirname(rec.messagingSocketPath);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best;
  for (const [dir, count] of counts) if (!best || count > best[1]) best = [dir, count];
  return best ? best[0] : defaultSockDir();
}

function ensureSockDir(dir = defaultSockDir()) {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`Claude socket path is not a directory: ${dir}`);
  if (created !== undefined) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
  return dir;
}

function keyFileName(pid, sockPath) {
  const digest = crypto.createHash('sha256').update(path.resolve(sockPath)).digest('hex');
  return `${pid}.${digest}.key`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** Resolve process start times in one asynchronous ps invocation. */
async function procStartsOf(pids) {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!unique.length) return new Map();
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=', '-o', 'lstart=', '-p', unique.join(',')], {
    timeout: 2000,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const starts = new Map();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) starts.set(Number(match[1]), match[2]);
  }
  return starts;
}

function readRecords() {
  const dir = sessionsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!JSON_RE.test(name)) continue;
    const pid = Number.parseInt(name.slice(0, -'.json'.length), 10);
    if (!Number.isInteger(pid)) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const rec = JSON.parse(raw);
      if (rec && typeof rec === 'object') out.push({ ...rec, pid });
    } catch {
      /* skip unreadable/partial writes */
    }
  }
  return out;
}

/** Async, batched equivalent used by the relay so HTTP handlers never run synchronous ps. */
async function listSessionsAsync({ includeTownsquare = false, procStarts = procStartsOf } = {}) {
  const records = readRecords()
    .filter((rec) => includeTownsquare || !rec.townsquare)
    .filter((rec) => typeof rec.messagingSocketPath === 'string' && rec.messagingSocketPath)
    .filter((rec) => pidAlive(rec.pid));
  const verify = records.filter((rec) => (rec.procStartFt ?? rec.procStart) !== undefined);
  let starts;
  try {
    starts = await procStarts(verify.map((rec) => rec.pid));
  } catch {
    // Verification failure is not proof of death. Keeping pid-live records is safer than
    // deleting every identity because ps was briefly unavailable or timed out.
    return records;
  }
  return records.filter((rec) => {
    const recorded = rec.procStartFt ?? rec.procStart;
    return recorded === undefined || starts.get(rec.pid) === recorded;
  });
}

async function tokenForSocketAsync(sockPath) {
  const dir = sessionsDir();
  const want = keyFileName('', sockPath).slice(1);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const name of names) {
    if (!KEY_RE.test(name) || !name.endsWith(want)) continue;
    const pid = Number.parseInt(name.split('.')[0], 10);
    let data;
    try {
      data = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (data && typeof data.peerToken === 'string') candidates.push({ pid, data });
  }
  const live = candidates.filter((candidate) => pidAlive(candidate.pid));
  const verify = live.filter((candidate) => (candidate.data.procStartFt ?? candidate.data.procStart) !== undefined);
  let starts;
  try {
    starts = await procStartsOf(verify.map((candidate) => candidate.pid));
  } catch {
    return live[0]?.data.peerToken || candidates[0]?.data.peerToken;
  }
  for (const candidate of live) {
    const recorded = candidate.data.procStartFt ?? candidate.data.procStart;
    if (recorded === undefined || starts.get(candidate.pid) === recorded) return candidate.data.peerToken;
  }
  return candidates[0]?.data.peerToken;
}

function writeRecord(pid, record) {
  const safePid = registryPid(pid);
  const dir = privateSessionsDir({ create: true });
  const file = path.join(dir, `${safePid}.json`);
  const tmp = `${file}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeKeyFile(pid, sockPath, peerToken, procStart) {
  const safePid = registryPid(pid);
  const dir = privateSessionsDir({ create: true });
  const file = path.join(dir, keyFileName(safePid, sockPath));
  const tmp = `${file}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  const payload = { peerToken, ...(procStart !== undefined && { procStart }) };
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

function removeRecord(pid, sockPath) {
  const safePid = registryPid(pid);
  const dir = privateSessionsDir();
  if (!dir) return;
  for (const file of [path.join(dir, `${safePid}.json`), sockPath && path.join(dir, keyFileName(safePid, sockPath))]) {
    if (!file) continue;
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

async function staleTownsquareRecordsAsync({ procStarts = procStartsOf } = {}) {
  const records = readRecords().filter((record) => record.townsquare);
  const live = new Set((await liveRecordsAsync(records, { procStarts })).map((record) => record.pid));
  return records.filter((record) => !live.has(record.pid));
}

async function liveRecordsAsync(records, { procStarts = procStartsOf } = {}) {
  const existing = records.filter((record) => pidAlive(record.pid));
  const verify = existing.filter((record) => (record.procStartFt ?? record.procStart) !== undefined);
  let starts;
  try {
    starts = await procStarts(verify.map((record) => record.pid));
  } catch {
    return existing;
  }
  return existing.filter((record) => {
    const recorded = record.procStartFt ?? record.procStart;
    return recorded === undefined || starts.get(record.pid) === recorded;
  });
}

module.exports = {
  sessionsDir,
  sockDirFromRecords,
  defaultSockDir,
  ensureSockDir,
  keyFileName,
  pidAlive,
  listSessionsAsync,
  tokenForSocketAsync,
  writeRecord,
  writeKeyFile,
  removeRecord,
  staleTownsquareRecordsAsync,
  procStartsOf,
};
