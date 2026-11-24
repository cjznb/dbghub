/**
 * Test helpers for the symbols workflow:
 *  - buildElfFixture(): synthesize a valid ELF32/ELF64 (LE/BE) with .text,
 *    optional .data/.bss, .note.gnu.build-id, .debug_info, .symtab/.strtab,
 *    so ELF edge cases can be covered without depending on .hw samples.
 *  - makeTmp()/writeTmp(): throwaway fixture directories.
 *  - GNU/Keil MAP fixtures: minimal but format-faithful inline strings.
 *
 * Everything here is test-only; no production module imports it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbghub-sym-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeTmp(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function writers(little) {
  return {
    u16: (b, o, v) => (little ? b.writeUInt16LE(v & 0xffff, o) : b.writeUInt16BE(v & 0xffff, o)),
    u32: (b, o, v) => (little ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o)),
    u64: (b, o, v) => {
      const big = BigInt(v);
      if (little) b.writeBigUInt64LE(big, o);
      else b.writeBigUInt64BE(big, o);
    },
  };
}

function cstring(...parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p, 'latin1')));
}

function buildStrtab(symbols) {
  const chunks = [Buffer.from([0])];
  const offsets = new Map();
  let off = 1;
  for (const sym of symbols) {
    offsets.set(sym.name, off);
    const b = Buffer.from(`${sym.name}\0`, 'latin1');
    chunks.push(b);
    off += b.length;
  }
  return { data: Buffer.concat(chunks), offsets };
}

function buildNote(buildId, little) {
  const w = writers(little);
  const name = Buffer.from('GNU\0', 'latin1');
  const desc = Buffer.from(buildId, 'hex');
  const head = Buffer.alloc(12);
  w.u32(head, 0, name.length);
  w.u32(head, 4, desc.length);
  w.u32(head, 8, 3); // NT_GNU_BUILD_ID
  const namePadded = Buffer.alloc((name.length + 3) & ~3);
  name.copy(namePadded);
  const descPadded = Buffer.alloc((desc.length + 3) & ~3);
  desc.copy(descPadded);
  return Buffer.concat([head, namePadded, descPadded]);
}

function buildDwarfInfo(version, addrSize, little, is64) {
  const w = writers(little);
  const body = Buffer.alloc(8);
  w.u16(body, 0, version);
  body[2] = 1; // DW_UT_compile
  body[3] = addrSize;
  w.u32(body, 4, 0); // debug_abbrev_offset
  if (!is64) {
    const out = Buffer.alloc(4 + body.length);
    w.u32(out, 0, body.length);
    body.copy(out, 4);
    return out;
  }
  const out = Buffer.alloc(12 + body.length);
  w.u32(out, 0, 0xffffffff);
  w.u64(out, 4, body.length);
  body.copy(out, 12);
  return out;
}

/**
 * Build a synthetic ELF image.
 *
 * @param {object} opts
 * @param {32|64} [opts.bits]
 * @param {boolean} [opts.little]
 * @param {number} [opts.machine] e_machine (40=ARM, 183=AArch64, 62=x86-64)
 * @param {number} [opts.type] e_type (2=EXEC)
 * @param {number} [opts.entry]
 * @param {number} [opts.textAddr]
 * @param {number} [opts.textSize]
 * @param {string|null} [opts.buildId] hex string, null = no build-id note
 * @param {number|null} [opts.dwarfVersion] null = no .debug_info
 * @param {boolean} [opts.dwarf64] use 64-bit DWARF initial length
 * @param {Array} [opts.symbols] {name,addr,size,info,shndx?}
 * @param {boolean} [opts.includeSymtab]
 * @param {Array} [opts.extraSections] {name,type,flags,addr,data,align}
 * @param {Array} [opts.nobits] {name,addr,size,flags}
 */
