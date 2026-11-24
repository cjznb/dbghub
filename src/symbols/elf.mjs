/**
 * Dependency-free ELF32/ELF64 reader for dbghub symbol handling.
 *
 * Why hand-rolled: v1 must run on bare Node with zero third-party deps and must
 * never shell out to `readelf`/`objdump` (audit + Windows path quoting pain).
 *
 * Public API (see docs/dev-interfaces.md section B):
 *   parseElf(filePath)      -> { ok, path, arch, endian, elfClass, type, buildId?,
 *                                dwarfVersion?, hasDebug, hasSymtab, sections,
 *                                entry, textSection? } | { ok:false, error:{...} }
 *   parseElfBuffer(buf, label?) -> same shape (used by tests and index.mjs)
 *   readElfSymbols(filePathOrBuffer, opts?) -> { ok, path, count, symbols, truncated }
 *
 * Every malformed input is reported as `{ok:false,error:{code:'E_SYMBOL_PARSE'}}`
 * (or E_SYMBOL_NOT_FOUND for unreadable paths); these functions never throw, so
 * callers can always degrade to MAP symbols instead of failing a debug session.
 */

import fs from 'node:fs';

export const MAX_ELF_BYTES = 512 * 1024 * 1024;
export const MAX_ELF_SYMBOLS = 1_000_000;

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // 0x7F 'E' 'L' 'F'
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;
const SHF_EXECINSTR = 0x4;
const SHN_XINDEX = 0xffff;

const ELF_TYPES = { 1: 'rel', 2: 'exec', 3: 'dyn', 4: 'core' };
const ELF_MACHINES = { 3: 'i386', 40: 'arm', 62: 'x86_64', 183: 'aarch64' };
const SYM_TYPES = { 0: 'notype', 1: 'object', 2: 'func', 3: 'section', 4: 'file', 5: 'common', 6: 'tls' };
const SYM_BINDS = { 0: 'local', 1: 'global', 2: 'weak' };

class ElfError extends Error {
  constructor(message, { code = 'E_SYMBOL_PARSE', hint = '' } = {}) {
    super(message);
    this.name = 'ElfError';
    this.code = code;
    this.hint = hint;
  }
}

function failure(label, e) {
  const code = e && e.code ? e.code : 'E_SYMBOL_PARSE';
  const out = {
    ok: false,
    path: label,
    error: { code, message: e && e.message ? String(e.message) : 'ELF parse failed' },
  };
  if (e && e.hint) out.error.hint = e.hint;
  return out;
}

function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(s);
}

