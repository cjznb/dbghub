/**
 * Small text helpers shared across modules.
 */

/** Decode a GDB/MI C-style string body (without surrounding quotes). */
export function decodeMiString(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) break;
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      default: {
        if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += n;
        }
      }
    }
  }
  return out;
}

/** Quote a path/command argument for GDB/MI (double quotes + escapes). */
export function quoteMi(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

export function clampText(s, max = 4000) {
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, max);
}

export function firstLines(s, n = 3) {
  return String(s ?? '').split(/\r?\n/).slice(0, n);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function tailLines(arr, n) {
  return Array.isArray(arr) ? arr.slice(-n) : [];
}