export function buildElfFixture(opts = {}) {
  const {
    bits = 32,
    little = true,
    machine = 40,
    type = 2,
    entry = 0x08000101,
    textAddr = 0x08000100,
    textSize = 0x100,
    buildId = null,
    dwarfVersion = 5,
    dwarf64 = false,
    symbols = [
      { name: 'main', addr: textAddr + 1, size: 0x20, info: 0x12 },
      { name: 'helper', addr: textAddr + 0x20, size: 0x10, info: 0x12 },
      { name: 'g_value', addr: 0x20000000, size: 4, info: 0x11 },
    ],
    includeSymtab = true,
    extraSections = [],
    nobits = [{ name: '.bss', addr: 0x20000010, size: 0x40 }],
  } = opts;
  const w = writers(little);
  const ehsize = bits === 32 ? 52 : 64;
  const shentsize = bits === 32 ? 40 : 64;
  const addrSize = bits === 32 ? 4 : 8;
  const symEntSize = bits === 32 ? 16 : 24;

  const sections = [];
  sections.push({ name: '.text', type: 1, flags: 6, addr: textAddr, data: Buffer.alloc(textSize, 0xaa), align: 4 });
  for (const extra of extraSections) {
    sections.push({
      name: extra.name,
      type: extra.type ?? 1,
      flags: extra.flags ?? 3,
      addr: extra.addr ?? 0,
      data: extra.data ? Buffer.from(extra.data) : null,
      size: extra.size,
      align: extra.align ?? 4,
    });
  }
  if (buildId) {
    sections.push({ name: '.note.gnu.build-id', type: 7, flags: 2, addr: 0, data: buildNote(buildId, little), align: 4 });
  }
  if (dwarfVersion != null) {
    sections.push({
      name: '.debug_info',
      type: 1,
      flags: 0,
      addr: 0,
      data: buildDwarfInfo(dwarfVersion, addrSize, little, dwarf64),
      align: 1,
    });
    sections.push({ name: '.debug_abbrev', type: 1, flags: 0, addr: 0, data: Buffer.from([0x01, 0x11, 0x00]), align: 1 });
  }
  for (const nb of nobits || []) {
    sections.push({ name: nb.name, type: 8, flags: nb.flags ?? 3, addr: nb.addr, data: null, size: nb.size, align: 4 });
  }
  const strtab = includeSymtab && symbols.length ? buildStrtab(symbols) : null;
  if (strtab) {
    sections.push({ name: '.symtab', type: 2, flags: 0, addr: 0, data: null, align: bits === 32 ? 4 : 8, entsize: symEntSize });
    sections.push({ name: '.strtab', type: 3, flags: 0, addr: 0, data: strtab.data, align: 1 });
  }
  sections.push({ name: '.shstrtab', type: 3, flags: 0, addr: 0, data: null, align: 1 });

  const sectionIndex = new Map();
  sections.forEach((s, i) => sectionIndex.set(s.name, i + 1));

  // shstrtab bytes + per-section name offsets
  const shstrChunks = [Buffer.from([0])];
  let shstrOff = 1;
  const nameOffsets = new Map([['', 0]]);
  for (const s of sections) {
    nameOffsets.set(s.name, shstrOff);
    const b = Buffer.from(`${s.name}\0`, 'latin1');
    shstrChunks.push(b);
    shstrOff += b.length;
  }
  const shstrtab = Buffer.concat(shstrChunks);
  sections[sections.length - 1].data = shstrtab;

  if (strtab) {
    const symtab = sections.find((s) => s.name === '.symtab');
    symtab.link = sectionIndex.get('.strtab');
    const data = Buffer.alloc(symbols.length * symEntSize);
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const off = i * symEntSize;
      w.u32(data, off, strtab.offsets.get(sym.name));
      if (bits === 32) {
        w.u32(data, off + 4, sym.addr);
        w.u32(data, off + 8, sym.size || 0);
        data[off + 12] = sym.info ?? 0x12;
        data[off + 13] = 0;
        w.u16(data, off + 14, sym.shndx ?? sectionIndex.get('.text'));
      } else {
        data[off + 4] = sym.info ?? 0x12;
        data[off + 5] = 0;
        w.u16(data, off + 6, sym.shndx ?? sectionIndex.get('.text'));
        w.u64(data, off + 8, sym.addr);
        w.u64(data, off + 16, sym.size || 0);
      }
    }
    symtab.data = data;
  }

  // Layout: header, section data, section header table.
  let cursor = ehsize;
  for (const s of sections) {
    if (s.data) {
      const aligned = Math.ceil(cursor / (s.align || 1)) * (s.align || 1);
      s.offset = aligned;
      cursor = aligned + s.data.length;
    } else {
      s.offset = cursor;
    }
  }
  const shoff = Math.ceil(cursor / (bits === 32 ? 4 : 8)) * (bits === 32 ? 4 : 8);
  const shnum = sections.length + 1;
  const shstrndx = sections.length;
  const buf = Buffer.alloc(shoff + shnum * shentsize);

  // ELF header
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  buf[4] = bits === 32 ? 1 : 2;
  buf[5] = little ? 1 : 2;
  buf[6] = 1;
  w.u16(buf, 16, type);
  w.u16(buf, 18, machine);
  w.u32(buf, 20, 1);
  if (bits === 32) {
    w.u32(buf, 24, entry);
    w.u32(buf, 28, 0); // e_phoff
    w.u32(buf, 32, shoff);
    w.u32(buf, 36, 0); // e_flags
    w.u16(buf, 40, ehsize);
    w.u16(buf, 42, 0); // e_phentsize
    w.u16(buf, 44, 0); // e_phnum
    w.u16(buf, 46, shentsize);
    w.u16(buf, 48, shnum);
    w.u16(buf, 50, shstrndx);
  } else {
    w.u64(buf, 24, entry);
    w.u64(buf, 32, 0);
    w.u64(buf, 40, shoff);
    w.u32(buf, 48, 0);
    w.u16(buf, 52, ehsize);
    w.u16(buf, 54, 0);
    w.u16(buf, 56, 0);
    w.u16(buf, 58, shentsize);
    w.u16(buf, 60, shnum);
    w.u16(buf, 62, shstrndx);
  }

  for (const s of sections) {
    if (s.data) s.data.copy(buf, s.offset);
  }

  // Section header table (index 0 = SHT_NULL)
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const off = shoff + (i + 1) * shentsize;
    const size = s.data ? s.data.length : s.size ?? 0;
    w.u32(buf, off, nameOffsets.get(s.name) ?? 0);
    w.u32(buf, off + 4, s.type);
    if (bits === 32) {
      w.u32(buf, off + 8, s.flags || 0);
      w.u32(buf, off + 12, s.addr || 0);
      w.u32(buf, off + 16, s.offset || 0);
      w.u32(buf, off + 20, size);
      w.u32(buf, off + 24, s.link || 0);
      w.u32(buf, off + 28, s.info || 0);
      w.u32(buf, off + 32, s.align || 1);
      w.u32(buf, off + 36, s.entsize || 0);
    } else {
      w.u64(buf, off + 8, s.flags || 0);
      w.u64(buf, off + 16, s.addr || 0);
      w.u64(buf, off + 24, s.offset || 0);
      w.u64(buf, off + 32, size);
      w.u32(buf, off + 40, s.link || 0);
      w.u32(buf, off + 44, s.info || 0);
      w.u64(buf, off + 48, s.align || 1);
      w.u64(buf, off + 56, s.entsize || 0);
    }
  }

  return {
    buffer: buf,
    layout: {
      bits,
      little,
      ehsize,
      shentsize,
      shoff,
      shnum,
      shstrndx,
      textAddr,
      textSize,
      buildIdHex: buildId,
      dwarfVersion,
      sectionIndex: Object.fromEntries(sectionIndex),
      sectionNames: sections.map((s) => s.name),
      symbols,
    },
  };
}

