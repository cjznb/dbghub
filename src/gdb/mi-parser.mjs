/**
 * Incremental GDB/MI parser (MI2/MI3), zero dependencies.
 *
 * A GDB/MI stream is a sequence of records, one per line:
 *
 *   [token]^class[,results]   result record   (done/running/connected/error/exit)
 *   [token]*class[,results]   exec async      (stopped/running)
 *   [token]=class[,results]   notify async    (thread-created, library-loaded, ...)
 *   [token]+class[,results]   status async    (+download progress)
 *   [token]~"c-string"        console stream  (gdb output)
 *   [token]@"c-string"        target stream   (inferior/target output)
 *   [token]&"c-string"        log stream      (gdb internal log)
 *   (gdb)                     prompt (normally newline-terminated)
 *
 * `results` is a comma-separated list of `name=value`; values are C strings,
 * tuples `{...}`, lists `[...]` or bare tokens. Strings use C escapes
 * (\" \\ \n \t \r and octal \NNN) and are decoded with src/util/text.mjs.
 *
 * API (docs/dev-interfaces.md A):
 *   parseMiRecord(line) -> MiRecord | null
 *   parseMiTuple(text)  -> object
 *   MiStreamParser#feed(chunk) -> MiRecord[]
 *
 * MiRecord:
 *   { kind:'result'|'exec'|'status'|'notify'|'console'|'target'|'log'|'prompt'|'unknown',
 *     token?:number, class?:string, results?:object, text?:string, raw:string }
 *
 * Notes for integrators:
 *  - `kind:'unknown'` is produced (and only produced) for a non-empty line that
 *    is not valid MI. Real GDB can leak raw inferior output into the MI stdout
 *    pipe when the inferior inherits the fd (observed on native Windows
 *    debugging), so dropping such lines silently would lose target output.
 *  - Named results keep GDB's dashes (`thread-id`, `signal-name`, ...).
 *  - `+download` carries an unnamed tuple before its named results (e.g.
 *    `+download,{section=".text",section-size="16"},total-size="32"`); these
 *    positional values are collected in `results._positional`.
 *  - The parser never throws on malformed input: the whole line falls back to
 *    `kind:'unknown'`.
 */
import { decodeMiString } from '../util/text.mjs';

const SIGIL = /^(\d*)([\^*=~@&+])/;
const CLASS = /^([A-Za-z0-9_-]+)/;
const PROMPT = '(gdb)';
const PROMPT_TAIL = /^\(gdb\)[ \t]*$/;

const KIND_BY_SIGIL = {
  '^': 'result',
  '*': 'exec',
  '=': 'notify',
  '+': 'status',
  '~': 'console',
  '@': 'target',
  '&': 'log',
};

/**
 * Parse one MI record line (no trailing newline required; one is tolerated).
 * Returns null for blank lines; returns kind:'unknown' when the line is not MI.
 */
export function parseMiRecord(line) {
  if (line == null) return null;
  let raw = String(line);
  // Tolerate a caller that kept the terminator.
  raw = raw.replace(/[\r\n]+$/, '');
  if (raw.length === 0) return null;

  if (raw.startsWith(PROMPT)) {
    // A normal prompt line is exactly "(gdb) ", but tolerate trailing spaces
    // and a record that was flushed on the same line.
    const rest = raw.slice(PROMPT.length).replace(/^[ \t]+/, '');
    if (rest.length === 0) return { kind: 'prompt', raw };
    const nested = parseMiRecord(rest);
    if (nested) return nested;
    return { kind: 'unknown', text: raw, raw };
  }

  const m = SIGIL.exec(raw);
  if (!m) return { kind: 'unknown', text: raw, raw };
  const token = m[1] ? Number(m[1]) : undefined;
  const sigil = m[2];
  const kind = KIND_BY_SIGIL[sigil];
  const body = raw.slice(m[0].length);

  if (kind === 'console' || kind === 'target' || kind === 'log') {
    const text = decodeStreamText(body, raw);
    if (text === null) return { kind: 'unknown', text: raw, raw };
    return { kind, token, text, raw };
  }

  const cm = CLASS.exec(body);
  const cls = cm ? cm[1] : '';
  const rest = cm ? body.slice(cm[0].length) : body;
  const results = rest.startsWith(',') ? parseMiTuple(rest.slice(1)) : rest.length > 0 ? parseMiTuple(rest) : {};
  return { kind, token, class: cls, results, raw };
}