function isSafeInt(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

function checkBounds(buf, off, size, what) {
  if (!isSafeInt(off) || !isSafeInt(size) || off + size > buf.length || off + size < off) {
    throw new ElfError(`${what} is out of bounds (offset ${off}, size ${size}, file ${buf.length} bytes)`);
  }
}

function makeReader(buf, little, bits) {
  return {
    u16: (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    u32: (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    u64: (o) => {
      const v = little ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ElfError('64-bit ELF offset/value exceeds JavaScript safe integer range');
      }
      return Number(v);
    },
    bits,
    little,
  };
}

function align4(n) {
  return (n + 3) & ~3;
}

/** Read a NUL-terminated string inside [start,end); out-of-range -> null. */
function readCString(buf, start, end) {
  if (!isSafeInt(start) || !isSafeInt(end) || start >= end) return null;
  const limit = Math.min(end, buf.length);
  let stop = start;
  while (stop < limit && buf[stop] !== 0) stop++;
  return buf.subarray(start, stop).toString('latin1');
}

function sectionHeader(buf, rd, offset, bits) {
  const u32 = rd.u32;
  if (bits === 32) {
    return {
      nameOffset: u32(offset),
      type: u32(offset + 4),
      flags: u32(offset + 8),
      addr: u32(offset + 12),
      offset: u32(offset + 16),
      size: u32(offset + 20),
      link: u32(offset + 24),
      info: u32(offset + 28),
      addralign: u32(offset + 32),
      entsize: u32(offset + 36),
      name: '',
      index: 0,
    };
  }
  return {
    nameOffset: u32(offset),
    type: u32(offset + 4),
    flags: rd.u64(offset + 8),
    addr: rd.u64(offset + 16),
    offset: rd.u64(offset + 24),
    size: rd.u64(offset + 32),
    link: u32(offset + 40),
    info: u32(offset + 44),
    addralign: rd.u64(offset + 48),
    entsize: rd.u64(offset + 56),
    name: '',
    index: 0,
  };
}

/**
 * Parse the fixed parts of an ELF file plus its section header table.
 * Throws ElfError on structural problems; callers convert to {ok:false,...}.
 */
function parseRaw(buf) {
  if (!Buffer.isBuffer(buf)) throw new ElfError('input is not a Buffer');
  if (buf.length < 16) throw new ElfError(`file is too small for an ELF header (${buf.length} bytes)`);
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== ELF_MAGIC[i]) {
      throw new ElfError(
        `bad ELF magic 0x${buf.subarray(0, 4).toString('hex')} (expected 7f454c46)`,
        { hint: 'this file is not an ELF/AXF image; pass a real .elf/.axf or a .map symbol file' },
      );
    }
  }
  const classByte = buf[4];
  if (classByte !== 1 && classByte !== 2) {
    throw new ElfError(`unsupported ELF class ${classByte} (expected 1=ELF32 or 2=ELF64)`);
  }
  const dataByte = buf[5];
  if (dataByte !== 1 && dataByte !== 2) {
    throw new ElfError(`unsupported ELF data encoding ${dataByte} (expected 1=little-endian or 2=big-endian)`);
  }
  const bits = classByte === 1 ? 32 : 64;
  const little = dataByte === 1;
  const ehsize = bits === 32 ? 52 : 64;
  if (buf.length < ehsize) {
    throw new ElfError(`truncated ELF header: ${buf.length} bytes, need ${ehsize}`);
  }
  const rd = makeReader(buf, little, bits);
  const h = {
    bits,
    little,
    type: rd.u16(16),
    machine: rd.u16(18),
    version: rd.u32(20),
    entry: bits === 32 ? rd.u32(24) : rd.u64(24),
    shoff: bits === 32 ? rd.u32(32) : rd.u64(40),
    shentsize: rd.u16(bits === 32 ? 46 : 58),
    shnum: rd.u16(bits === 32 ? 48 : 60),
    shstrndx: rd.u16(bits === 32 ? 50 : 62),
  };
  const minShEnt = bits === 32 ? 40 : 64;
  const sections = [];
  // A non-zero e_shoff means a section table exists. e_shnum==0 and/or
  // e_shstrndx==SHN_XINDEX are the "extended numbering" encodings: the real
  // values live in section header #0's sh_size/sh_link.
  if (h.shoff !== 0) {
    if (h.shentsize < minShEnt) {
      throw new ElfError(`invalid section header entry size ${h.shentsize} (need >= ${minShEnt})`);
    }
    checkBounds(buf, h.shoff, minShEnt, 'first section header');
    const first = sectionHeader(buf, rd, h.shoff, bits);
    let shnum = h.shnum;
    let shstrndx = h.shstrndx;
    if (shnum === 0) {
      if (!isSafeInt(first.size) || first.size > 1_000_000) {
        throw new ElfError(`implausible extended section count ${first.size}`);
      }
      shnum = first.size;
    }
    if (shstrndx === SHN_XINDEX) shstrndx = first.link;
    if (shnum > 0) {
      checkBounds(buf, h.shoff, shnum * h.shentsize, 'section header table');
      for (let i = 0; i < shnum; i++) {
        const s = sectionHeader(buf, rd, h.shoff + i * h.shentsize, bits);
        s.index = i;
        sections.push(s);
      }
      // Program data for allocated sections must fit in the file. NOBITS is the
      // exception (its "size" is the in-memory size, nothing lives in the file),
      // and SHT_NULL sections are ignored.
      for (const s of sections) {
        if (s.index === 0 || s.type === 0) continue;
        if (s.type === SHT_NOBITS) {
          if (s.offset > buf.length) {
            throw new ElfError(`section #${s.index} offset ${s.offset} is past end of file (${buf.length} bytes)`);
          }
          continue;
        }
        checkBounds(buf, s.offset, s.size, `section #${s.index} data`);
      }
      // Section names come from shstrtab. A missing/degenerate table gives
      // empty names (not a fatal error); a name offset outside the table is
      // skipped rather than read past the buffer.
      let names = null;
      if (shstrndx > 0) {
        if (shstrndx >= sections.length) {
          throw new ElfError(
            `section name table index ${shstrndx} is out of range (section count ${sections.length})`,
            { hint: 'file was truncated while copying or the ELF was produced by a broken tool' },
          );
        }
        const strsec = sections[shstrndx];
        if (strsec.type !== SHT_STRTAB) {
          throw new ElfError(`section name table (section #${shstrndx}) is not a string table`);
        }
        checkBounds(buf, strsec.offset, strsec.size, 'section name string table');
        names = { buf, start: strsec.offset, size: strsec.offset + strsec.size, base: strsec.offset };
      }
      for (const s of sections) {
        if (!names) continue;
        const off = names.base + s.nameOffset;
        const n = readCString(buf, off, names.size);
        s.name = n ?? '';
      }
      h.shnum = sections.length;
      h.shstrndx = shstrndx;
    }
  }
  return { buf, rd, header: h, sections };
}