/** GNU ld -Map style text; addresses/sizes chosen to match buildElfFixture defaults. */
export function gnuMapText({
  textAddr = 0x08000100,
  textSize = 0x93c8,
  dataAddr = 0x20000000,
  dataSize = 0x70,
  bssAddr = 0x20000070,
  bssSize = 0x3180,
  extraSymbols = [],
} = {}) {
  const hex = (n) => `0x${n.toString(16).padStart(8, '0')}`;
  const sym = extraSymbols
    .map(([name, addr]) => `                0x${addr.toString(16).padStart(8, '0')}                ${name}`)
    .join('\n');
  return [
    'Archive member included to satisfy reference by file (symbol)',
    '',
    'app.o (main)',
    '',
    '',
    'Discarded input sections',
    '',
    '',
    'Memory Configuration',
    '',
    'Name             Origin             Length             Attributes',
    'FLASH            0x08000000         0x00010000         xr',
    'RAM              0x20000000         0x00005000         xrw',
    '*default*        0x00000000         0xffffffff',
    '',
    'Linker script and memory map',
    '',
    'LOAD app.o',
    '                0x20005000                        _estack = (ORIGIN (RAM) + LENGTH (RAM))',
    '',
    '.isr_vector     0x08000000      0x100',
    `                0x${textAddr.toString(16).padStart(8, '0')}                        . = ALIGN (0x4)`,
    ' *(.isr_vector)',
    ' .isr_vector    0x08000000      0x100 app.o',
    '                0x08000000                g_pfnVectors',
    '',
    `.text           ${hex(textAddr)}      ${hex(textSize)}`,
    ' *(.text)',
    ` .text          ${hex(textAddr)}      0x30 app.o`,
    `                0x${(textAddr + 1).toString(16)}                main`,
    `                0x${(textAddr + 0x20).toString(16)}                helper`,
    ' *(.text*)',
    '',
    `.data           ${hex(dataAddr)}      ${hex(dataSize)} load address 0x0800a93c`,
    ' *(.data)',
    ` .data          ${hex(dataAddr)}      0x10 app.o`,
    `                0x${dataAddr.toString(16)}                g_value`,
    '',
    `.bss            ${hex(bssAddr)}      ${hex(bssSize)}`,
    ' *(.bss)',
    ` .bss           ${hex(bssAddr)}      ${hex(bssSize)} app.o`,
    '                0x200031f0                _ebss',
    '',
    '.debug_info     0x00000000     0x40',
    ' .debug_info   0x00000000      0x40 app.o',
    '',
    sym,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/** Keil/Armlink MAP style text (formats only; values are synthetic but consistent). */
export function armlinkMapText() {
  return [
    'Component: ARM Compiler 5.06 update 6 (build 750) Tool: armlink',
    '',
    '==============================================================================',
    '',
    'Image Symbol Table',
    '',
    '    Local Symbols',
    '',
    '    Symbol Name                              Value     Ov Type        Size  Object(Section)',
    '    ------------------------------------------------------------------------------',
    '    main                                     0x08000101   Thumb Code    32  main.o(.text)',
    '    helper                                   0x08000121   Thumb Code    16  helpers.o(.text)',
    '    g_value                                  0x20000000   Data           4  app.o(.data)',
    '',
    '    Global Symbols',
    '',
    '    Symbol Name                              Value     Ov Type        Size  Object(Section)',
    '    ------------------------------------------------------------------------------',
    '    __initial_sp                             0x20005000   Number         0  startup_stm32f10x_hd.o STACK',
    '    Reset_Handler                            0x08000131   Thumb Code     8  startup_stm32f10x_hd.o(.text)',
    '    app_main                                 0x08001001   Thumb Code   128  app_main.o(.text)',
    '',
    '==============================================================================',
    '',
    'Memory Map of the image',
    '',
    '    Image Entry point : 0x08000131',
    '',
    '    Load Region LR_IROM1 (Base: 0x08000000, Size: 0x00001234, Max: 0x00010000, ABSOLUTE)',
    '        Execution Region ER_IROM1 (Exec base: 0x08000000, Load base: 0x08000000, Size: 0x00001000, Max: 0x00010000, ABSOLUTE)',
    '        Exec Addr    Load Addr    Size         Type   Attr      Idx    E Section Name        Object',
    '        0x08000000   0x08000000   0x00000130   Data   RO            0    RESET               startup_stm32f10x_hd.o',
    '        0x08000130   0x08000130   0x00000ed0   Code   RO            1    .text               main.o',
    '        0x08001000   0x08001000   0x00000200   Data   RO            2    .rodata             main.o',
    '        Execution Region RW_IRAM1 (Exec base: 0x20000000, Load base: 0x08001200, Size: 0x00000110, Max: 0x00005000, ABSOLUTE)',
    '        0x20000000   0x08001200   0x00000010   Data   RW            3    .data               main.o',
    '        0x20000010   0x20000010   0x00000100   Zero   RW            4    .bss                main.o',
    '',
    '==============================================================================',
    '',
    'Image component sizes',
    '',
    '      Code (inc. data)   RO Data    RW Data    ZI Data      Debug   Object Name',
    '      1200         100         16        256        512   Object Totals',
    '         0           0          0          0          0   (incl. Generated)',
    '      1200         100         16        256        512   Grand Totals',
    '',
  ].join('\n');
}
