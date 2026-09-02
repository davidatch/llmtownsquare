'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { sandbox, procStart, until } = require('./helpers');

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function deadProcessPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await waitForExit(child);
  return pid;
}

test('registry discovery, liveness and token lookup', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());
  // Load after the env vars are set so the module picks up the sandbox dirs.
  const registry = require('../lib/claude-registry');

  const sockPath = path.join(box.socks, `${process.pid}.sock`);
  const token = crypto.randomBytes(16).toString('hex');

  await t.test('a live record with a matching procStart is listed', async () => {
    registry.writeRecord(process.pid, {
      pid: process.pid,
      name: 'fake-claude',
      cwd: '/tmp',
      startedAt: Date.now(),
      procStart: procStart(process.pid),
      messagingSocketPath: sockPath,
      status: 'idle',
      kind: 'interactive',
      peerProtocol: 1,
    });
    registry.writeKeyFile(process.pid, sockPath, token, procStart(process.pid));

    const found = (await registry.listSessionsAsync()).find((session) => session.pid === process.pid);
    assert.ok(found, 'live session should be listed');
    assert.strictEqual(found.name, 'fake-claude');
    assert.strictEqual(await registry.tokenForSocketAsync(sockPath), token, 'token resolves from the key file');
  });

  await t.test('key file is written 0600', () => {
    const keyPath = path.join(box.sessions, registry.keyFileName(process.pid, sockPath));
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
  });

  await t.test('a dead pid is filtered out', async () => {
    const deadPid = await deadProcessPid();
    registry.writeRecord(deadPid, {
      pid: deadPid,
      name: 'ghost',
      messagingSocketPath: path.join(box.socks, `${deadPid}.sock`),
      procStart: 'Mon Jan  1 00:00:00 2020',
      startedAt: Date.now(),
    });
    assert.ok(!(await registry.listSessionsAsync()).some((session) => session.pid === deadPid), 'dead pid must not be listed');
  });

  await t.test('an async ps failure never garbage-collects a live Town Square peer', async () => {
    registry.writeRecord(process.pid, {
      pid: process.pid,
      name: 'live-but-unverifiable',
      messagingSocketPath: sockPath,
      procStart: 'verification requires ps',
      startedAt: Date.now(),
      townsquare: { relayPid: process.pid, agent: 'codex' },
    });
    const previousPath = process.env.PATH;
    process.env.PATH = box.base;
    try {
      const stale = await registry.staleTownsquareRecordsAsync();
      assert.ok(
        !stale.some((record) => record.pid === process.pid),
        'failure to execute ps is unknown liveness, not proof that a killable PID is stale'
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  await t.test('a procStart mismatch is treated as pid reuse and filtered out', async () => {
    registry.writeRecord(process.pid, {
      pid: process.pid,
      name: 'reused',
      messagingSocketPath: sockPath,
      procStart: 'Mon Jan  1 00:00:00 2020',
      startedAt: Date.now(),
    });
    assert.ok(!(await registry.listSessionsAsync()).some((session) => session.pid === process.pid), 'stale procStart must not be listed');
  });

  await t.test('a failed virtual-peer publish rolls back every partial artifact', async () => {
    const { VirtualPeer } = require('../lib/virtual-peer');
    const peer = new VirtualPeer({ name: 'rollback-peer', cwd: '/tmp' });
    const originalWriteRecord = registry.writeRecord;
    registry.writeRecord = () => {
      throw new Error('simulated registry disk failure');
    };
    try {
      await assert.rejects(() => peer.start({ sockDir: box.socks }), /simulated registry disk failure/);
    } finally {
      registry.writeRecord = originalWriteRecord;
    }

    assert.strictEqual(fs.existsSync(peer.sockPath), false);
    assert.strictEqual(fs.existsSync(path.join(box.sessions, `${peer.pid}.json`)), false);
    assert.strictEqual(fs.existsSync(path.join(box.sessions, registry.keyFileName(peer.pid, peer.sockPath))), false);
    await until(() => !registry.pidAlive(peer.pid), { timeout: 3000 });
  });

  await t.test('removeRecord deletes both files', () => {
    registry.removeRecord(process.pid, sockPath);
    assert.ok(!fs.existsSync(path.join(box.sessions, `${process.pid}.json`)));
    assert.ok(!fs.existsSync(path.join(box.sessions, registry.keyFileName(process.pid, sockPath))));
  });

  await t.test('existing directory modes are preserved and new private directories are 0700', async () => {
    const existingSockets = path.join(box.base, 'existing-sockets');
    fs.mkdirSync(existingSockets, { mode: 0o755 });
    fs.chmodSync(existingSockets, 0o755);
    registry.ensureSockDir(existingSockets);
    assert.strictEqual(fs.statSync(existingSockets).mode & 0o777, 0o755);

    const newSockets = path.join(box.base, 'new-sockets');
    registry.ensureSockDir(newSockets);
    assert.strictEqual(fs.statSync(newSockets).mode & 0o777, 0o700);

    const { ensureProviderToken } = require('../lib/codex-provider');
    const existingState = path.join(box.base, 'existing-state');
    fs.mkdirSync(existingState, { mode: 0o755 });
    fs.chmodSync(existingState, 0o755);
    const existingToken = path.join(existingState, 'provider-token');
    await ensureProviderToken(existingToken);
    assert.strictEqual(fs.statSync(existingState).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(existingToken).mode & 0o777, 0o600);

    const newState = path.join(box.base, 'new-state');
    await ensureProviderToken(path.join(newState, 'provider-token'));
    assert.strictEqual(fs.statSync(newState).mode & 0o777, 0o700);
  });

  await t.test('registry writes reject unsafe directories and invalid pid paths', () => {
    const unsafeSessions = path.join(box.base, 'shared-sessions');
    fs.mkdirSync(unsafeSessions, { mode: 0o777 });
    fs.chmodSync(unsafeSessions, 0o777);
    const protectedRecord = path.join(unsafeSessions, `${process.pid}.json`);
    fs.writeFileSync(protectedRecord, 'unrelated data');
    const previous = process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR;
    process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR = unsafeSessions;
    try {
      assert.throws(
        () => registry.writeRecord(process.pid, { pid: process.pid }),
        (error) => error.code === 'ETSQUNSAFESESSIONSDIR'
      );
      assert.throws(
        () => registry.removeRecord(process.pid),
        (error) => error.code === 'ETSQUNSAFESESSIONSDIR'
      );
      assert.strictEqual(fs.readFileSync(protectedRecord, 'utf8'), 'unrelated data');
    } finally {
      if (previous === undefined) delete process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR;
      else process.env.TOWNSQUARE_CLAUDE_SESSIONS_DIR = previous;
    }

    assert.throws(
      () => registry.removeRecord('../outside'),
      (error) => error.code === 'ETSQINVALIDPID'
    );
  });

  await t.test('guarded cleanup preserves unsafe paths and removes only inactive sockets', async (subtest) => {
    const { removeInactiveSocket } = require('../lib/uds');
    const regularPath = path.join(box.socks, 'regular.sock');
    fs.writeFileSync(regularPath, 'do not delete');
    await assert.rejects(
      () => removeInactiveSocket(regularPath, { expectedDir: box.socks }),
      (error) => error.code === 'ETSQNOTSOCKET'
    );
    assert.strictEqual(fs.readFileSync(regularPath, 'utf8'), 'do not delete');

    const symlinkTarget = path.join(box.socks, 'symlink-target');
    const symlinkPath = path.join(box.socks, 'symlink.sock');
    fs.writeFileSync(symlinkTarget, 'target');
    fs.symlinkSync(symlinkTarget, symlinkPath);
    await assert.rejects(
      () => removeInactiveSocket(symlinkPath, { expectedDir: box.socks }),
      (error) => error.code === 'ETSQNOTSOCKET'
    );
    assert.strictEqual(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
    assert.strictEqual(fs.readFileSync(symlinkTarget, 'utf8'), 'target');

    const unsafeDir = path.join(box.base, 'shared-sockets');
    fs.mkdirSync(unsafeDir, { mode: 0o777 });
    fs.chmodSync(unsafeDir, 0o777);
    await assert.rejects(
      () => removeInactiveSocket(path.join(unsafeDir, 'missing.sock'), { expectedDir: unsafeDir }),
      (error) => error.code === 'ETSQUNSAFEDIR'
    );

    const activePath = path.join(box.socks, 'active.sock');
    const activeServer = net.createServer(() => {});
    await new Promise((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(activePath, resolve);
    });
    subtest.after(() => {
      if (activeServer.listening) activeServer.close();
    });
    await assert.rejects(
      () => removeInactiveSocket(activePath, {
        expectedDir: box.socks,
        probe: async () => 'uncertain',
      }),
      (error) => error.code === 'ETSQSOCKETUNCERTAIN'
    );
    await assert.rejects(
      () => removeInactiveSocket(activePath, { expectedDir: box.socks }),
      (error) => error.code === 'ETSQSOCKETACTIVE'
    );
    assert.strictEqual(fs.lstatSync(activePath).isSocket(), true);
    await new Promise((resolve) => activeServer.close(resolve));

    const stalePath = path.join(box.socks, 'stale.sock');
    const child = spawn(
      process.execPath,
      ['-e', 'const net=require("net");net.createServer(()=>{}).listen(process.argv[1]);setInterval(()=>{},1000)', stalePath],
      { stdio: 'ignore' }
    );
    subtest.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await until(() => fs.existsSync(stalePath));
    const exited = waitForExit(child);
    child.kill('SIGKILL');
    await exited;
    assert.strictEqual(fs.lstatSync(stalePath).isSocket(), true);
    assert.strictEqual(
      await removeInactiveSocket(stalePath, { expectedDir: box.socks }),
      true
    );
    assert.strictEqual(fs.existsSync(stalePath), false);
  });

  await t.test('stale-record GC never unlinks a non-socket registry path', async () => {
    const { gcStaleRecords } = require('../lib/virtual-peer');
    const deadPid = await deadProcessPid();
    const protectedPath = path.join(box.socks, `${deadPid}.sock`);
    fs.writeFileSync(protectedPath, 'unrelated file');
    registry.writeRecord(deadPid, {
      pid: deadPid,
      name: 'stale-town-square-peer',
      messagingSocketPath: protectedPath,
      procStart: 'Mon Jan  1 00:00:00 2020',
      townsquare: { relayPid: deadPid, agent: 'codex' },
    });

    await gcStaleRecords({ sockDirs: [box.socks] });
    assert.strictEqual(fs.readFileSync(protectedPath, 'utf8'), 'unrelated file');
    assert.strictEqual(fs.existsSync(path.join(box.sessions, `${deadPid}.json`)), false);
  });
});
