/**
 * Text MAP-file parser for dbghub (GNU ld `-Map` and Keil/Armlink `.map`).
 *
 * MAP files are the fallback symbol source when an ELF/AXF is stripped or built
 * without DWARF: they give global symbol -> address, section/memory layout and
 * RO/RW/ROM/RAM totals, but no types, locals or source lines.
 *
 * Public API (docs/dev-interfaces.md section B):
 *   parseMap(textOrPath, opts?) -> { ok, format:'gnu'|'armlink'|'unknown',
 *     sections:[{name,addr,size,loadAddr?}],
 *     symbols:[{name,addr,size?,object?}],
 *     totals?:{text,data,bss,rom,ram}, warnings:[] }
 *   | { ok:false, error:{code:'E_MAP_PARSE', message, hint?, snippet?} }
 *
 * Input may be the map text itself (must contain a newline) or a path to a map
 * file. Files larger than 64 MB are refused before parsing; parsing is a single
 * linear pass with hard caps on parsed symbol count, so a hostile/huge file
 * cannot exhaust memory. This function never throws.
 */

import fs from 'node:fs';

export const MAX_MAP_BYTES = 64 * 1024 * 1024;
export const MAX_MAP_SYMBOLS = 500_000;

/** Error carrying the MAP parse code (internal; converted to {ok:false} at the boundary). */
class MapError extends Error {
  constructor(message, { code = 'E_MAP_PARSE', hint = '', snippet = '' } = {}) {
    super(message);
    this.name = 'MapError';
    this.code = code;
    this.hint = hint;
    this.snippet = snippet;
  }
}

function failure(e) {
  const out = {
    ok: false,
    format: 'unknown',
    error: {
      code: e && e.code ? e.code : 'E_MAP_PARSE',
      message: e && e.message ? String(e.message) : 'MAP parse failed',
    },
  };
  if (e && e.hint) out.error.hint = e.hint;
  if (e && e.snippet) out.error.snippet = e.snippet;
  return out;
}

function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(s);
}

function snippetOf(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ')
    .slice(0, 200);
}

function textBytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Accept raw text, a PathLike string, or a Buffer; returns { text, source }. */
function readInput(textOrPath) {
  if (Buffer.isBuffer(textOrPath)) {
    if (textOrPath.length > MAX_MAP_BYTES) {
      throw new MapError(`MAP data is too large (${textOrPath.length} bytes, limit ${MAX_MAP_BYTES})`, {
        hint: 'point at the linker .map file, not a binary dump',
      });
    }
    return { text: textOrPath.toString('utf8'), source: '<buffer>' };
  }
  if (typeof textOrPath !== 'string') {
    throw new MapError('parseMap needs the map text or a filesystem path', { code: 'E_INVALID_ARG' });
  }
  // Inline snippets are the common test/agent case; a path never contains newlines.
  const inline = /[\r\n]/.test(textOrPath);
  if (!inline) {
    if (hasControlChars(textOrPath)) {
      throw new MapError('path contains NUL/control characters', {
        code: 'E_INVALID_ARG',
        hint: 'pass a clean filesystem path',
      });
    }
    if (!textOrPath) throw new MapError('parseMap got an empty string', { code: 'E_INVALID_ARG' });
  }
  if (inline) {
    if (textBytes(textOrPath) > MAX_MAP_BYTES) {
      throw new MapError(`MAP text is too large (limit ${MAX_MAP_BYTES} bytes)`);
    }
    return { text: textOrPath, source: '<inline>' };
  }
  let st;
  try {
    st = fs.statSync(textOrPath);
  } catch (e) {
    throw new MapError(`cannot read MAP file "${textOrPath}" (${e.code || e.message})`, {
      hint: 'pass a real .map path (GNU ld -Map or Keil/Armlink) or inline map text',
      snippet: snippetOf(textOrPath),
    });
  }
  if (!st.isFile()) throw new MapError(`"${textOrPath}" is not a regular file`);
  if (st.size > MAX_MAP_BYTES) {
    throw new MapError(`MAP file is too large (${st.size} bytes, limit ${MAX_MAP_BYTES})`, {
      hint: 'this is probably not a MAP file; pass the linker-generated .map',
    });
  }
  let text;
  try {
    text = fs.readFileSync(textOrPath, 'utf8');
  } catch (e) {
    throw new MapError(`cannot read MAP file "${textOrPath}" (${e.code || e.message})`);
  }
  return { text, source: textOrPath };
}

function detectFormat(text) {
  const gnu =
    /^Memory Configuration\s*$/m.test(text) ||
    /^Linker script and memory map\s*$/m.test(text) ||
    /^Discarded input sections\s*$/m.test(text) ||
    /^Archive member included to satisfy reference/m.test(text) ||
    /^\s*\.(text|data|bss|rodata|isr_vector)\s+0x[0-9a-fA-F]{4,}\s+0x[0-9a-fA-F]{1,}\s*$/m.test(text);
  if (gnu) return 'gnu';
  const armlink =
    /Image Symbol Table/.test(text) ||
    /Memory Map of the Image/i.test(text) ||
    /Image component sizes/.test(text) ||
    /Component:\s+ARM Compiler/.test(text) ||
    /^Error: L\d+E:/m.test(text);
  if (armlink) return 'armlink';
  return 'unknown';
}

