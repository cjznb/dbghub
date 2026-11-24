/**
 * Symbol/image index for dbghub: turns `open(program, symbols, symbol_paths,
 * source_map)` arguments into one compact summary plus three query helpers.
 *
 * Public API (docs/dev-interfaces.md section B):
 *
 *   await loadSymbols({ program, symbols, symbolPaths, sourceMap, session, cwd,
 *                       strict = false }) ->
 *     { ok:true, summary:{sources:[...],warnings:[]},
 *       lookup(nameOrAddr), sourceLines(file,line,ctx), resolvePath(file) }
 *   | { ok:false, error:{code,message,hint?} }
 *
 * Design rules honored here (docs/design.md §5.5):
 *  - never return the whole symbol table to the agent (only a summary; lookups
 *    are single-symbol queries with a small result);
 *  - ELF/AXF is primary (arch/DWARF/build-id), MAP is the fallback index;
 *  - ELF <-> MAP addresses are cross-checked and mismatches are warnings (never
 *    silent), or E_SYMBOL_MISMATCH when `strict` is set;
 *  - hex/bin images carry no symbols themselves, so `symbols` must supplement
 *    them (otherwise a warning is returned, not a hard failure);
 *  - `sourceMap` rewrites DWARF/Keil absolute paths to local paths;
 *  - large/unreadable/malformed inputs degrade to warnings whenever possible.
 *
 * This module never throws; failures are `{ok:false,error}` objects.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseElfBuffer, readElfSymbols, MAX_ELF_BYTES } from './elf.mjs';
import { parseMap } from './map.mjs';

const MAX_INDEX_SYMBOLS = 1_000_000;
const MAX_WARNINGS = 40;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CACHE = 32;
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const ELF_EXT_KINDS = { '.elf': 'elf', '.axf': 'axf', '.out': 'elf', '.so': 'elf', '.o': 'elf' };

function failure(code, message, hint = '') {
  const error = { code, message };
  if (hint) error.hint = hint;
  return { ok: false, error };
}

function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(s);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/** Resolve a user-supplied path against cwd; returns { resolved, error? }. */
function resolveInput(p, baseCwd) {
  const raw = String(p ?? '').trim();
  if (!raw) return { error: failure('E_INVALID_ARG', 'empty path', 'pass a non-empty file path') };
  if (hasControlChars(raw)) {
    return failure('E_INVALID_ARG', 'path contains NUL/control characters', 'pass a clean filesystem path');
  }
  const expanded = expandHome(raw);
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseCwd, expanded);
  return { resolved, raw };
}

/** Sniff the file type by magic/extension without parsing it. */
function sniffFile(resolvedPath) {
  const ext = path.extname(resolvedPath).toLowerCase();
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      head = head.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { kind: 'missing' };
  }
  if (head.length >= 4 && ELF_MAGIC.every((b, i) => head[i] === b)) {
    return { kind: ELF_EXT_KINDS[ext] || 'elf' };
  }
  const textHead = head.toString('latin1').replace(/^\uFEFF/, '').trimStart();
  if (textHead.startsWith(':')) return { kind: 'hex' };
  if (ext === '.hex' || ext === '.ihex') return { kind: 'hex' };
  if (ext === '.bin' || ext === '.img' || ext === '.raw') return { kind: 'bin' };
  if (ext === '.map') return { kind: 'map' };
  if (ELF_EXT_KINDS[ext]) return { kind: ELF_EXT_KINDS[ext] };
  if (ext === '.debug' || ext === '.dbg') return { kind: 'debug' };
  return { kind: 'unknown' };
}

