/**
 * ELF parser edge-case tests. Synthetic fixtures only: the real P01 sample is
 * covered by real-sample.test.mjs (skipped when .hw is absent).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildElfFixture, makeTmp, writeTmp } from './helpers.mjs';
import { parseElf, parseElfBuffer, readElfSymbols } from '../../src/symbols/elf.mjs';

test('parses synthetic ELF32 little-endian ARM image', (t) => {
  const dir = makeTmp(t);
  const { buffer, layout } = buildElfFixture({ buildId: 'decafbad00112233' });
  const file = writeTmp(dir, 'fw.elf', buffer);
  const r = parseElf(file);
  assert.equal(r.ok, true);
  assert.equal(r.path, file);
  assert.equal(r.arch, 'arm');
  assert.equal(r.endian, 'little');
  assert.equal(r.elfClass, 32);
  assert.equal(r.type, 'exec');
  assert.equal(r.dwarfVersion, 5);
  assert.equal(r.hasDebug, true);
  assert.equal(r.hasSymtab, true);
  assert.equal(r.buildId, 'decafbad00112233');
  assert.equal(r.entry, 0x08000101);
  assert.deepEqual(r.textSection, { addr: layout.textAddr, size: layout.textSize });
  const text = r.sections.find((s) => s.name === '.text');
  assert.deepEqual(text, { name: '.text', addr: layout.textAddr, size: layout.textSize });
  const bss = r.sections.find((s) => s.name === '.bss');
  assert.deepEqual(bss, { name: '.bss', addr: 0x20000010, size: 0x40 });
  assert.ok(r.sections.some((s) => s.name === '.debug_info'));
});

test('parses synthetic ELF64 big-endian AArch64 image', () => {
  const { buffer, layout } = buildElfFixture({
    bits: 64,
    little: false,
    machine: 183,
    type: 3,
    entry: 0x400000,
    textAddr: 0x400000,
    textSize: 0x200,
    buildId: '0011223344556677',
  });
  const r = parseElfBuffer(buffer, 'aarch64.elf');
  assert.equal(r.ok, true);
  assert.equal(r.arch, 'aarch64');
  assert.equal(r.endian, 'big');
  assert.equal(r.elfClass, 64);
  assert.equal(r.type, 'dyn');
  assert.equal(r.dwarfVersion, 5);
  assert.equal(r.buildId, '0011223344556677');
  assert.deepEqual(r.textSection, { addr: layout.textAddr, size: layout.textSize });
});

test('reads ELF symbol tables (defined symbols only, raw Thumb st_value)', () => {
  const { buffer, layout } = buildElfFixture();
  const r = readElfSymbols(buffer, { path: 'fw.elf' });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'fw.elf');
  assert.equal(r.count, 3);
  assert.equal(r.truncated, false);
  const main = r.symbols.find((s) => s.name === 'main');
  assert.equal(main.addr, layout.textAddr + 1); // Thumb bit preserved in ELF st_value
  assert.equal(main.size, 0x20);
  assert.equal(main.type, 'func');
  assert.equal(main.bind, 'global');
  assert.equal(main.section, '.text');
  const g = r.symbols.find((s) => s.name === 'g_value');
  assert.equal(g.type, 'object');
  assert.equal(g.addr, 0x20000000);
});

test('handles 64-bit DWARF initial length', () => {
  const { buffer } = buildElfFixture({ dwarf64: true });
  const r = parseElfBuffer(buffer);
  assert.equal(r.ok, true);
  assert.equal(r.dwarfVersion, 5);
});

test('missing file is E_SYMBOL_NOT_FOUND, bad magic is E_SYMBOL_PARSE (no throw)', (t) => {
  const dir = makeTmp(t);
  const missing = parseElf(`${dir}/nope.elf`);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_SYMBOL_NOT_FOUND');

  assert.doesNotThrow(() => parseElfBuffer(Buffer.from('this is not an ELF file at all')));
  const bad = parseElfBuffer(Buffer.from('this is not an ELF file at all', 'latin1'));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_SYMBOL_PARSE');
  assert.match(bad.error.message, /bad ELF magic/i);
});

test('rejects truncated headers and unknown class/endianness', () => {
  const { buffer } = buildElfFixture();
  const short = parseElfBuffer(buffer.subarray(0, 10));
  assert.equal(short.ok, false);
  assert.equal(short.error.code, 'E_SYMBOL_PARSE');

  const truncatedHeader = parseElfBuffer(buffer.subarray(0, 30));
  assert.equal(truncatedHeader.ok, false);

  const badClass = Buffer.from(buffer);
  badClass[4] = 3;
  const c = parseElfBuffer(badClass);
  assert.equal(c.ok, false);
  assert.match(c.error.message, /ELF class/i);

  const badEndian = Buffer.from(buffer);
  badEndian[5] = 0;
  const e = parseElfBuffer(badEndian);
  assert.equal(e.ok, false);
  assert.match(e.error.message, /data encoding/i);
});

test('rejects out-of-range section header table and section name table index', () => {
  const { buffer, layout } = buildElfFixture();
  const badShoff = Buffer.from(buffer);
  badShoff.writeUInt32LE(buffer.length - 4, 0x20);
  const a = parseElfBuffer(badShoff);
  assert.equal(a.ok, false);
  assert.equal(a.error.code, 'E_SYMBOL_PARSE');
  assert.match(a.error.message, /out of bounds|section header/i);

  const badNames = Buffer.from(buffer);
  badNames.writeUInt16LE(999, 0x32); // e_shstrndx (ELF32)
  const b = parseElfBuffer(badNames);
  assert.equal(b.ok, false);
  assert.match(b.error.message, /name table index/i);
  assert.ok(layout.shstrndx > 0);
});

test('out-of-range section name offset degrades to an empty name without crashing', () => {
  const { buffer, layout } = buildElfFixture();
  const patched = Buffer.from(buffer);
  // .text is section #1; overwrite its sh_name with an offset past .shstrtab.
  patched.writeUInt32LE(0xffff, layout.shoff + layout.shentsize);
  const r = parseElfBuffer(patched);
  assert.equal(r.ok, true);
  assert.equal(r.sections.find((s) => s.name === '.text'), undefined);
  // Executable fallback still finds .text by flags, so textSection survives.
  assert.deepEqual(r.textSection, { addr: layout.textAddr, size: layout.textSize });
});

test('ELF without section headers is ok but symbol-less', () => {
  const { buffer } = buildElfFixture();
  const noSections = Buffer.from(buffer);
  noSections.writeUInt32LE(0, 0x20); // e_shoff
  noSections.writeUInt16LE(0, 0x30); // e_shnum
  noSections.writeUInt16LE(0, 0x32); // e_shstrndx
  const r = parseElfBuffer(noSections);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sections, []);
  assert.equal(r.hasDebug, false);
  assert.equal(r.hasSymtab, false);
  assert.equal(r.textSection, undefined);
  assert.equal(r.dwarfVersion, undefined);
  assert.equal(r.buildId, undefined);
});

test('handles extended section numbering (e_shnum=0, e_shstrndx=SHN_XINDEX)', () => {
  const { buffer, layout } = buildElfFixture();
  const extended = Buffer.from(buffer);
  extended.writeUInt16LE(0, 0x30); // e_shnum -> real count in section #0 sh_size
  extended.writeUInt16LE(0xffff, 0x32); // e_shstrndx -> real index in section #0 sh_link
  extended.writeUInt32LE(layout.shnum, layout.shoff + 20); // sh_size of section #0
  extended.writeUInt32LE(layout.shstrndx, layout.shoff + 24); // sh_link of section #0
  const r = parseElfBuffer(extended);
  assert.equal(r.ok, true);
  assert.equal(r.sections.length, layout.sectionNames.length);
  assert.ok(r.sections.some((s) => s.name === '.text'));
  assert.equal(r.dwarfVersion, 5);
});

test('NOBITS section with a large in-memory size does not require file bytes', () => {
  const { buffer } = buildElfFixture({
    nobits: [{ name: '.bss', addr: 0x20000000, size: 0x100000 }],
  });
  const r = parseElfBuffer(buffer);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sections.find((s) => s.name === '.bss'), { name: '.bss', addr: 0x20000000, size: 0x100000 });
});

test('readElfSymbols on garbage never throws and reports E_SYMBOL_PARSE', () => {
  assert.doesNotThrow(() => readElfSymbols(Buffer.alloc(13)));
  const r = readElfSymbols(Buffer.alloc(13));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_SYMBOL_PARSE');
});