/** Decode the body of a `~`/`@`/`&` record: one or more concatenated C strings. */
function decodeStreamText(body, raw) {
  let i = 0;
  let out = '';
  let sawString = false;
  while (i < body.length) {
    const ch = body[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '"') {
      const { value, next } = readCString(body, i);
      if (next === i) break;
      out += value;
      sawString = true;
      i = next;
      continue;
    }
    // Tolerate a repeated sigil between adjacent strings: ~"a"~"b".
    if ((ch === '~' || ch === '@' || ch === '&') && body[i + 1] === '"') { i++; continue; }
    break;
  }
  if (!sawString) return null;
  // Anything after the strings (shouldn't happen) is preserved verbatim.
  return out + (i < body.length ? body.slice(i) : '');
}

/**
 * Parse a MI result list (`name=value,name=value,...`) into a plain object.
 * Values are decoded recursively (strings, tuples, lists, bare tokens).
 */
export function parseMiTuple(text) {
  if (text == null) return {};
  const src = String(text);
  if (src.trim().length === 0) return {};
  const c = { s: src, i: 0 };
  const obj = {};
  let positional = null;
  for (;;) {
    skipSeparators(c);
    if (c.i >= c.s.length) break;
    const ch = c.s[c.i];
    if (ch === '{' || ch === '[' || ch === '"') {
      // Unnamed positional value (GDB uses this for +download sections).
      const before = c.i;
      const value = parseValue(c);
      if (!positional) positional = [];
      positional.push(value);
      if (c.i === before) c.i++; // malformed input guard
      continue;
    }
    const eq = findTopLevelEquals(c.s, c.i);
    if (eq === -1) {
      // Tolerate a trailing bare flag such as `^done,foo`.
      const token = readBare(c);
      if (token) {
        if (!positional) positional = [];
        positional.push(token);
      }
      continue;
    }
    const name = c.s.slice(c.i, eq).trim();
    c.i = eq + 1;
    const value = parseValue(c);
    if (name) obj[name] = value;
    else {
      if (!positional) positional = [];
      positional.push(value);
    }
  }
  if (positional) obj._positional = positional;
  return obj;
}

function skipSeparators(c) {
  while (c.i < c.s.length && (c.s[c.i] === ',' || c.s[c.i] === ' ' || c.s[c.i] === '\t')) c.i++;
}

function findTopLevelEquals(s, from) {
  // `name` cannot contain '=' or ','; anything else up to '=' is part of the name.
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '=') return i;
    if (ch === ',' || ch === '}' || ch === ']') return -1;
    if (ch === '"' || ch === '{' || ch === '[') return -1;
  }
  return -1;
}

function readBare(c) {
  const start = c.i;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === ',' || ch === '}' || ch === ']') break;
    c.i++;
  }
  return c.s.slice(start, c.i).trim();
}

function parseValue(c) {
  while (c.i < c.s.length && (c.s[c.i] === ' ' || c.s[c.i] === '\t')) c.i++;
  const ch = c.s[c.i];
  if (ch === '"') {
    const { value, next } = readCString(c.s, c.i);
    c.i = next;
    return value;
  }
  if (ch === '{') return parseTupleValue(c);
  if (ch === '[') return parseListValue(c);
  return readBare(c);
}

function parseTupleValue(c) {
  const obj = {};
  c.i++; // '{'
  for (;;) {
    while (c.i < c.s.length && (c.s[c.i] === ',' || c.s[c.i] === ' ' || c.s[c.i] === '\t')) c.i++;
    if (c.i >= c.s.length) break;
    if (c.s[c.i] === '}') { c.i++; break; }
    const before = c.i;
    const eq = findTopLevelEquals(c.s, c.i);
    if (eq === -1) {
      // Malformed / bare flag inside a tuple: skip it.
      const token = readBare(c);
      if (token) obj[token] = '';
      if (c.i < c.s.length && c.s[c.i] === ',') c.i++;
      if (c.i < c.s.length && c.s[c.i] === '}') { c.i++; break; }
      if (c.i === before) c.i++;
      continue;
    }
    const name = c.s.slice(c.i, eq).trim();
    c.i = eq + 1;
    const value = parseValue(c);
    if (name) obj[name] = value;
    if (c.i === before) c.i++;
  }
  return obj;
}