/** Load and parse one ELF/AXF image (metadata + symbol table). */
function loadElf(resolvedPath, label) {
  let st;
  try {
    st = fs.statSync(resolvedPath);
  } catch (e) {
    return failure('E_SYMBOL_NOT_FOUND', `cannot read "${label}" (${e.code || e.message})`, 'check the path passed to open()');
  }
  if (!st.isFile()) return failure('E_SYMBOL_NOT_FOUND', `"${label}" is not a regular file`);
  if (st.size > MAX_ELF_BYTES) {
    return failure('E_SYMBOL_PARSE', `ELF file is too large (${st.size} bytes, limit ${MAX_ELF_BYTES})`);
  }
  let buf;
  try {
    buf = fs.readFileSync(resolvedPath);
  } catch (e) {
    return failure('E_SYMBOL_NOT_FOUND', `cannot read "${label}" (${e.code || e.message})`);
  }
  const meta = parseElfBuffer(buf, label);
  if (!meta.ok) return meta;
  const syms = readElfSymbols(buf, { path: label, maxSymbols: MAX_INDEX_SYMBOLS });
  return {
    ok: true,
    meta,
    symbols: syms.ok ? syms.symbols : [],
    symbolsTruncated: !!(syms.ok && syms.truncated),
    symbolsError: syms.ok ? null : syms.error,
  };
}

function normalizeSourceMap(sourceMap, warnings) {
  const pairs = [];
  if (!sourceMap) return pairs;
  const push = (from, to) => {
    const f = String(from ?? '');
    const t = String(to ?? '');
    if (!f || !t) {
      warnings.push('source_map entry ignored: both sides must be non-empty strings');
      return;
    }
    if (hasControlChars(f) || hasControlChars(t)) {
      warnings.push('source_map entry ignored: contains NUL/control characters');
      return;
    }
    pairs.push([toSlash(f).replace(/\/+$/, ''), toSlash(t).replace(/\/+$/, '')]);
  };
  if (Array.isArray(sourceMap)) {
    for (const entry of sourceMap) {
      if (Array.isArray(entry) && entry.length >= 2) push(entry[0], entry[1]);
      else if (entry && typeof entry === 'object' && 'from' in entry && 'to' in entry) push(entry.from, entry.to);
      else warnings.push('source_map entry ignored: expected [from, to] pair');
    }
  } else if (typeof sourceMap === 'object') {
    for (const [k, v] of Object.entries(sourceMap)) push(k, v);
  } else {
    warnings.push('source_map ignored: expected an array of [from, to] pairs');
  }
  return pairs;
}

