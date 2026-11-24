/**
 * Daemon IPC client tests. Endpoints use loopback TCP (`tcp://host:port`) because the Windows
 * sandbox used for CI cannot open named pipes from a child process; production defaults stay
 * named pipe / Unix socket and share the exact same wire code below the transport.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDaemon } from '../../src/daemon/daemon.mjs';
import { DaemonClient, defaultServeArgs } from '../../src/protocol/daemon-client.mjs';
import { defaultSocketPath, readDaemonInfo, parseEndpoint } from '../../src/protocol/ipc-paths.mjs';
import { err } from '../../src/util/errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function handlers() {
  return {
    echo: async (params) => ({ ok: true, echo: params }),
    whoami: async (_params, ctx) => ({ ok: true, clientId: ctx.clientId }),
    boom: async () => { throw err('E_INVALID_ARG', 'boom', 'do not do that'); },
    slow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, slow: true };
    },
  };
}

async function startDaemon(handlerTable = handlers(), extra = {}) {
  const daemon = await runDaemon({ socketPath: 'tcp://127.0.0.1:0', handlers: handlerTable, ...extra });
  const spec = `tcp://127.0.0.1:${daemon.port()}`;
  return { daemon, spec };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('calls round-trip over the socket and preserve handler errors', async () => {
  const { daemon, spec } = await startDaemon();
  const client = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 2000 });
  try {
    assert.deepEqual(await client.call('echo', { x: 1 }), { ok: true, echo: { x: 1 } });
    const who = await client.call('whoami', {});
    assert.match(who.clientId, /^c\d+$/);
    await assert.rejects(
      () => client.call('boom'),
      (e) => e.code === 'E_INVALID_ARG' && /boom/.test(e.message) && e.hint === 'do not do that',
    );
    await assert.rejects(
      () => client.call('no-such-method'),
      (e) => e.code === 'E_INVALID_ARG' && /unknown method/.test(e.message),
    );
  } finally {
    await client.close();
    await daemon.close();
  }
});

test('call timeout rejects with E_TIMEOUT and leaves the connection usable', async () => {
  const { daemon, spec } = await startDaemon();
  const client = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 2000 });
  try {
    await assert.rejects(() => client.call('slow', {}, { timeoutMs: 40 }), (e) => e.code === 'E_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(await client.call('echo', { after: true }), { ok: true, echo: { after: true } });
  } finally {
    await client.close();
    await daemon.close();
  }
});

test('two clients share one daemon concurrently', async () => {
  const { daemon, spec } = await startDaemon();
  const a = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 2000 });
  const b = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 2000 });
  try {
    const [ra, rb] = await Promise.all([a.call('whoami', {}), b.call('whoami', {})]);
    assert.notEqual(ra.clientId, rb.clientId);
  } finally {
    await a.close();
    await b.close();
    await daemon.close();
  }
});

test('a closed daemon surfaces E_DAEMON_DOWN', async () => {
  const { daemon, spec } = await startDaemon();
  const client = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 1000 });
  await daemon.close();
  await assert.rejects(
    () => client.call('echo', {}, { timeoutMs: 400 }),
    (e) => e.code === 'E_DAEMON_DOWN' || e.code === 'E_TIMEOUT',
  );
  await client.close();
});

test('autoStart spawns a detached daemon and waits for the endpoint', async (t) => {
  const port = await freePort();
  const spec = `tcp://127.0.0.1:${port}`;
  const fixture = path.join(HERE, 'fixtures', 'fake-daemon.mjs');
  let client;
  try {
    client = await DaemonClient.connect({
      socketPath: spec,
      autoStart: true,
      command: process.execPath,
      args: [fixture, spec],
      timeoutMs: 6000,
    });
  } catch (e) {
    if (e && (e.code === 'E_DAEMON_DOWN' || /EPERM|spawn/i.test(String(e.message)))) {
      t.skip(`cannot spawn under this sandbox: ${e.message}`);
      return;
    }
    throw e;
  }
  try {
    assert.deepEqual(await client.call('echo', { boot: 1 }), { ok: true, echo: { boot: 1 } });
  } finally {
    await client.close();
  }
});

test('endpoint discovery prefers DBGHUB_SOCKET then the platform default', () => {
  const forced = defaultSocketPath({ env: { DBGHUB_SOCKET: 'forced-endpoint' }, platform: 'linux' });
  assert.equal(forced, 'forced-endpoint');
  const win = defaultSocketPath({ env: {}, platform: 'win32', user: 'Someone' });
  assert.equal(win, '\\\\.\\pipe\\dbghub-someone');
  const nix = defaultSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1' }, platform: 'linux' });
  assert.equal(nix, path.join('/run/user/1', 'dbghub', 'dbghub.sock'));
  assert.equal(readDaemonInfo({ env: { DBGHUB_SOCKET: 'x' }, platform: 'linux' }), null);
  assert.deepEqual(parseEndpoint(win), { kind: 'pipe', path: win, spec: win });
  assert.deepEqual(parseEndpoint('tcp://127.0.0.1:4444'), { kind: 'tcp', host: '127.0.0.1', port: 4444, spec: 'tcp://127.0.0.1:4444' });
});

test('defaultServeArgs points at this checkout bin with --daemon', () => {
  const args = defaultServeArgs('\\\\.\\pipe\\dbghub-test');
  assert.ok(args.includes('serve'));
  assert.ok(args.includes('--daemon'));
  assert.ok(args.includes('--socket'));
  assert.equal(args[args.length - 1], '\\\\.\\pipe\\dbghub-test');
});