function parseListValue(c) {
  const arr = [];
  c.i++; // '['
  for (;;) {
    skipSeparators(c);
    if (c.i >= c.s.length) break;
    if (c.s[c.i] === ']') { c.i++; break; }
    const before = c.i;
    // Lists may hold plain values or named results, e.g.
    // stack=[frame={level="0",...},frame={...}] (that is exactly what GDB 16
    // prints). Keep the name so no information is lost.
    const eq = findTopLevelEquals(c.s, c.i);
    if (eq !== -1) {
      const name = c.s.slice(c.i, eq).trim();
      c.i = eq + 1;
      const value = parseValue(c);
      if (name) arr.push({ [name]: value });
      else arr.push(value);
    } else {
      arr.push(parseValue(c));
    }
    if (c.i === before) c.i++; // malformed input guard
  }
  return arr;
}

/** Read one C string starting at `start` (must be '"'). Returns {value,next}. */
function readCString(s, start) {
  let i = start + 1;
  let escaped = false;
  while (i < s.length) {
    const ch = s[i];
    if (escaped) { escaped = false; i++; continue; }
    if (ch === '\\') { escaped = true; i++; continue; }
    if (ch === '"') break;
    i++;
  }
  if (i >= s.length) return { value: decodeMiString(s.slice(start + 1)), next: s.length };
  const body = s.slice(start + 1, i);
  return { value: decodeMiString(body), next: i + 1 };
}

/**
 * Stateful line splitter: feed() accepts arbitrary chunks (including a CRLF
 * split across two chunks) and returns completed MI records.
 *
 * The prompt can be flushed without a trailing newline just before GDB blocks
 * on stdin, so a trailing "(gdb)" is recognized as soon as it is complete.
 */
export class MiStreamParser {
  constructor() {
    this._buf = '';
    /** Set when feed() sees something it cannot parse; useful for diagnostics. */
    this.unknownLines = 0;
  }

  feed(chunk) {
    const out = [];
    if (chunk != null && chunk.length > 0) this._buf += String(chunk);
    for (;;) {
      const idx = this._buf.search(/[\r\n]/);
      if (idx === -1) break;
      const ch = this._buf[idx];
      if (ch === '\r' && idx === this._buf.length - 1) break; // may be the first half of CRLF
      let end = idx + 1;
      if (ch === '\r' && this._buf[idx + 1] === '\n') end = idx + 2;
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(end);
      this._emitLine(line, out);
    }
    // Prompt flushed without a newline: "(gdb)" followed only by spaces.
    if (PROMPT_TAIL.test(this._buf)) {
      out.push({ kind: 'prompt', raw: PROMPT });
      this._buf = '';
    } else if (this._buf.startsWith(PROMPT)) {
      // Defensive: prompt immediately followed by a partial record.
      const rest = this._buf.slice(PROMPT.length).replace(/^[ \t]+/, '');
      out.push({ kind: 'prompt', raw: PROMPT });
      this._buf = rest;
    }
    return out;
  }

  /** Any buffered bytes that do not form a complete record yet. */
  get pending() {
    return this._buf;
  }

  reset() {
    this._buf = '';
    this.unknownLines = 0;
  }

  _emitLine(line, out) {
    if (line.trim().length === 0) return; // blank line, or a space left after the prompt
    if (line.startsWith(PROMPT)) {
      const rest = line.slice(PROMPT.length).replace(/^[ \t]+/, '');
      out.push({ kind: 'prompt', raw: line.slice(0, PROMPT.length) });
      if (rest.length === 0) return;
      const nested = parseMiRecord(rest);
      if (nested) out.push(nested);
      else { this.unknownLines++; out.push({ kind: 'unknown', text: rest, raw: rest }); }
      return;
    }
    const rec = parseMiRecord(line);
    if (!rec) return;
    if (rec.kind === 'unknown') this.unknownLines++;
    out.push(rec);
  }
}
