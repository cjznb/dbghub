/**
 * Daemon transport tests: NDJSON framing, dispatch, per-connection identity, idle exit, bind
 * collision and the loopback-TCP token handshake. Transport is loopback TCP so the Windows
 * sandbox can run them; the named-pipe/Unix path shares this exact code below `net`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { runDaemon } from '../../src/daemon/daemon.mjs';
import { DaemonClient } from '../../src/protocol/daemon-client.mjs';
import { err } from '../../src/util/errors.mjs';

function tcpSpec(port) {
  return `tcp://127.0.0.1:${port}`;
}

/** Raw NDJSON client: lets tests split and coalesce lines exactly like a real peer might. */
function rawClient(spec) {
  const { host, port } = { host: '127.0.0.1', port: Number(spec.split(':').pop()) };
  const socket = net.createConnection({ host, port });
  const messages = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const w of [...waiters]) {
        if (!w.pred(msg)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  return {
    socket,
    messages,
    ready: new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    }),
    write: (text) => socket.write(text),
    next(pred = () => true, timeoutMs = 2000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error('timed out waiting for daemon line'));
        }, timeoutMs);
        const original = w.resolve;
        w.resolve = (msg) => {
          clearTimeout(timer);
          original(msg);
        };
        waiters.push(w);
      });
    },
    close: () => new Promise((resolve) => socket.end(resolve)),
  };
}

function handlers() {
  return {
    echo: async (params) => ({ ok: true, echo: params }),
    whoami: async (_p, ctx) => ({ ok: true, clientId: ctx.clientId, remote: ctx.remote }),
    boom: async () => { throw err('E_INVALID_ARG', 'boom', 'hint here'); },
  };
}

test('dispatches requests and keeps one JSON object per line', async () => {
  const daemon = await runDaemon({ socketPath: tcpSpec(0), handlers: handlers() });
  const spec = tcpSpec(daemon.port());
  const peer = rawClient(spec);
  await peer.ready;
  try {
    // two requests arriving in one chunk, and a third split across two writes
    peer.write(
      JSON.stringify({ id: 1, method: 'echo', params: { a: 1 } }) + '\n'
      + JSON.stringify({ id: 2, method: 'whoami', params: {} }) + '\n',
    );
    const first = await peer.next((m) => m.id === 1);
    const second = await peer.next((m) => m.id === 2);
    assert.deepEqual(first, { id: 1, ok: true, result: { ok: true, echo: { a: 1 } } });
    assert.equal(second.result.ok, true);
    assert.match(second.result.clientId, /^c\d+$/);

    const third = JSON.stringify({ id: 3, method: 'echo', params: { split: true } });
    peer.write(third.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    peer.write(third.slice(10) + '\n');
    const split = await peer.next((m) => m.id === 3);
    assert.deepEqual(split.result.echo, { split: true });
  } finally {
    await peer.close();
    await daemon.close();
  }
});

test('handler failures and unknown methods map to typed errors', async () => {
  const daemon = await runDaemon({ socketPath: tcpSpec(0), handlers: handlers() });
  const peer = rawClient(tcpSpec(daemon.port()));
  await peer.ready;
  try {
    peer.write(JSON.stringify({ id: 1, method: 'boom', params: {} }) + '\n');
    const boom = await peer.next((m) => m.id === 1);
    assert.equal(boom.ok, false);
    assert.deepEqual(boom.error, { code: 'E_INVALID_ARG', message: 'boom', hint: 'hint here' });

    peer.write(JSON.stringify({ id: 2, method: 'nope' }) + '\n');
    const unknown = await peer.next((m) => m.id === 2);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'E_INVALID_ARG');
    assert.match(unknown.error.message, /unknown method/);

    peer.write('{broken json\n');
    const parseError = await peer.next((m) => m.error && m.id === null);
    assert.equal(parseError.error.code, 'E_INVALID_ARG');
  } finally {
    await peer.close();
    await daemon.close();
  }
});

test('each connection gets its own clientId', async () => {
  const daemon = await runDaemon({ socketPath: tcpSpec(0), handlers: handlers() });
  const spec = tcpSpec(daemon.port());
  const a = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 1000 });
  const b = await DaemonClient.connect({ socketPath: spec, autoStart: false, timeoutMs: 1000 });
  try {
    const [ra, rb] = await Promise.all([a.call('whoami'), b.call('whoami')]);
    assert.notEqual(ra.clientId, rb.clientId);
    assert.equal(daemon.stats().connections, 2);
  } finally {
    await a.close();
    await b.close();
    await daemon.close();
  }
});

test('idle exit waits for zero sessions and calls onIdle once', async () => {
  let idleCalls = 0;
  const daemon = await runDaemon({
    socketPath: tcpSpec(0),
    handlers: handlers(),
    idleExitMin: 0.001, // 60 ms
    idleCheckMs: 20,
    onIdle: async () => { idleCalls += 1; },
  });
  const closed = await Promise.race([
    daemon.whenClosed,
    new Promise((resolve) => setTimeout(() => resolve({ why: 'timeout' }), 3000)),
  ]);
  assert.equal(closed.why, 'idle');
  assert.equal(idleCalls, 1);
});

test('busy sessions block idle exit', async () => {
  let sessions = 1;
  const daemon = await runDaemon({
    socketPath: tcpSpec(0),
    handlers: handlers(),
    idleExitMin: 0.001,
    idleCheckMs: 20,
    hasActiveSessions: () => sessions,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(daemon.server.listening, true, 'daemon must stay up while a session exists');
  sessions = 0;
  const closed = await Promise.race([
    daemon.whenClosed,
    new Promise((resolve) => setTimeout(() => resolve({ why: 'timeout' }), 2000)),
  ]);
  assert.equal(closed.why, 'idle');
  await daemon.close();
});

test('a second daemon on the same endpoint fails fast with E_DAEMON_STARTING', async () => {
  const first = await runDaemon({ socketPath: tcpSpec(0), handlers: handlers() });
  const spec = tcpSpec(first.port());
  try {
    await assert.rejects(
      () => runDaemon({ socketPath: spec, handlers: handlers() }),
      (e) => e.code === 'E_DAEMON_STARTING',
    );
  } finally {
    await first.close();
  }
});

test('loopback TCP requires the hello token; DaemonClient sends it automatically', async () => {
  const daemon = await runDaemon({ socketPath: tcpSpec(0), handlers: handlers(), token: 'secret-token' });
  const spec = tcpSpec(daemon.port());
  try {
    const anonymous = rawClient(spec);
    await anonymous.ready;
    anonymous.write(JSON.stringify({ id: 1, method: 'echo', params: {} }) + '\n');
    const denied = await anonymous.next((m) => m.id === 1);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'E_ATTACH_DENIED');
    anonymous.socket.destroy();

    const authed = await DaemonClient.connect({ socketPath: spec, token: 'secret-token', autoStart: false, timeoutMs: 2000 });
    try {
      assert.deepEqual(await authed.call('echo', { token: true }), { ok: true, echo: { token: true } });
    } finally {
      await authed.close();
    }
  } finally {
    await daemon.close();
  }
});
