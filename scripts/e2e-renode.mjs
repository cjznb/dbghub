#!/usr/bin/env node
/**
 * End-to-end MCP + daemon test against a Renode GDB stub (no physical probe needed).
 *
 * Prereqs:
 *   1) Renode with `.hw/renode-testfw.resc` running (GDB on 127.0.0.1:3333)
 *   2) dbghub daemon: `node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0`
 * Run: node scripts/e2e-renode.mjs
 */
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpServer } from '../src/protocol/mcp.mjs';
import { DaemonClient } from '../src/protocol/daemon-client.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOCKET = process.env.DBGHUB_SOCKET || 'tcp://127.0.0.1:45733';
const TARGET = process.env.DBGHUB_TARGET || '127.0.0.1:3333';
const HW = path.join(ROOT, '.hw/testfw');
const FIX = path.join(ROOT, 'test/fixtures/testfw');
const FWDIR = fs.existsSync(path.join(HW, 'testfw.elf')) ? HW : FIX;
const ELF = process.env.DBGHUB_ELF || path.join(FWDIR, 'testfw.elf');
const MAP = process.env.DBGHUB_MAP || path.join(FWDIR, 'testfw.map');

class McpHarness {
  constructor() {
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.nextId = 1;
    this.stdout.setEncoding('utf8');
    this.stdout.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const i = this.buffer.indexOf('\n');
      if (i < 0) break;
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.lines.push(msg);
      for (const w of [...this.waiters]) {
        if (w.match(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
      }
    }
  }

  waitFor(match, timeoutMs = 30000) {
    const exists = this.lines.find(match);
    if (exists) return Promise.resolve(exists);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timeout waiting for MCP response'));
      }, timeoutMs).unref?.();
    });
  }

  notify(method, params = {}) {
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const msg = await this.waitFor((m) => m.id === id, timeoutMs);
    return msg;
  }
}

function fail(message, extra) {
  console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra).slice(0, 1200));
  process.exitCode = 1;
}

async function main() {
  const daemon = await DaemonClient.connect({ socketPath: SOCKET, autoStart: false });
  const harness = new McpHarness();
  const client = { callTool: (name, args) => daemon.call(name, args, { timeoutMs: 60000 }) };
  const server = runMcpServer({ stdin: harness.stdin, stdout: harness.stdout, client });

  const init = await harness.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-renode', version: '0.1.0' },
  });
  if (!init.result || !init.result.serverInfo) return fail('initialize failed', init);
  console.log('✓ initialize', init.result.protocolVersion, init.result.serverInfo.name);
  harness.notify('notifications/initialized');

  const tools = await harness.request('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  if (names.length !== 12) return fail(`expected 12 tools, got ${names.length}`, names);
  console.log('✓ tools/list', names.join(','));

  const discover = await harness.request('tools/call', { name: 'discover', arguments: { action: 'list' } });
  const disc = JSON.parse(discover.result.content[0].text);
  if (!disc.ok) return fail('discover failed', disc);
  console.log('✓ discover', `profiles=${disc.profiles.length}`, `probes=${disc.probes.length}`);

  const open = await harness.request('tools/call', {
    name: 'open',
    arguments: {
      profile: 'renode',
      program: ELF,
      symbols: [MAP],
      stop_at_entry: false,
      wait_ms: 20000,
    },
  });
  const opened = JSON.parse(open.result.content[0].text);
  if (!opened.ok) return fail('open failed', opened);
  const sid = opened.sid;
  console.log('✓ open', sid, opened.state, opened.stop?.loc?.fn, opened.symbols?.sources?.length);

  const bp = await harness.request('tools/call', { name: 'break', arguments: { sid, action: 'set', spec: 'tick' } });
  const bpd = JSON.parse(bp.result.content[0].text);
  if (!bpd.ok || !bpd.breakpoints?.length) return fail('break failed', bpd);
  console.log('✓ break', bpd.breakpoints[0].spec);

  const run = await harness.request('tools/call', {
    name: 'run',
    arguments: { sid, action: 'continue', timeout_ms: 15000 },
  });
  const ran = JSON.parse(run.result.content[0].text);
  if (!ran.ok || ran.state !== 'stopped' || ran.reason !== 'breakpoint-hit') return fail('run failed', ran);
  console.log('✓ run', ran.reason, ran.loc.fn + ':' + ran.loc.line, 'epoch=' + ran.epoch);

  const state = await harness.request('tools/call', { name: 'state', arguments: { sid, detail: 1 } });
  const std = JSON.parse(state.result.content[0].text);
  if (!std.ok || std.state !== 'stopped') return fail('state failed', std);
  console.log('✓ state', std.stop?.loc?.fn, 'locals=' + (std.stop?.locals?.length || 0));

  const frames = await harness.request('tools/call', { name: 'inspect', arguments: { sid, what: 'frames', count: 5 } });
  const fr = JSON.parse(frames.result.content[0].text);
  if (!fr.ok || fr.items.length < 2 || fr.items[1].i !== 1) return fail('inspect frames failed', fr);
  console.log('✓ inspect frames', fr.items.map((x) => `${x.i}:${x.fn}`).join(' '));

  const ev = await harness.request('tools/call', { name: 'eval', arguments: { sid, exprs: ['tick_count', 'last_value'] } });
  const e = JSON.parse(ev.result.content[0].text);
  if (!e.ok || e.results.length !== 2) return fail('eval failed', e);
  console.log('✓ eval', e.results.map((x) => `${x.expr}=${x.value}`).join(' '));

  const mem = await harness.request('tools/call', {
    name: 'inspect',
    arguments: { sid, what: 'memory', addr: '0x20000000', count: 16 },
  });
  const m = JSON.parse(mem.result.content[0].text);
  if (!m.ok) return fail('inspect memory failed', m);
  console.log('✓ inspect memory', JSON.stringify(m.items?.[0] || m).slice(0, 120));

  const close = await harness.request('tools/call', { name: 'session_ctl', arguments: { sid, action: 'close', kill: true } });
  const c = JSON.parse(close.result.content[0].text);
  if (!c.ok) return fail('close failed', c);
  console.log('✓ close', c.state);

  server.close?.();
  harness.stdin.end();
  await daemon.close();
  if (!process.exitCode) console.log('E2E PASS');
}

main().catch((e) => {
  console.error('E2E ERROR:', e.stack || e.message);
  process.exitCode = 1;
});