function classifyGnuSection(name) {
  if (!name.startsWith('.')) return 'other';
  if (/^\.(text|rodata|isr_vector|init|fini|preinit_array|init_array|fini_array|ctors|dtors|ARM|vfp11_veneer|v4_bx|iplt|igot|rel\.|eh_frame|gnu\.|jcr|gcc_except_table)/.test(name)) {
    return 'text';
  }
  if (/^\.(data|tdata|got|plt)/.test(name)) return 'data';
  if (/^\.(bss|tbss|noinit|COMMON|heap|stack|_user_heap_stack|_stack|_heap)/.test(name)) return 'bss';
  return 'other';
}

/** Parse a GNU ld `-Map` file (single linear pass after the memory-map marker). */
function parseGnu(text, source) {
  const lines = text.split(/\r?\n/);
  const warnings = [];
  const sections = [];
  const symbols = [];
  const seenSections = new Set();
  const seenSymbols = new Set();
  let start = 0;
  const marker = lines.findIndex((l) => l.trim() === 'Linker script and memory map');
  if (marker >= 0) start = marker + 1;

  const secCombined = /^(\s*)(\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)(?:\s+(.*))?$/;
  const addrSizeOnly = /^\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)(?:\s+(.*))?$/;
  const symLine = /^\s*(0x[0-9a-fA-F]+)\s+([A-Za-z_.$][^\s=]*)(?:\s*=(.*))?$/;
  const nameOnly = /^(\s*)(\.\S+)\s*$/;

  let pending = null; // { name, indented } for two-line "name then addr/size" form
  let currentObject = null;
  let truncated = false;

  const pushSection = (name, indent, addr, size, rest) => {
    if (indent === '') {
      // Output section: this is the authoritative layout row.
      if (seenSections.has(name)) return;
      seenSections.add(name);
      const sec = { name, addr, size };
      const m = /load address\s+(0x[0-9a-fA-F]+)/i.exec(rest || '');
      if (m) {
        const loadAddr = parseInt(m[1], 16);
        if (loadAddr !== addr) sec.loadAddr = loadAddr;
      }
      sections.push(sec);
      currentObject = null;
    } else {
      // Input section: keep its object file so following symbol rows can carry it.
      currentObject = (rest || '').trim() || null;
    }
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('*(') || /^\s*\*fill\*/.test(line)) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('LOAD ') || trimmed === 'START GROUP' || trimmed === 'END GROUP') continue;
    if (trimmed === 'Cross Reference Table') break;
    let m;
    if (pending) {
      m = addrSizeOnly.exec(line);
      if (m) {
        pushSection(pending.name, pending.indented ? ' ' : '', parseInt(m[1], 16), parseInt(m[2], 16), (m[3] || '').trim());
        pending = null;
        continue;
      }
      pending = null;
    }
    m = secCombined.exec(line);
    if (m) {
      const indent = m[1];
      const name = m[2];
      // Combined input rows with a size and no object are still input sections;
      // output rows at column 0 carry little/no trailing rest.
      if (indent === '') {
        pushSection(name, '', parseInt(m[3], 16), parseInt(m[4], 16), (m[5] || '').trim());
      } else {
        pushSection(name, indent, parseInt(m[3], 16), parseInt(m[4], 16), (m[5] || '').trim());
      }
      continue;
    }
    m = symLine.exec(line);
    if (m) {
      const name = m[2];
      if (name === '.' || name === '=') continue; // ". = ALIGN(...)" location counter
      const addr = parseInt(m[1], 16);
      const key = `${name}@${addr}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);
      if (symbols.length >= MAX_MAP_SYMBOLS) {
        truncated = true;
        break;
      }
      const sym = { name, addr };
      if (currentObject) sym.object = currentObject;
      symbols.push(sym);
      continue;
    }
    m = nameOnly.exec(line);
    if (m) {
      pending = { name: m[2], indented: m[1].length > 0 };
    }
  }

  if (sections.length === 0) warnings.push('no output sections found in GNU map');
  if (symbols.length === 0) warnings.push('no symbol rows found in GNU map');
  if (truncated) warnings.push(`symbol table truncated at ${MAX_MAP_SYMBOLS} entries`);

  const totals = totalsFromSections(sections, classifyGnuSection);
  const out = { ok: true, format: 'gnu', source, sections, symbols, warnings };
  if (totals) out.totals = totals;
  return out;
}

function totalsFromSections(sections, classify) {
  let text = 0;
  let data = 0;
  let bss = 0;
  for (const sec of sections) {
    if (!(sec.addr > 0) || !(sec.size > 0)) continue;
    const kind = classify(sec.name);
    if (kind === 'text') text += sec.size;
    else if (kind === 'data') data += sec.size;
    else if (kind === 'bss') bss += sec.size;
  }
  if (text === 0 && data === 0 && bss === 0) return undefined;
  return { text, data, bss, rom: text + data, ram: data + bss };
}

const ARMLINK_SECTION_ROW =
  /^\s*(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(Data|Zero|Code|PAD)\s+(RO|RW|ZI)\s+(\S+)\s+(\S+)(?:\s+(.*))?\s*$/;
const ARMLINK_SYMBOL_ROW =
  /^\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+(Thumb Code|ARM Code|Number|Section|Data|Code|Thumb|ARM|Address)\s+(\d+)\s+(\S+)(?:\s+(.*))?\s*$/;

/** Parse a Keil/Armlink MAP file ("Memory Map of the Image" + "Image Symbol Table"). */
function parseArmlink(text, source) {
  const lines = text.split(/\r?\n/);
  const warnings = [];
  const sections = [];
  const symbols = [];
  const seenSections = new Set();
  const seenSymbols = new Set();
  let truncated = false;
  let totals;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let m = ARMLINK_SECTION_ROW.exec(line);
    if (m) {
      const name = m[7];
      if (!seenSections.has(name)) {
        seenSections.add(name);
        const sec = { name, addr: parseInt(m[1], 16), size: parseInt(m[3], 16) };
        const loadAddr = parseInt(m[2], 16);
        if (loadAddr !== sec.addr) sec.loadAddr = loadAddr;
        sections.push(sec);
      }
      continue;
    }
    m = ARMLINK_SYMBOL_ROW.exec(line);
    if (m) {
      const name = m[1];
      if (name === 'Symbol' || name === 'Name') continue;
      const addr = parseInt(m[2], 16);
      const size = parseInt(m[4], 10);
      const key = `${name}@${addr}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);
      if (symbols.length >= MAX_MAP_SYMBOLS) {
        truncated = true;
        break;
      }
      const sym = { name, addr, size: Number.isFinite(size) ? size : 0 };
      const token = m[5];
      const om = /^([^(]+?)(?:\((.+)\))?$/.exec(token);
      if (om) sym.object = om[1];
      if (om && om[2]) sym.section = om[2];
      symbols.push(sym);
      continue;
    }
    const grand = /^\s*((?:\d+\s+){4,6})Grand Totals\s*$/.exec(line);
    if (grand) {
      // Columns: Code (inc. data), RO Data, RW Data, ZI Data, Debug [, ...].
      const nums = grand[1].trim().split(/\s+/).map((v) => parseInt(v, 10));
      const [code, roData, rwData, ziData] = nums;
      totals = {
        text: code + roData,
        data: rwData,
        bss: ziData,
        rom: code + roData + rwData,
        ram: rwData + ziData,
      };
    }
  }

  if (!totals) {
    let text = 0;
    let data = 0;
    let bss = 0;
    for (const sec of sections) {
      if (!(sec.addr > 0) || !(sec.size > 0)) continue;
      const nm = sec.name.toLowerCase();
      if (nm.includes('bss') || nm.includes('zi')) bss += sec.size;
      else if (nm.includes('data') || nm.includes('rw')) data += sec.size;
      else text += sec.size;
    }
    if (text || data || bss) totals = { text, data, bss, rom: text + data, ram: data + bss };
  }

  if (sections.length === 0) warnings.push('no section rows found under "Memory Map of the Image"');
  if (symbols.length === 0) warnings.push('no symbol rows found under "Image Symbol Table"');
  if (truncated) warnings.push(`symbol table truncated at ${MAX_MAP_SYMBOLS} entries`);

  const out = { ok: true, format: 'armlink', source, sections, symbols, warnings };
  if (totals) out.totals = totals;
  return out;
}

