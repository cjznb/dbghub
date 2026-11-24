/**
 * Integration checks against the real P01_WindSensor_Val RelWithDebInfo build
 * (ARM Cortex-M3 FreeRTOS firmware, ELF + GNU ld MAP). The .hw tree is a
 * git-ignored read-only copy; when it is absent these tests skip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseElf, readElfSymbols } from '../../src/symbols/elf.mjs';
import { parseMap } from '../../src/symbols/map.mjs';
import { loadSymbols } from '../../src/symbols/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HW = path.join(repoRoot, '.hw', 'P01_WindSensor_Val');
const BUILD = path.join(HW, 'build', 'RelWithDebInfo');
const ELF = path.join(BUILD, 'P01_WindSensor_Val.elf');
const MAP = path.join(BUILD, 'P01_WindSensor_Val.map');
const BUILD_SOURCE_PREFIX = 'D:/projects/f103/zxw/P01_WindSensor_Val';

const available = fs.existsSync(ELF) && fs.existsSync(MAP);

function skipIfMissing(t) {
  if (!available) {
    t.skip('.hw/P01_WindSensor_Val sample not present; skipping real-firmware integration test');
    return true;
  }
  return false;
}

test('real ELF: ARM Cortex-M3, DWARF5, symtab, exact .text layout', (t) => {
  if (skipIfMissing(t)) return;
  const r = parseElf(ELF);
  assert.equal(r.ok, true);
  assert.equal(r.arch, 'arm');
  assert.equal(r.endian, 'little');
  assert.equal(r.elfClass, 32);
  assert.equal(r.type, 'exec');
  assert.equal(r.hasDebug, true);
  assert.equal(r.hasSymtab, true);
  assert.equal(r.dwarfVersion, 5);
  // This build was produced without --build-id, so no .note.gnu.build-id.
  assert.equal(r.buildId, undefined);
  assert.ok(r.entry >= 0x08000000 && r.entry < 0x08010000);
  assert.deepEqual(r.textSection, { addr: 0x0800010c, size: 0x93c8 });
  const text = r.sections.find((s) => s.name === '.text');
  assert.deepEqual(text, { name: '.text', addr: 0x0800010c, size: 0x93c8 });
  assert.ok(r.sections.some((s) => s.name === '.debug_info'));

  const syms = readElfSymbols(ELF);
  assert.equal(syms.ok, true);
  assert.ok(syms.count >= 1200, `expected >=1200 defined symbols, got ${syms.count}`);
  const main = syms.symbols.find((s) => s.name === 'main');
  assert.ok(main, 'main symbol present');
  assert.ok(main.addr > 0x08000000);
});

test('real MAP: GNU ld format with matching .text address', (t) => {
  if (skipIfMissing(t)) return;
  const r = parseMap(MAP);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'gnu');
  assert.ok(r.sections.length >= 20, `sections: ${r.sections.length}`);
  assert.ok(r.symbols.length >= 300, `symbols: ${r.symbols.length}`);
  assert.ok(r.totals);
  assert.ok(r.totals.text >= 0x94c8 - 0x100);
  const text = r.sections.find((s) => s.name === '.text');
  assert.deepEqual(text, { name: '.text', addr: 0x0800010c, size: 0x93c8 });
  const main = r.symbols.find((s) => s.name === 'main');
  assert.equal(main.addr, 0x0800383c);
  assert.ok(r.symbols.some((s) => s.name === 'xTaskCreate'));
});

test('real loadSymbols: summary, ELF<->MAP addr_match, lookups and source_map', async (t) => {
  if (skipIfMissing(t)) return;
  const r = await loadSymbols({
    program: ELF,
    symbols: [MAP],
    sourceMap: [[BUILD_SOURCE_PREFIX, HW]],
    cwd: repoRoot,
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.sources.length, 2);
  const elfSrc = r.summary.sources.find((s) => s.kind === 'elf');
  assert.equal(elfSrc.arch, 'arm');
  assert.equal(elfSrc.dwarf, '5');
  assert.equal(elfSrc.src, true);
  assert.ok(elfSrc.syms >= 1200);
  const mapSrc = r.summary.sources.find((s) => s.kind === 'map');
  assert.equal(mapSrc.addr_match, true);
  assert.ok(mapSrc.syms >= 300);
  assert.ok(!r.summary.warnings.some((w) => /address mismatch/i.test(w)));

  const byName = r.lookup('main');
  assert.equal(byName.ok, true);
  assert.equal(byName.source, 'elf');
  assert.equal(byName.addr, 0x0800383c); // Thumb bit stripped
  const byAddr = r.lookup('0x0800383c');
  assert.equal(byAddr.ok, true);
  assert.equal(byAddr.name, 'main');
  assert.equal(byAddr.exact, true);

  const realSource = `${BUILD_SOURCE_PREFIX}/App/app_main.c`;
  const localSource = path.join(HW, 'App', 'app_main.c');
  assert.equal(r.resolvePath(realSource), localSource.replace(/\\/g, '/'));
  if (fs.existsSync(localSource)) {
    const src = r.sourceLines(realSource, 5, 2);
    assert.equal(src.ok, true);
    assert.equal(src.from, 3);
    assert.equal(src.lines.length, 5);
    assert.equal(src.path, localSource.replace(/\\/g, '/'));
    assert.ok(src.lines.every((line) => typeof line === 'string'));
  }
});