function foldCase(s) {
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** Build the path rewriter + line reader used by callers. */
function createSourceHelpers(sourceMapPairs, baseCwd) {
  const cache = new Map();

  const resolvePath = (file) => {
    if (file == null || file === '') return '';
    const raw = String(file);
    let s = toSlash(raw);
    const folded = foldCase(s);
    for (const [from, to] of sourceMapPairs) {
      const f = foldCase(from);
      if (folded === f) {
        s = to;
        break;
      }
      if (folded.startsWith(f + '/')) {
        s = to + s.slice(from.length);
        break;
      }
    }
    if (!path.isAbsolute(s) && !/^[A-Za-z]:\//.test(s)) s = path.resolve(baseCwd, s).replace(/\\/g, '/');
    return s;
  };

  const sourceLines = (file, line, ctx = 2) => {
    const resolved = resolvePath(file);
    if (!resolved) return failure('E_INVALID_ARG', 'sourceLines needs a file path');
    const lineNo = Number.parseInt(String(line ?? ''), 10);
    if (!Number.isFinite(lineNo) || lineNo < 1) {
      return failure('E_INVALID_ARG', `invalid source line "${line}"`, 'pass a 1-based line number');
    }
    const span = Number.isFinite(Number(ctx)) ? Math.max(0, Math.min(200, Number(ctx))) : 2;
    let lines = cache.get(resolved);
    if (!lines) {
      let st;
      try {
        st = fs.statSync(resolved);
      } catch {
        return failure(
          'E_SYMBOL_NOT_FOUND',
          `source file not found: ${resolved}`,
          'pass source_map=[["<build path>","<local path>"]] or open the workspace that contains the sources',
        );
      }
      if (st.size > MAX_SOURCE_BYTES) {
        return failure('E_INVALID_ARG', `source file is too large (${st.size} bytes): ${resolved}`);
      }
      let text;
      try {
        text = fs.readFileSync(resolved, 'utf8');
      } catch (e) {
        return failure('E_SYMBOL_NOT_FOUND', `cannot read source file ${resolved} (${e.code || e.message})`);
      }
      lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      if (cache.size >= MAX_SOURCE_CACHE) cache.delete(cache.keys().next().value);
      cache.set(resolved, lines);
    }
    if (lineNo > lines.length) {
      return failure('E_INVALID_ARG', `line ${lineNo} is past end of file (${lines.length} lines): ${resolved}`);
    }
    const from = Math.max(1, lineNo - span);
    const to = Math.min(lines.length, lineNo + span);
    return { ok: true, path: resolved, line: lineNo, from, lines: lines.slice(from - 1, to) };
  };

  return { resolvePath, sourceLines };
}

/** Pick the "best" symbol for an address bucket (ELF over MAP, funcs over data). */
function betterEntry(a, b) {
  const score = (e) => {
    let s = 0;
    if (e.source === 'elf') s += 4;
    if (e.type === 'func') s += 2;
    else if (e.type === 'object') s += 1;
    if (e.size > 0) s += 2;
    return s;
  };
  return score(a) >= score(b) ? a : b;
}

function parseAddressQuery(q) {
  if (typeof q === 'number' && Number.isFinite(q) && q >= 0) return q;
  if (typeof q !== 'string') return null;
  const s = q.trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s.slice(2), 16);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

function buildIndex(elfSources, mapSources) {
  const nameIndex = new Map();
  const addrBuckets = new Map();
  const warnings = [];
  let count = 0;
  let truncated = false;

  const add = (entry) => {
    if (count >= MAX_INDEX_SYMBOLS) {
      truncated = true;
      return;
    }
    count++;
    if (!nameIndex.has(entry.name)) nameIndex.set(entry.name, entry);
    const prev = addrBuckets.get(entry.addr);
    addrBuckets.set(entry.addr, prev ? betterEntry(prev, entry) : entry);
  };

  for (const src of elfSources) {
    const arm = src.meta.arch === 'arm';
    for (const s of src.symbols) {
      let addr = s.addr;
      // Thumb function addresses carry bit0 set in ELF st_value; MAP/GDB use the
      // even instruction address, so normalize before indexing/looking up.
      if (arm && (addr & 1) && (s.type === 'func' || s.type === 'notype')) addr -= 1;
      const entry = { name: s.name, addr, size: s.size || 0, source: 'elf' };
      if (s.type === 'func' || s.type === 'object' || s.type === 'notype') entry.type = s.type;
      if (s.section) entry.section = s.section;
      add(entry);
    }
  }
  for (const src of mapSources) {
    const arm = elfSources.some((e) => e.meta.arch === 'arm');
    for (const s of src.parsed.symbols) {
      let addr = s.addr;
      if (arm && (addr & 1)) addr -= 1;
      const entry = { name: s.name, addr, size: s.size || 0, source: 'map' };
      if (s.object) entry.object = s.object;
      add(entry);
    }
  }
  if (truncated) warnings.push(`symbol index truncated at ${MAX_INDEX_SYMBOLS} entries`);
  const addrList = [...addrBuckets.values()].sort((a, b) => a.addr - b.addr);

  const lookup = (nameOrAddr) => {
    if (nameOrAddr == null || nameOrAddr === '') {
      return failure('E_INVALID_ARG', 'lookup needs a symbol name or an address');
    }
    const asAddr = parseAddressQuery(nameOrAddr);
    const wantAddr = asAddr != null;
    const arm = elfSources.some((e) => e.meta.arch === 'arm');
    if (!wantAddr) {
      const name = String(nameOrAddr).trim();
      const hit = nameIndex.get(name);
      if (!hit) {
        return failure(
          'E_SYMBOL_NOT_FOUND',
          `symbol "${name}" not found`,
          'check spelling; MAP files only contain global symbols (locals need DWARF/ELF)',
        );
      }
      const out = { ok: true, match: 'name', name: hit.name, addr: hit.addr, source: hit.source };
      if (hit.size > 0) out.size = hit.size;
      if (hit.object) out.object = hit.object;
      if (hit.section) out.section = hit.section;
      return out;
    }
    let target = asAddr;
    if (arm && (target & 1)) target -= 1;
    let hit = addrBuckets.get(target);
    let exact = !!hit;
    if (!hit && addrList.length > 0) {
      // Nearest preceding symbol: enough for "which function is 0x... in?" even
      // when MAP has no sizes.
      let lo = 0;
      let hi = addrList.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (addrList[mid].addr <= target) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best >= 0) hit = addrList[best];
    }
    if (!hit) {
      return failure(
        'E_SYMBOL_NOT_FOUND',
        `no symbol at or below address 0x${target.toString(16)}`,
        'the address may be outside the loaded image; check the program/symbols paths',
      );
    }
    const offset = target - hit.addr;
    const contains = hit.size > 0 && offset >= 0 && offset < hit.size;
    const out = {
      ok: true,
      match: 'addr',
      name: hit.name,
      addr: hit.addr,
      source: hit.source,
      offset,
      exact,
    };
    if (hit.size > 0) out.size = hit.size;
    if (hit.object) out.object = hit.object;
    if (hit.section) out.section = hit.section;
    if (contains) out.contains = true;
    return out;
  };

  return { lookup, warnings };
}

/** Normalize a `symbols`/`symbol_paths` option that may be omitted or a scalar. */
function asPathList(value, name, warnings) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim());
  warnings.push(`${name} ignored: expected a string or an array of strings`);
  return [];
}

