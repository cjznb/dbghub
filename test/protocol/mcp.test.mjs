/**
 * MCP stdio protocol tests: hand-written JSON-RPC client over in-memory streams.
 * No child processes (Windows sandbox cannot spawn piped test islands), no SDK.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  runMcpServer,
  negotiateProtocolVersion,
  TOOLS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/protocol/mcp.mjs';
import { TOOL_NAMES } from '../../src/protocol/tools.mjs';

const EXPECTED_TOOLS = [
  'discover', 'sessions', 'session_ctl', 'open', 'run', 'wait',
  'state', 'break', 'inspect', 'eval', 'output', 'raw',
];

function harness(callTool) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const waiters = [];
  let buffer = '';
  let cursor = 0;

  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // stdout purity: every line must be one JSON object
      messages.push(msg);
      for (const waiter of [...waiters]) {
        if (!waiter.pred(msg)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  const server = runMcpServer({
    stdin: input,
    stdout: output,
    client: { callTool: callTool || (async () => ({ ok: true })) },
  });

  return {
    server,
    messages,
    send(obj) {
      input.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n');
    },
    next(pred = () => true, timeoutMs = 2000) {
      for (let i = cursor; i < messages.length; i += 1) {
        if (pred(messages[i])) {
          cursor = i + 1;
          return Promise.resolve(messages[i]);
        }
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          pred,
          resolve: (msg) => {
            cursor = messages.indexOf(msg) + 1;
            resolve(msg);
          },
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error('timed out waiting for MCP message'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    settle(ms = 50) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

test('initialize negotiates protocolVersion and reports server info', async () => {
  const h = harness();
  h.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-host', version: '1.0.0' },
    },
  });
  const reply = await h.next((m) => m.id === 1);
  assert.equal(reply.result.protocolVersion, '2025-03-26');
  assert.equal(reply.result.serverInfo.name, 'dbghub');
  assert.equal(typeof reply.result.capabilities.tools, 'object');
  await h.server.close();
});

test('protocol version negotiation falls back to the newest supported revision', () => {
  assert.equal(negotiateProtocolVersion('2025-06-18'), '2025-06-18');
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('2030-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion('2025-01-01'), '2024-11-05');
  assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('tools/list exposes exactly the 12 contract tools', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const reply = await h.next((m) => m.id === 2);
  assert.deepEqual(reply.result.tools.map((t) => t.name), EXPECTED_TOOLS);
  assert.deepEqual(TOOL_NAMES, EXPECTED_TOOLS);
  assert.equal(TOOLS.length, 12);
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
  }
  // spot-check contract field names
  const open = reply.result.tools.find((t) => t.name === 'open');
  assert.deepEqual(
    Object.keys(open.inputSchema.properties).sort(),
    ['actor', 'args', 'core', 'cwd', 'entry', 'flash', 'images', 'mode', 'op_id', 'pid', 'profile', 'program',
      'reuse', 'share', 'source_map', 'stop_at_entry', 'symbol_paths', 'symbols', 'target', 'wait_ms'].sort(),
  );
  const inspect = reply.result.tools.find((t) => t.name === 'inspect');
  assert.ok(inspect.inputSchema.properties.what.enum.includes('rtos'));
  assert.ok(inspect.inputSchema.properties.kind.enum.includes('stacks'));
  assert.ok('task' in inspect.inputSchema.properties);
  assert.deepEqual(inspect.annotations, { readOnlyHint: true });
  await h.server.close();
});

test('ping answers and notifications stay silent', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  const reply = await h.next();
  assert.equal(reply.id, 3);
  assert.deepEqual(reply.result, {});
  await h.settle(30);
  assert.equal(h.messages.length, 1, 'notifications must not produce responses');
  await h.server.close();
});

test('tools/call forwards to client.callTool and preserves ok:false results', async () => {
  const calls = [];
  const h = harness(async (name, args) => {
    calls.push([name, args]);
    if (name === 'sessions') return { ok: false, error: { code: 'E_NO_SESSION', message: 'none open', hint: 'open first' } };
    return { ok: true, sid: 'sabcde', state: 'stopped' };
  });

  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'state', arguments: { sid: 'sabcde' } } });
  const okReply = await h.next((m) => m.id === 4);
  assert.deepEqual(calls[0], ['state', { sid: 'sabcde' }]);
  assert.equal(okReply.result.isError, undefined);
  assert.deepEqual(JSON.parse(okReply.result.content[0].text), { ok: true, sid: 'sabcde', state: 'stopped' });

  h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sessions', arguments: {} } });
  const failReply = await h.next((m) => m.id === 5);
  const payload = JSON.parse(failReply.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'E_NO_SESSION');
  assert.notEqual(failReply.result.isError, true, 'contract failures are ordinary tool results');
  await h.server.close();
});

test('a throwing tool becomes MCP isError content with its code', async () => {
  const h = harness(async () => {
    const e = new Error('daemon call open timed out after 5000ms');
    e.code = 'E_TIMEOUT';
    e.hint = 'check state';
    throw e;
  });
  h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'open', arguments: {} } });
  const reply = await h.next((m) => m.id === 6);
  assert.equal(reply.result.isError, true);
  const payload = JSON.parse(reply.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'E_TIMEOUT');
  assert.equal(payload.error.hint, 'check state');
  await h.server.close();
});

test('unknown tool and unknown method return JSON-RPC errors', async () => {
  const h = harness();
  h.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  h.send({ jsonrpc: '2.0', id: 8, method: 'no/such/method' });
  const unknownTool = await h.next((m) => m.id === 7);
  const unknownMethod = await h.next((m) => m.id === 8);
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /unknown tool: nope/);
  assert.equal(unknownMethod.error.code, -32601);
  await h.server.close();
});

test('malformed JSON is rejected with -32700 and the stream keeps working', async () => {
  const h = harness();
  h.send('{not json}\n');
  const parseError = await h.next();
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.id, null);
  h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const ping = await h.next((m) => m.id === 9);
  assert.deepEqual(ping.result, {});
  await h.server.close();
});

test('split stdout writes still produce one JSON object per line', async () => {
  const h = harness();
  const request = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
  h.send(request.slice(0, 12));
  await h.settle(20);
  h.send(request.slice(12) + '\n');
  const reply = await h.next((m) => m.id === 10);
  assert.equal(reply.result.tools.length, 12);
  await h.server.close();
});