/**
 * Parse a GNU ld -Map or Keil/Armlink .map file.
 *
 * @param {string|Buffer} textOrPath map text (contains a newline) or a file path
 * @param {{maxBytes?:number}} [opts]
 * @returns {object} never throws
 */
export function parseMap(textOrPath, opts = {}) {
  try {
    const { text } = readInput(textOrPath);
    const limit = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_MAP_BYTES;
    if (textBytes(text) > limit) {
      throw new MapError(`MAP data is too large (limit ${limit} bytes)`, {
        hint: 'point at the linker .map file, not a binary dump',
      });
    }
    const source = Buffer.isBuffer(textOrPath) ? '<buffer>' : /[\r\n]/.test(String(textOrPath)) ? '<inline>' : String(textOrPath);
    const format = detectFormat(text);
    if (format === 'gnu') return parseGnu(text, source);
    if (format === 'armlink') return parseArmlink(text, source);
    throw new MapError('unrecognized MAP format (neither GNU ld -Map nor Keil/Armlink)', {
      hint: 'expected a GNU ld "-Map" output or a Keil MDK armlink .map; pass the real linker map path',
      snippet: snippetOf(text),
    });
  } catch (e) {
    if (!(e instanceof MapError)) {
      return failure(new MapError(e && e.message ? String(e.message) : 'MAP parse failed'));
    }
    return failure(e);
  }
}