/** Parse one explicit symbol source (MAP or ELF); returns a source record or an error. */
function loadSymbolSource(rawPath, baseCwd, prefixWarnings) {
  const resolvedInfo = resolveInput(rawPath, baseCwd);
  if (resolvedInfo.error) return { error: resolvedInfo.error };
  const resolved = resolvedInfo.resolved;
  if (!isFile(resolved)) {
    return {
      error: failure('E_SYMBOL_NOT_FOUND', `symbol file not found: ${String(rawPath)}`, 'check the path or symbol_paths options'),
    };
  }
  const label = String(rawPath);
  const sniff = sniffFile(resolved);
  if (sniff.kind === 'map' || sniff.kind === 'unknown') {
    const parsed = parseMap(resolved);
    if (parsed.ok) return { kind: 'map', label, resolved, parsed };
    if (sniff.kind === 'map') return { error: parsed.error };
    prefixWarnings.push(`symbol file "${label}" skipped: ${parsed.error.message}`);
    return { error: null, skipped: true };
  }
  if (sniff.kind === 'hex' || sniff.kind === 'bin') {
    prefixWarnings.push(`symbol file "${label}" skipped: hex/bin images contain no symbols`);
    return { error: null, skipped: true };
  }
  const loaded = loadElf(resolved, label);
  if (!loaded.ok) return { error: loaded.error };
  const kind = sniff.kind === 'axf' ? 'axf' : sniff.kind === 'debug' ? 'debug' : 'elf';
  return { kind, label, resolved, loaded };
}

function elfSourceSummary(kind, label, loaded) {
  const src = { path: label, kind, arch: loaded.meta.arch };
  if (loaded.meta.dwarfVersion !== undefined) src.dwarf = String(loaded.meta.dwarfVersion);
  src.syms = loaded.symbols.length;
  if (loaded.meta.hasDebug) src.src = true;
  return src;
}