function indexByName(sections) {
  const m = new Map();
  for (const s of sections) {
    if (!s.name) continue;
    if (!m.has(s.name)) m.set(s.name, s);
  }
  return m;
}

function readBuildId(buf, rd, sections) {
  const byName = indexByName(sections);
  const sec = byName.get('.note.gnu.build-id');
  if (!sec || sec.size === 0) return undefined;
  const end = sec.offset + sec.size;
  if (end > buf.length) return undefined;
  let pos = sec.offset;
  while (pos + 12 <= end) {
    let namesz;
    let descsz;
    let type;
    try {
      namesz = rd.u32(pos);
      descsz = rd.u32(pos + 4);
      type = rd.u32(pos + 8);
    } catch {
      return undefined;
    }
    if (namesz > 0x10000 || descsz > 0x10000) return undefined;
    const nameStart = pos + 12;
    const descStart = align4(nameStart + namesz);
    if (descStart + descsz > end) return undefined;
    const name = buf.subarray(nameStart, nameStart + namesz).toString('latin1');
    if (type === 3 && name.startsWith('GNU')) {
      return buf.subarray(descStart, descStart + descsz).toString('hex');
    }
    pos = align4(descStart + descsz);
  }
  return undefined;
}

function readDwarfVersion(buf, rd, sections) {
  const sec = indexByName(sections).get('.debug_info');
  if (!sec || sec.size === 0) return undefined;
  const end = sec.offset + sec.size;
  if (sec.offset + 6 > end || end > buf.length) return undefined;
  try {
    const initial = rd.u32(sec.offset);
    if (initial === 0xffffffff) {
      if (sec.offset + 14 > end) return undefined;
      return rd.u16(sec.offset + 12); // 64-bit DWARF: length(8) then version
    }
    return rd.u16(sec.offset + 4); // 32-bit DWARF: length(4) then version
  } catch {
    return undefined;
  }
}

function summarize(raw, label) {
  const { buf, rd, header: h, sections } = raw;
  const byName = indexByName(sections);
  const text = byName.get('.text');
  let textSection;
  if (text && text.size > 0) {
    textSection = { addr: text.addr, size: text.size };
  } else {
    const exec = sections.find(
      (s) => s.index !== 0 && (s.flags & SHF_EXECINSTR) !== 0 && s.type !== SHT_NOBITS && s.size > 0,
    );
    if (exec) textSection = { addr: exec.addr, size: exec.size };
  }
  const symtab = byName.get('.symtab');
  const hasSymtab = !!symtab && symtab.size >= (h.bits === 32 ? 16 : 24);
  const debugInfo = byName.get('.debug_info');
  const result = {
    ok: true,
    path: label,
    arch: ELF_MACHINES[h.machine] || 'unknown',
    endian: h.little ? 'little' : 'big',
    elfClass: h.bits,
    type: ELF_TYPES[h.type] || 'unknown',
    hasDebug: !!debugInfo && debugInfo.size > 0,
    hasSymtab,
    sections: sections
      .filter((s) => s.index !== 0 && s.name)
      .map((s) => ({ name: s.name, addr: s.addr, size: s.size })),
    entry: h.entry,
  };
  const buildId = readBuildId(buf, rd, sections);
  if (buildId) result.buildId = buildId;
  const dwarfVersion = readDwarfVersion(buf, rd, sections);
  if (dwarfVersion !== undefined) result.dwarfVersion = dwarfVersion;
  if (textSection) result.textSection = textSection;
  return result;
}

/** Read a bounded ELF file; throws ElfError (E_SYMBOL_NOT_FOUND / E_SYMBOL_PARSE). */
function readElfFile(filePath) {
  const p = String(filePath ?? '');
  if (!p) throw new ElfError('parseElf needs a file path', { code: 'E_INVALID_ARG' });
  if (hasControlChars(p)) {
    throw new ElfError('path contains NUL/control characters', { code: 'E_INVALID_ARG', hint: 'pass a clean filesystem path' });
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    throw new ElfError(`cannot read ELF file "${p}" (${e.code || e.message})`, {
      code: 'E_SYMBOL_NOT_FOUND',
      hint: 'check the path passed to open(program/symbols)',
    });
  }
  if (!st.isFile()) {
    throw new ElfError(`"${p}" is not a regular file`, { code: 'E_SYMBOL_NOT_FOUND' });
  }
  if (st.size > MAX_ELF_BYTES) {
    throw new ElfError(`ELF file is too large (${st.size} bytes, limit ${MAX_ELF_BYTES})`, {
      hint: 'point at the real .elf/.axf, not a disk image',
    });
  }
  try {
    return fs.readFileSync(p);
  } catch (e) {
    throw new ElfError(`cannot read ELF file "${p}" (${e.code || e.message})`, { code: 'E_SYMBOL_NOT_FOUND' });
  }
}

