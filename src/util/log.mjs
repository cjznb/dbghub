/**
 * Tiny logger: never writes to stdout (MCP stdio purity). Optional file + in-memory tail.
 */
import fs from 'node:fs';

export function createLogger({ name = 'dbghub', file = null, level = 'info', tailLines = 200 } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const min = levels[level] ?? 20;
  const tail = [];
  let fd = null;
  if (file) {
    try {
      fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
      fd = fs.openSync(file, 'a');
    } catch {
      fd = null;
    }
  }

  function emit(lvl, msg, extra) {
    const text = extra === undefined ? String(msg) : `${msg} ${safeJson(extra)}`;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} [${name}] ${text}`;
    tail.push(line);
    if (tail.length > tailLines) tail.shift();
    if ((levels[lvl] ?? 20) < min) return;
    if (fd != null) {
      try { fs.writeSync(fd, line + '\n'); } catch { /* ignore */ }
    } else {
      try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
    }
  }

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    tail: (n = 50) => tail.slice(-n),
    close: () => { if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; } },
  };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
