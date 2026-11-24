/**
 * MAP parser tests: GNU ld `-Map` and Keil/Armlink text, inline snippets and
 * file input, malformed/oversized input handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { armlinkMapText, gnuMapText, makeTmp, writeTmp } from './helpers.mjs';
import { MAX_MAP_BYTES, parseMap } from '../../src/symbols/map.mjs';

test('parses an inline GNU ld map (sections, symbols, object, totals)', () => {
  const r = parseMap(gnuMapText());
  assert.equal(r.ok, true);
  assert.equal(r.format, 'gnu');
  assert.deepEqual(r.warnings, []);

  const byName = Object.fromEntries(r.sections.map((s) => [s.name, s]));
  assert.deepEqual(byName['.text'], { name: '.text', addr: 0x08000100, size: 0x93c8 });
  assert.deepEqual(byName['.data'], { name: '.data', addr: 0x20000000, size: 0x70, loadAddr: 0x0800a93c });
  assert.deepEqual(byName['.bss'], { name: '.bss', addr: 0x20000070, size: 0x3180 });
  assert.equal(r.sections.length, 5); // + .isr_vector + .debug_info

  const main = r.symbols.find((s) => s.name === 'main');
  assert.equal(main.addr, 0x08000101);
  assert.equal(main.object, 'app.o');
  const estack = r.symbols.find((s) => s.name === '_estack');
  assert.equal(estack.addr, 0x20005000);
  assert.equal(estack.object, undefined);
  assert.equal(r.symbols.find((s) => s.name === 'g_value').addr, 0x20000000);
  // ". = ALIGN(...)" rows are the location counter, not symbols.
  assert.equal(r.symbols.find((s) => s.name === '.'), undefined);

  assert.deepEqual(r.totals, {
    text: 0x100 + 0x93c8,
    data: 0x70,
    bss: 0x3180,
    rom: 0x100 + 0x93c8 + 0x70,
    ram: 0x70 + 0x3180,
  });
});

test('parses a GNU map from a file path and tolerates CRLF', (t) => {
  const dir = makeTmp(t);
  const file = writeTmp(dir, 'fw.map', gnuMapText().replace(/\n/g, '\r\n'));
  const r = parseMap(file);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'gnu');
  assert.equal(r.source, file);
  assert.equal(r.sections[0].name, '.isr_vector');
});

test('detects GNU map snippets without the "Linker script and memory map" marker', () => {
  const r = parseMap('.text           0x08000000      0x100\n.data           0x20000000       0x20\n');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'gnu');
  assert.equal(r.sections.length, 2);
  assert.deepEqual(r.totals, { text: 0x100, data: 0x20, bss: 0, rom: 0x120, ram: 0x20 });
});

test('parses a Keil/Armlink map (memory map, symbol table, grand totals)', () => {
  const r = parseMap(armlinkMapText());
  assert.equal(r.ok, true);
  assert.equal(r.format, 'armlink');
  assert.deepEqual(r.warnings, []);

  const byName = Object.fromEntries(r.sections.map((s) => [s.name, s]));
  assert.deepEqual(byName['.text'], { name: '.text', addr: 0x08000130, size: 0xed0 });
  assert.deepEqual(byName['.data'], { name: '.data', addr: 0x20000000, size: 0x10, loadAddr: 0x08001200 });
  assert.deepEqual(byName['.bss'], { name: '.bss', addr: 0x20000010, size: 0x100 });

  const main = r.symbols.find((s) => s.name === 'main');
  assert.deepEqual(main, { name: 'main', addr: 0x08000101, size: 32, object: 'main.o', section: '.text' });
  const estack = r.symbols.find((s) => s.name === '__initial_sp');
  assert.equal(estack.addr, 0x20005000);
  assert.equal(estack.object, 'startup_stm32f10x_hd.o');

  assert.deepEqual(r.totals, { text: 1300, data: 16, bss: 256, rom: 1316, ram: 272 });
});

test('rejects unrecognized text with E_MAP_PARSE plus a snippet', () => {
  const r = parseMap('hello world\nnot a map file\nthird line\n');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_MAP_PARSE');
  assert.match(r.error.message, /unrecognized MAP format/i);
  assert.match(r.error.snippet, /hello world/);
});

test('unreadable path and empty input return structured errors', (t) => {
  const dir = makeTmp(t);
  const missing = parseMap(`${dir}/nope.map`);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_MAP_PARSE');
  assert.match(missing.error.message, /cannot read MAP file/i);

  const empty = parseMap('');
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'E_INVALID_ARG');
});

test('refuses MAP data larger than 64 MB before parsing', () => {
  const big = Buffer.alloc(MAX_MAP_BYTES + 1);
  const r = parseMap(big);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_MAP_PARSE');
  assert.match(r.error.message, /too large/i);
});

test('honors a stricter maxBytes override', () => {
  const r = parseMap(gnuMapText(), { maxBytes: 64 });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /too large/i);
});
