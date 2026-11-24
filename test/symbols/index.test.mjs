/**
 * Symbol index tests (src/symbols/index.mjs): summary shape, ELF<->MAP address
 * cross-check, lookup fallback, source_map rewriting and sourceLines.
 *
 * All fixtures are synthetic; real-sample.test.mjs covers the P01 firmware.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildElfFixture, gnuMapText, makeTmp, writeTmp } from './helpers.mjs';
import { loadSymbols } from '../../src/symbols/index.mjs';

const TEXT_ADDR = 0x08000100;
const DATA_ADDR = 0x20000000;
const BSS_ADDR = 0x20000010;

function buildPair(t) {
  const dir = makeTmp(t);
  const { buffer, layout } = buildElfFixture({
    textAddr: TEXT_ADDR,
    textSize: 0x100,
    extraSections: [
      { name: '.isr_vector', addr: 0x08000000, data: Buffer.alloc(0x100, 0x11), flags: 2 },
      { name: '.data', addr: DATA_ADDR, data: Buffer.alloc(0x10, 0x22), flags: 3 },
    ],
    nobits: [{ name: '.bss', addr: BSS_ADDR, size: 0x20 }],
  });
  const elfPath = writeTmp(dir, 'fw.elf', buffer);
  const mapPath = writeTmp(
    dir,
    'fw.map',
    gnuMapText({
      textAddr: TEXT_ADDR,
      textSize: 0x100,
      dataAddr: DATA_ADDR,
      dataSize: 0x10,
      bssAddr: BSS_ADDR,
      bssSize: 0x20,
      extraSymbols: [['map_only', 0x08000140]],
    }),
  );
  return { dir, elfPath, mapPath, layout };
}

test('loadSymbols returns a compact summary, not the symbol table', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const r = await loadSymbols({ program: elfPath, symbols: [mapPath], cwd: dir });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.summary.sources));
  assert.equal(r.summary.sources.length, 2);
  assert.equal(r.summary.symbols, undefined);

  const elfSrc = r.summary.sources.find((s) => s.kind === 'elf');
  assert.equal(elfSrc.path, elfPath);
  assert.equal(elfSrc.arch, 'arm');
  assert.equal(elfSrc.dwarf, '5');
  assert.equal(elfSrc.src, true);
  assert.equal(elfSrc.syms, 3);

  const mapSrc = r.summary.sources.find((s) => s.kind === 'map');
  assert.equal(mapSrc.path, mapPath);
  assert.ok(mapSrc.syms >= 5);
  assert.equal(mapSrc.addr_match, true);
  assert.ok(Array.isArray(r.summary.warnings));
  assert.equal(typeof r.lookup, 'function');
  assert.equal(typeof r.sourceLines, 'function');
  assert.equal(typeof r.resolvePath, 'function');
});

test('lookup resolves by name (ELF first, MAP fallback) and by address', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const r = await loadSymbols({ program: elfPath, symbols: [mapPath], cwd: dir });

  const byName = r.lookup('main');
  assert.equal(byName.ok, true);
  assert.equal(byName.match, 'name');
  assert.equal(byName.name, 'main');
  assert.equal(byName.addr, TEXT_ADDR); // Thumb bit stripped for callers
  assert.equal(byName.source, 'elf');
  assert.equal(byName.size, 0x20);

  const mapFallback = r.lookup('map_only');
  assert.equal(mapFallback.ok, true);
  assert.equal(mapFallback.source, 'map');
  assert.equal(mapFallback.addr, 0x08000140);

  const exact = r.lookup('0x08000120');
  assert.equal(exact.ok, true);
  assert.equal(exact.match, 'addr');
  assert.equal(exact.name, 'helper');
  assert.equal(exact.exact, true);

  const thumb = r.lookup('0x08000101'); // caller passes ELF-style odd address
  assert.equal(thumb.ok, true);
  assert.equal(thumb.name, 'main');
  assert.equal(thumb.exact, true);

  const inside = r.lookup('0x08000110');
  assert.equal(inside.ok, true);
  assert.equal(inside.name, 'main');
  assert.equal(inside.offset, 0x10);
  assert.equal(inside.contains, true);
  assert.equal(inside.exact, false);

  const object = r.lookup(0x20000000);
  assert.equal(object.ok, true);
  assert.equal(object.name, 'g_value');

  const nearest = r.lookup('0x080001ff');
  assert.equal(nearest.ok, true);
  assert.equal(nearest.name, 'map_only');
  assert.equal(nearest.exact, false);

  const missing = r.lookup('no_such_symbol');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_SYMBOL_NOT_FOUND');

  const below = r.lookup(0x10);
  assert.equal(below.ok, false);
  assert.equal(below.error.code, 'E_SYMBOL_NOT_FOUND');
});

test('source_map rewrites paths and sourceLines returns a small window', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const buildDir = path.join(dir, 'build');
  const srcDir = path.join(dir, 'src');
  const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  writeTmp(dir, 'src/main.c', content);

  const r = await loadSymbols({
    program: elfPath,
    symbols: [mapPath],
    source_map: [[buildDir, srcDir], [String.raw`C:\old\proj`, srcDir]],
    cwd: dir,
  });
  assert.equal(r.ok, true);

  const expected = path.join(srcDir, 'main.c').replace(/\\/g, '/');
  assert.equal(r.resolvePath(path.join(buildDir, 'main.c')), expected);
  assert.equal(r.resolvePath(String.raw`C:\old\proj\main.c`), expected);
  // Unmapped relative paths fall back to cwd.
  assert.equal(r.resolvePath('src/main.c'), expected);

  const win = r.sourceLines(path.join(buildDir, 'main.c'), 5, 2);
  assert.equal(win.ok, true);
  assert.equal(win.from, 3);
  assert.equal(win.line, 5);
  assert.deepEqual(win.lines, ['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
  assert.equal(win.path, expected);

  const defaultCtx = r.sourceLines(path.join(buildDir, 'main.c'), 1);
  assert.equal(defaultCtx.ok, true);
  assert.equal(defaultCtx.from, 1);
  assert.deepEqual(defaultCtx.lines, ['line 1', 'line 2', 'line 3']);

  const missing = r.sourceLines(path.join(buildDir, 'nope.c'), 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_SYMBOL_NOT_FOUND');

  const pastEof = r.sourceLines(path.join(buildDir, 'main.c'), 99, 1);
  assert.equal(pastEof.ok, false);
  assert.equal(pastEof.error.code, 'E_INVALID_ARG');
});

test('ELF<->MAP address mismatch warns by default and fails with strict', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const badMap = writeTmp(
    dir,
    'other.map',
    gnuMapText({
      textAddr: 0x09000100, // different build
      textSize: 0x100,
      dataAddr: DATA_ADDR,
      dataSize: 0x10,
      bssAddr: BSS_ADDR,
      bssSize: 0x20,
    }),
  );
  const loose = await loadSymbols({ program: elfPath, symbols: [mapPath, badMap], cwd: dir });
  assert.equal(loose.ok, true);
  assert.ok(loose.summary.warnings.some((w) => /address mismatch/i.test(w)));
  const badSrc = loose.summary.sources.find((s) => s.kind === 'map');
  const mapSources = loose.summary.sources.filter((s) => s.kind === 'map');
  assert.equal(mapSources.length, 2);
  assert.equal(mapSources[0].addr_match, true);
  assert.equal(mapSources[1].addr_match, false);
  assert.ok(badSrc);

  const strict = await loadSymbols({ program: elfPath, symbols: [mapPath, badMap], cwd: dir, strict: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.error.code, 'E_SYMBOL_MISMATCH');
});

test('hex program has no symbols of its own but accepts explicit symbol files', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const hexPath = writeTmp(dir, 'fw.hex', ':10000000000102030405060708090A0B0C0D0E0F78\n:00000001FF\n');
  const r = await loadSymbols({ program: hexPath, symbols: [elfPath, mapPath], cwd: dir });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.summary.sources.map((s) => s.kind),
    ['hex', 'elf', 'map'],
  );
  assert.ok(r.summary.warnings.some((w) => /raw HEX/i.test(w)));

  const alone = await loadSymbols({ program: hexPath, cwd: dir });
  assert.equal(alone.ok, true);
  assert.deepEqual(alone.summary.sources.map((s) => s.kind), ['hex']);
  assert.ok(alone.summary.warnings.some((w) => /no symbols/i.test(w)));
});

test('missing program / no inputs / stripped ELF without MAP return E_SYMBOL_NOT_FOUND or E_SYMBOL_NO_DEBUG', async (t) => {
  const { dir } = buildPair(t);
  const missing = await loadSymbols({ program: path.join(dir, 'nope.elf'), cwd: dir });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'E_SYMBOL_NOT_FOUND');

  const nothing = await loadSymbols({ cwd: dir });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.error.code, 'E_SYMBOL_NOT_FOUND');

  const stripped = buildElfFixture({ dwarfVersion: null, includeSymtab: false });
  const strippedPath = writeTmp(dir, 'nosymbols.elf', stripped.buffer);
  const noDebug = await loadSymbols({ program: strippedPath, cwd: dir });
  assert.equal(noDebug.ok, false);
  assert.equal(noDebug.error.code, 'E_SYMBOL_NO_DEBUG');
});

test('symbol_paths finds bare symbol filenames and companion files', async (t) => {
  const { dir, elfPath, mapPath } = buildPair(t);
  const elsewhere = makeTmp(t);
  const viaPaths = await loadSymbols({
    program: elfPath,
    symbols: ['fw.map'],
    symbol_paths: [dir],
    cwd: elsewhere,
  });
  assert.equal(viaPaths.ok, true);
  assert.ok(viaPaths.summary.warnings.some((w) => /resolved symbol file/i.test(w)));
  assert.equal(viaPaths.summary.sources.filter((s) => s.kind === 'map').length, 1);

  // Stripped ELF + sibling .map discovered from symbol_paths.
  const autoDir = makeTmp(t);
  const stripped = buildElfFixture({ dwarfVersion: null, includeSymtab: false, textSize: 0x100 });
  writeTmp(autoDir, 'stripped.elf', stripped.buffer);
  writeTmp(
    autoDir,
    'stripped.map',
    gnuMapText({ textAddr: TEXT_ADDR, textSize: 0x100, dataAddr: DATA_ADDR, dataSize: 0x10, bssAddr: BSS_ADDR, bssSize: 0x20 }),
  );
  const auto = await loadSymbols({
    program: path.join(autoDir, 'stripped.elf'),
    symbolPaths: [autoDir],
    cwd: autoDir,
  });
  assert.equal(auto.ok, true);
  assert.ok(auto.summary.warnings.some((w) => /auto-discovered/i.test(w)));
  const kinds = auto.summary.sources.map((s) => s.kind);
  assert.deepEqual(kinds, ['elf', 'map']);
});

test('loadSymbols never throws on malformed inputs', async (t) => {
  const dir = makeTmp(t);
  const junk = writeTmp(dir, 'junk.bin', Buffer.from([1, 2, 3, 4, 5]));
  const a = await loadSymbols({ program: junk, cwd: dir });
  assert.equal(a.ok, true); // raw bin: no symbols, but not a hard failure
  assert.ok(a.summary.warnings.some((w) => /raw BIN|no symbols/i.test(w)));

  const badElf = writeTmp(dir, 'bad.elf', Buffer.from('not an elf at all'));
  const b = await loadSymbols({ program: badElf, cwd: dir });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'E_SYMBOL_PARSE');

  const badMap = writeTmp(dir, 'bad.map', 'definitely not a linker map\nsecond line\n');
  const c = await loadSymbols({
    program: path.join(dir, 'missing-program.elf'),
    symbols: [badMap],
    cwd: dir,
  });
  assert.equal(c.ok, false);
  assert.equal(c.error.code, 'E_SYMBOL_NOT_FOUND');
});
