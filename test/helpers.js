'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Point the libraries at throwaway dirs so tests never touch the real ~/.claude. */
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tsq-test-'));
  const sessions = path.join(base, 'sessions');
  // Socket paths must stay under the ~104 byte sun_path cap, so keep them in /tmp.
  const socks = fs.mkdtempSync(path.join('/tmp', 'tsqs-'));
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR = sessions;
  process.env.TOWNSQUARE_SOCK_DIR = socks;
  process.env.TOWNSQUARE_STATE_DIR = path.join(base, 'state');
  return {
    base,
    sessions,
    socks,
    cleanup() {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(socks, { recursive: true, force: true }); } catch {}
      if (process.env.TOWNSQUARE_STATE_DIR === path.join(base, 'state')) delete process.env.TOWNSQUARE_STATE_DIR;
    },
  };
}

function procStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() returns something truthy, or fail. */
async function until(fn, { timeout = 4000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await wait(step);
  }
}

module.exports = { sandbox, procStart, until };