export function parseElfBuffer(buf, label = '<buffer>') {
  try {
    return summarize(parseRaw(buf), label);
  } catch (e) {
    return failure(label, e);
  }
}

/** Parse ELF metadata (never throws). */
export function parseElf(filePath) {
  const label = typeof filePath === 'string' ? filePath : String(filePath ?? '');
  let buf;
  try {
    buf = readElfFile(filePath);
  } catch (e) {
    return failure(label, e);
  }
  return parseElfBuffer(buf, label);
}

function readSymtabSection(buf, rd, sections, sec) {
  const bits = rd.bits;
  const minEnt = bits === 32 ? 16 : 24;
  if (sec.size === 0) return { symbols: [], truncated: false };
  if (sec.link <= 0 || sec.link >= sections.length) {
    throw new ElfError(`symbol table "${sec.name || '#' + sec.index}" has invalid string table link ${sec.link}`);
  }
  const strtab = sections[sec.link];
  if (strtab.type !== SHT_STRTAB) {
    throw new ElfError(`symbol table "${sec.name || '#' + sec.index}" string table is not SHT_STRTAB`);
  }
  checkBounds(buf, strtab.offset, strtab.size, 'symbol string table');
  const entsize = sec.entsize >= minEnt ? sec.entsize : minEnt;
  const total = Math.floor(sec.size / entsize);
  const symbols = [];
  let truncated = false;
  for (let i = 0; i < total; i++) {
    if (symbols.length >= MAX_ELF_SYMBOLS) {
      truncated = true;
      break;
    }
    const off = sec.offset + i * entsize;
    let nameOffset;
    let value;
    let size;
    let info;
    let shndx;
    if (bits === 32) {
      nameOffset = rd.u32(off);
      value = rd.u32(off + 4);
      size = rd.u32(off + 8);
      info = buf[off + 12];
      shndx = rd.u16(off + 14);
    } else {
      nameOffset = rd.u32(off);
      info = buf[off + 4];
      shndx = rd.u16(off + 6);
      value = rd.u64(off + 8);
      size = rd.u64(off + 16);
    }
    const type = info & 0xf;
    if (type === 3 || type === 4) continue; // section/file pseudo-symbols
    if (shndx === 0) continue; // undefined (external reference) -> not a location
    const name = nameOffset < strtab.size ? readCString(buf, strtab.offset + nameOffset, strtab.offset + strtab.size) : null;
    if (!name) continue;
    const sym = {
      name,
      addr: value,
      size,
      type: SYM_TYPES[type] || 'other',
      bind: SYM_BINDS[info >> 4] || 'other',
    };
    if (shndx < sections.length && shndx > 0) {
      const s = sections[shndx];
      if (s.name) sym.section = s.name;
    }
    symbols.push(sym);
  }
  return { symbols, truncated };
}

/**
 * Read .symtab/.dynsym symbol entries (defined symbols only, section/file
 * pseudo-symbols and SHN_UNDEF entries are skipped).
 *
 * @param {string|Buffer} input file path or raw ELF bytes
 * @param {{path?:string, maxSymbols?:number}} [opts]
 */
export function readElfSymbols(input, opts = {}) {
  const label = Buffer.isBuffer(input) ? opts.path || '<buffer>' : String(input ?? '');
  try {
    let buf;
    if (Buffer.isBuffer(input)) {
      buf = input;
    } else {
      buf = readElfFile(input);
    }
    const raw = parseRaw(buf);
    const { sections } = raw;
    const byName = indexByName(sections);
    const symbols = [];
    let truncated = false;
    const limit = Number.isSafeInteger(opts.maxSymbols) && opts.maxSymbols > 0 ? opts.maxSymbols : MAX_ELF_SYMBOLS;
    for (const name of ['.symtab', '.dynsym']) {
      const sec = byName.get(name);
      if (!sec) continue;
      const got = readSymtabSection(buf, raw.rd, sections, sec);
      for (const sym of got.symbols) {
        if (symbols.length >= limit) {
          truncated = true;
          break;
        }
        symbols.push(sym);
      }
      if (truncated) break;
    }
    return { ok: true, path: label, count: symbols.length, symbols, truncated };
  } catch (e) {
    return failure(label, e);
  }
}