/**
 * Load symbols for a debug session.
 *
 * @param {object} args
 * @param {string} [args.program] executable/image path (.elf/.axf/.hex/.bin)
 * @param {string[]} [args.symbols] extra symbol files (.map/.elf/.axf/.debug)
 * @param {string[]} [args.symbolPaths] directories to search for companion symbols
 * @param {Array<[string,string]>|object} [args.sourceMap] source path rewrites
 * @param {object} [args.session] optional session (uses `workspace`/`arch` hints)
 * @param {string} [args.cwd] base directory for relative paths
 * @param {boolean} [args.strict] turn ELF/MAP address mismatches into E_SYMBOL_MISMATCH
 */
export async function loadSymbols(args = {}) {
  const {
    program,
    symbols = [],
    symbolPaths,
    symbol_paths,
    sourceMap,
    source_map,
    session = null,
    cwd = null,
    strict = false,
  } = args || {};

  // Accept both the JS API spelling (camelCase) and the MCP/open() argument
  // spelling (snake_case) so the daemon can forward raw tool args.
  const symbolPathsInput = symbolPaths ?? symbol_paths ?? [];
  const sourceMapInput = sourceMap ?? source_map ?? [];

  const warnings = [];
  const addWarning = (w) => {
    if (warnings.length >= MAX_WARNINGS) {
      if (warnings.length === MAX_WARNINGS) warnings.push('more warnings truncated');
      return;
    }
    warnings.push(String(w));
  };

  const baseCwd = cwd || (session && typeof session.workspace === 'string' ? session.workspace : null) || process.cwd();
  const sourceMapPairs = normalizeSourceMap(sourceMapInput, warnings);
  const { resolvePath, sourceLines } = createSourceHelpers(sourceMapPairs, baseCwd);
  const symbolPathList = asPathList(symbolPathsInput, 'symbol_paths', warnings);

  if (program != null && typeof program !== 'string') {
    return failure('E_INVALID_ARG', 'program must be a file path string', 'pass program: "build/fw.elf"');
  }
  if (!program && asPathList(symbols, 'symbols', warnings).length === 0) {
    return failure(
      'E_SYMBOL_NOT_FOUND',
      'no program or symbol file was provided',
      'pass program: "build/fw.elf" and/or symbols: ["build/fw.map"]',
    );
  }

  const elfSources = [];
  const mapSources = [];
  const summarySources = [];
  const loadedPaths = new Set();
  const programLabel = program ? String(program) : null;
  let programKind = null;
  let programElf = null;

  // ---- program ------------------------------------------------------------
  if (program) {
    const info = resolveInput(program, baseCwd);
    if (info.error) return info.error;
    if (!isFile(info.resolved)) {
      return failure('E_SYMBOL_NOT_FOUND', `program not found: ${program}`, 'check cwd/symbol_paths and the build output path');
    }
    programKind = sniffFile(info.resolved).kind;
    if (programKind === 'missing') {
      return failure('E_SYMBOL_NOT_FOUND', `program not found: ${program}`);
    }
    if (programKind === 'map') {
      const parsed = parseMap(info.resolved);
      if (!parsed.ok) return parsed;
      mapSources.push({ label: programLabel, resolved: info.resolved, parsed });
      summarySources.push({ path: programLabel, kind: 'map', syms: parsed.symbols.length });
      loadedPaths.add(info.resolved);
    } else if (programKind === 'hex' || programKind === 'bin') {
      summarySources.push({ path: programLabel, kind: programKind });
      addWarning(
        `program "${program}" is a raw ${programKind.toUpperCase()} image and has no symbols; pass symbols: ["build/fw.elf", "build/fw.map"] for function names`,
      );
    } else {
      const loaded = loadElf(info.resolved, programLabel);
      if (!loaded.ok) return loaded;
      programElf = loaded;
      const kind = programKind === 'axf' ? 'axf' : programKind === 'debug' ? 'debug' : 'elf';
      elfSources.push({ label: programLabel, resolved: info.resolved, meta: loaded.meta, symbols: loaded.symbols, kind });
      summarySources.push(elfSourceSummary(kind, programLabel, loaded));
      loadedPaths.add(info.resolved);
      if (loaded.symbolsError) {
        addWarning(`symbol table of "${program}" could not be read: ${loaded.symbolsError.message}`);
      }
      if (!loaded.meta.hasDebug) {
        addWarning(`program "${program}" has no DWARF debug info (source lines/variables unavailable)`);
      }
    }
  }

  // ---- explicit symbol files ---------------------------------------------
  const symbolArgs = asPathList(symbols, 'symbols', warnings);
  for (const raw of symbolArgs) {
    let src = loadSymbolSource(raw, baseCwd, warnings);
    if (src.error && symbolPathList.length > 0 && !path.isAbsolute(raw)) {
      // Bare filename: search the explicit symbol_paths before giving up (the
      // common "pass build/debug" workflow).
      for (const dir of symbolPathList) {
        const dirInfo = resolveInput(dir, baseCwd);
        if (dirInfo.error) continue;
        const candidate = path.join(dirInfo.resolved, raw);
        if (!isFile(candidate)) continue;
        const retry = loadSymbolSource(candidate, baseCwd, warnings);
        if (retry.error) continue;
        addWarning(`resolved symbol file "${raw}" via symbol_paths to "${candidate}"`);
        src = retry;
        break;
      }
    }
    if (src.error) {
      addWarning(`symbol file "${raw}" skipped: ${src.error.message}`);
      continue;
    }
    if (!src || src.skipped) continue;
    if (loadedPaths.has(src.resolved)) {
      addWarning(`duplicate symbol file ignored: ${raw}`);
      continue;
    }
    loadedPaths.add(src.resolved);
    if (src.kind === 'map') {
      mapSources.push({ label: src.label, resolved: src.resolved, parsed: src.parsed });
      summarySources.push({ path: src.label, kind: 'map', syms: src.parsed.symbols.length });
    } else {
      elfSources.push({
        label: src.label,
        resolved: src.resolved,
        meta: src.loaded.meta,
        symbols: src.loaded.symbols,
        kind: src.kind,
      });
      summarySources.push(elfSourceSummary(src.kind, src.label, src.loaded));
      if (!src.loaded.meta.hasDebug) {
        addWarning(`symbol file "${raw}" has no DWARF debug info (MAP-level symbols only)`);
      }
    }
  }

  // ---- companion-symbol search (stripped ELF / hex / bin) ------------------
  const wantsCompanion =
    symbolPathList.length > 0 &&
    (programKind === 'hex' || programKind === 'bin' || (programElf && !programElf.meta.hasDebug));
  if (wantsCompanion && program) {
    const programResolved = resolveInput(program, baseCwd).resolved;
    const base = path.basename(programResolved, path.extname(programResolved));
    const candidates = [`${base}.debug`, `${base}.elf`, `${base}.axf`, `${base}.map`, `${base}.dbg`];
    for (const dir of symbolPathList) {
      const dirInfo = resolveInput(dir, baseCwd);
      if (dirInfo.error) {
        addWarning(`symbol_paths entry "${dir}" ignored: ${dirInfo.error.message}`);
        continue;
      }
      let found = 0;
      for (const candidate of candidates) {
        const p = path.join(dirInfo.resolved, candidate);
        if (!isFile(p) || loadedPaths.has(p)) continue;
        const kind = sniffFile(p).kind;
        if (kind === 'map') {
          const parsed = parseMap(p);
          if (!parsed.ok) continue;
          loadedPaths.add(p);
          mapSources.push({ label: p, resolved: p, parsed, auto: true });
          summarySources.push({ path: p, kind: 'map', syms: parsed.symbols.length });
          addWarning(`auto-discovered MAP symbol file "${p}" from symbol_paths`);
          found++;
        } else if (kind !== 'hex' && kind !== 'bin' && kind !== 'unknown') {
          const loaded = loadElf(p, p);
          if (!loaded.ok) continue;
          loadedPaths.add(p);
          elfSources.push({ label: p, resolved: p, meta: loaded.meta, symbols: loaded.symbols, kind: kind === 'axf' ? 'axf' : 'elf' });
          summarySources.push(elfSourceSummary(kind === 'axf' ? 'axf' : 'elf', p, loaded));
          addWarning(`auto-discovered symbol file "${p}" from symbol_paths`);
          found++;
        }
        if (found > 0) break;
      }
      if (found > 0) break;
    }
  }

  // ---- architecture sanity (warning only: the target is still debuggable) --
  const sessionArch = session && (session.arch || (session.target && session.target.arch));
  if (programElf && sessionArch && typeof sessionArch === 'string') {
    const elfArch = programElf.meta.arch;
    if (elfArch !== 'unknown' && elfArch !== sessionArch) {
      addWarning(`ELF architecture "${elfArch}" does not match session target architecture "${sessionArch}"`);
    }
  }

  // ---- ELF <-> MAP address consistency ------------------------------------
  const mismatchDetails = [];
  if (mapSources.length > 0 && elfSources.length > 0) {
    for (const mapSrc of mapSources) {
      const mapById = new Map();
      for (const s of mapSrc.parsed.sections) if (s.addr > 0 && !mapById.has(s.name)) mapById.set(s.name, s);
      let compared = 0;
      const mismatches = [];
      for (const elfSrc of elfSources) {
        for (const sec of elfSrc.meta.sections) {
          if (!(sec.addr > 0)) continue;
          const m = mapById.get(sec.name);
          if (!m) continue;
          compared++;
          if (m.addr !== sec.addr) {
            mismatches.push({ name: sec.name, map: m.addr, elf: sec.addr, elfLabel: elfSrc.label, mapLabel: mapSrc.label });
          }
        }
      }
      const summary = summarySources.find((s) => s.kind === 'map' && s.path === mapSrc.label);
      if (compared === 0) {
        addWarning(`could not cross-check MAP "${mapSrc.label}" with ELF (no common allocated sections)`);
        continue;
      }
      if (mismatches.length === 0) {
        if (summary) summary.addr_match = true;
      } else {
        if (summary) summary.addr_match = false;
        for (const d of mismatches.slice(0, 5)) {
          const msg = `MAP/ELF section address mismatch for ${d.name}: map=0x${d.map.toString(16)} (${d.mapLabel}) vs elf=0x${d.elf.toString(16)} (${d.elfLabel})`;
          mismatchDetails.push(msg);
          addWarning(msg);
        }
        if (mismatches.length > 5) addWarning(`${mismatches.length - 5} more MAP/ELF section mismatches not shown`);
      }
    }
  }
  if (strict && mismatchDetails.length > 0) {
    return failure(
      'E_SYMBOL_MISMATCH',
      `MAP and ELF files do not describe the same build (${mismatchDetails.length} section address mismatches)`,
      'the .map and .elf were built at different times; pass the pair from one build directory',
    );
  }

  // ---- hard "no debug" cases ---------------------------------------------
  const anySymtab = elfSources.some((s) => s.meta.hasSymtab);
  const anyDebug = elfSources.some((s) => s.meta.hasDebug);
  const anyMap = mapSources.length > 0;
  if (programElf && !anyDebug && !anySymtab && !anyMap) {
    return failure(
      'E_SYMBOL_NO_DEBUG',
      `"${program}" has neither DWARF debug info nor a symbol table`,
      'pass symbols: ["build/fw.map"] or rebuild with -g; without symbols only raw addresses are available',
    );
  }
  if (programElf && !anyDebug && !anyMap) {
    addWarning('no DWARF and no MAP: source lines and variable names are unavailable (symbol names only)');
  }

  // ---- index + summary ----------------------------------------------------
  const { lookup, warnings: indexWarnings } = buildIndex(elfSources, mapSources);
  for (const w of indexWarnings) addWarning(w);
  for (const src of elfSources) {
    if (src.symbols.length === 0) addWarning(`no defined symbols found in "${src.label}"`);
  }

  return {
    ok: true,
    summary: { sources: summarySources, warnings },
    lookup,
    sourceLines,
    resolvePath,
  };
}
