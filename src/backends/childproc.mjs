/**
 * Child-process helpers with a file-backed stdio fallback.
 *
 * Why: on hardened Windows hosts (including DSH's workspace-write sandbox) a
 * process may be forbidden from creating anonymous pipes, so
 * `spawn(..., {stdio:['ignore','pipe','pipe']})` throws EPERM.  Redirecting the
 * child's stderr to a regular file always works and keeps the same observable
 * contract (line stream + exit code).  `spawnWatch`/`spawnCapture` try pipes
 * first and transparently fall back to a temp log file.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let SEQ = 0;

export function tempLogPath(prefix = 'dbghub-child') {
  SEQ += 1;
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${SEQ}.log`);
}

function splitLines(state, chunk, onLine) {
  state.buf += chunk;
  let idx;
  while ((idx = state.buf.search(/\r?\n/)) >= 0) {
    const line = state.buf.slice(0, idx);
    const skip = state.buf[idx] === '\r' && state.buf[idx + 1] === '\n' ? 2 : 1;
    state.buf = state.buf.slice(idx + skip);
    onLine(line);
  }
}

function fileReadNew(state) {
  const { logFile } = state;
  if (!logFile) return;
  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return;
  }
  if (stat.size <= state.offset) return;
  let fd = null;
  try {
    fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(stat.size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    state.offset = stat.size;
    splitLines(state, buf.toString('utf8'), state.onLine);
  } catch {
    /* file may be truncating; next poll retries */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Spawn a long-running child and stream its (merged) output lines.
 * Returns { child, mode:'pipe'|'file', logFile, subscribe(fn), dispose() }.
 */
export function spawnWatch({ command, args = [], env, cwd, windowsHide = true, stdioMode = 'auto' }) {
  const state = { buf: '', offset: 0, logFile: null, onLine: () => {} };
  const subs = [];
  const onLine = (line) => {
    for (const fn of subs) {
      try {
        fn(line);
      } catch {
        /* listener errors must not kill the reader */
      }
    }
  };
  state.onLine = onLine;

  const startFileMode = () => {
    const logFile = tempLogPath('dbghub-oc');
    const fd = fs.openSync(logFile, 'w');
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide,
      stdio: ['ignore', fd, fd],
    });
    state.logFile = logFile;
    const poller = setInterval(() => fileReadNew(state), 40);
    poller.unref?.();
    const finish = () => {
      fileReadNew(state);
      if (state.buf) {
        onLine(state.buf);
        state.buf = '';
      }
      clearInterval(poller);
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      if (state.logFile) {
        try {
          fs.unlinkSync(state.logFile);
        } catch {
          /* ignore */
        }
        state.logFile = null;
      }
    };
    child.once('exit', finish);
    return { child, mode: 'file', logFile, subscribe: (fn) => subs.push(fn), dispose: finish };
  };

  const startPipeMode = () => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const streamStates = [];
    const finish = () => {
      // Finish may run twice (exit + dispose): flush each stream's remainder once.
      for (const st of streamStates) {
        if (st.buf) {
          onLine(st.buf);
          st.buf = '';
        }
      }
    };
    const attach = (stream) => {
      if (!stream) return;
      const st = { buf: '' };
      streamStates.push(st);
      stream.setEncoding?.('utf8');
      stream.on('data', (chunk) => splitLines(st, chunk, onLine));
    };
    attach(child.stdout);
    attach(child.stderr);
    child.once('exit', finish);
    return { child, mode: 'pipe', logFile: null, subscribe: (fn) => subs.push(fn), dispose: finish };
  };

  if (stdioMode === 'file') return startFileMode();
  try {
    return startPipeMode();
  } catch (e) {
    if (e && e.code === 'EPERM' && stdioMode === 'auto') return startFileMode();
    throw e;
  }
}

/**
 * Run a child to completion and capture merged output.
 * Returns { code, signal, output, spawnError?, timedOut?, mode }.
 */
export function spawnCapture({ command, args = [], timeoutMs = 8000, env, cwd, windowsHide = true }) {
  return new Promise((resolve) => {
    let done = false;
    let output = '';
    let timer = null;
    let fileState = null; // { logFile, fd, offset, buf, onLine }
    let generation = 0;

    const closeFile = () => {
      if (!fileState) return;
      try {
        fs.closeSync(fileState.fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(fileState.logFile);
      } catch {
        /* ignore */
      }
    };

    const readTail = () => {
      if (!fileState) return;
      fileReadNew(fileState);
      if (fileState.buf) {
        output += fileState.buf;
        fileState.buf = '';
      }
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      readTail();
      closeFile();
      resolve(result);
    };

    const runFileMode = () => {
      generation += 1;
      const gen = generation;
      if (timer) clearTimeout(timer);
      const logFile = tempLogPath('dbghub-cmd');
      let fd;
      try {
        fd = fs.openSync(logFile, 'w');
      } catch (e) {
        finish({ code: null, output, spawnError: e, mode: 'file' });
        return;
      }
      fileState = {
        logFile,
        fd,
        offset: 0,
        buf: '',
        onLine: (line) => {
          output += line + '\n';
        },
      };
      let child;
      try {
        child = spawn(command, args, { cwd, env, windowsHide, stdio: ['ignore', fd, fd] });
      } catch (e) {
        finish({ code: null, output, spawnError: e, mode: 'file' });
        return;
      }
      const poller = setInterval(() => fileReadNew(fileState), 40);
      poller.unref?.();
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish({ code: null, output, timedOut: true, mode: 'file' });
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (e) => {
        if (gen !== generation) return;
        finish({ code: null, output, spawnError: e, mode: 'file' });
      });
      child.once('close', (code, signal) => {
        if (gen !== generation) return;
        clearInterval(poller);
        readTail();
        finish({ code, signal, output, mode: 'file' });
      });
    };

    const runPipeMode = () => {
      generation += 1;
      const gen = generation;
      let child;
      try {
        child = spawn(command, args, { cwd, env, windowsHide, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        if (e && e.code === 'EPERM') {
          runFileMode();
          return;
        }
        finish({ code: null, output, spawnError: e, mode: 'pipe' });
        return;
      }
      const onData = (d) => {
        output += String(d);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish({ code: null, output, timedOut: true, mode: 'pipe' });
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (e) => {
        if (gen !== generation) return;
        if (e && e.code === 'EPERM') {
          runFileMode();
          return;
        }
        finish({ code: null, output, spawnError: e, mode: 'pipe' });
      });
      child.once('close', (code, signal) => {
        if (gen !== generation) return;
        finish({ code, signal, output, mode: 'pipe' });
      });
    };

    runPipeMode();
  });
}

