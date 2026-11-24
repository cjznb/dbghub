/**
 * In-process fake gdb used by the deterministic GdbSession tests.
 *
 * It implements just enough MI to exercise the session state machine: tokens,
 * serialized command order, async records arriving while a command is pending,
 * ^error, *running/*stopped, -exec-interrupt, ^exit. Because it is injected as
 * `new GdbSession({ spawn: fake.spawn })`, no OS pipes are needed, so the tests
 * also run in sandboxes where child processes cannot use pipes.
 */
import { EventEmitter } from 'node:events';

class FakeStream extends EventEmitter {
  setEncoding() { return this; }
}

class FakeStdin extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.destroyed = false;
    this._ended = false;
  }
  write(text, encoding, cb) {
    if (typeof encoding === 'function') cb = encoding;
    if (this.destroyed || this._ended) {
      const err = new Error('write after end');
      err.code = 'EPIPE';
      if (typeof cb === 'function') cb(err);
      return false;
    }
    const line = String(text).replace(/\r?\n$/, '');
    this.owner._onLine(line);
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
    return true;
  }
  end() { this._ended = true; }
  destroy() { this.destroyed = true; }
}

class FakeChild extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdioMode = 'pipe';
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = new FakeStdin(owner);
  }
  data(text) { this.stdout.emit('data', text); }
  err(text) { this.stderr.emit('data', text); }
  exit(code = 0) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
  kill() { this.killed = true; this.exit(0); }
}

const DEFAULT_FRAME = 'frame={level="0",addr="0x401000",func="main",args=[],file="src/main.c",'
  + 'fullname="D:\\\\work\\\\demo\\\\src\\\\main.c",line="12",arch="i386:x86-64"}';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.crlf]            terminate records with CRLF (default true)
 * @param {boolean} [opts.noise]           emit async notify/console records before replies
 * @param {boolean} [opts.chunked]         deliver each reply in two chunks (packet splitting)
 * @param {number}  [opts.replyDelayMs]    delay before generic replies
 * @param {number}  [opts.stopDelayMs]     delay between *running and *stopped
 * @param {object}  [opts.stop]            override the produced *stopped fields
 * @param {boolean} [opts.greet]           emit the initial prompt/notify (default true)
 */
export function createFakeGdb(opts = {}) {
  const o = {
    crlf: opts.crlf !== false,
    noise: Boolean(opts.noise),
    chunked: Boolean(opts.chunked),
    replyDelayMs: opts.replyDelayMs ?? 0,
    stopDelayMs: opts.stopDelayMs ?? 5,
    autoStop: opts.autoStop !== false,
    greet: opts.greet !== false,
    stop: opts.stop || null,
  };
  const fake = {
    spawnCalls: [],
    commands: [],
    child: null,
    running: false,
    stopped: true,
    stdinWrites: [],
  };

  const eol = () => (o.crlf ? '\r\n' : '\n');
  const emit = (text) => {
    if (o.chunked && text.length > 4) {
      const half = Math.floor(text.length / 2);
      fake.child.data(text.slice(0, half));
      setImmediate(() => fake.child.data(text.slice(half)));
      return;
    }
    fake.child.data(text);
  };
  const prompt = () => emit(`(gdb) ${eol()}`);

  const say = (token, body) => {
    const prefix = token === undefined || token === null ? '' : String(token);
    emit(`${prefix}${body}${eol()}`);
  };

  const noise = () => {
    if (!o.noise) return;
    emit(`=thread-created,id="9",group-id="i1"${eol()}`);
    emit(`~"chatter from the target\\n"${eol()}`);
  };

  const reply = (token, body, delay = o.replyDelayMs) => {
    const send = () => {
      noise();
      say(token, body);
      prompt();
    };
    if (delay > 0) setTimeout(send, delay);
    else setImmediate(send);
  };

  const stopFrame = () => (o.stop && o.stop.frame !== undefined ? o.stop.frame : DEFAULT_FRAME);

  const stopRecord = () => {
    const cfg = o.stop || {};
    const reason = cfg.reason || 'breakpoint-hit';
    const parts = [`reason="${reason}"`];
    if (cfg.reason === 'signal-received') {
      parts.push(`signal-name="${cfg.signal || 'SIGINT'}"`, `signal-meaning="${cfg.signalMeaning || 'Interrupt'}"`);
    } else if (cfg.reason === 'exited-normally' || cfg.reason === 'exited') {
      if (cfg.exitCode) parts.push(`exit-code="${cfg.exitCode}"`);
      return `*stopped,${parts.join(',')}`;
    } else {
      parts.push('disp="keep"', `bkptno="${cfg.bkptno ?? '1'}"`);
    }
    parts.push(stopFrame(), `thread-id="${cfg.threadId ?? '1'}"`, 'stopped-threads="all"');
    return `*stopped,${parts.join(',')}`;
  };

  const stop = () => {
    fake.running = false;
    fake.stopped = true;
    emit(`${stopRecord()}${eol()}`);
    prompt();
  };

  const startRunning = (token) => {
    fake.running = true;
    fake.stopped = false;
    noise();
    say(token, '^running');
    emit(`*running,thread-id="all"${eol()}`);
    prompt();
  };

  const scheduleStop = () => setTimeout(stop, o.stopDelayMs);

  const handlers = {
    '-exec-interrupt --all': (token) => {
      if (!fake.running) {
        reply(token, '^error,msg="The program is not being run."');
        return;
      }
      say(token, '^done');
      prompt();
      scheduleStop();
    },
    '-gdb-exit': (token) => {
      say(token, '^exit');
      prompt();
      setTimeout(() => fake.child.exit(0), 5);
    },
    '-slow-command': () => { /* never replies */ },
    '-slow-command-late': (token) => setTimeout(() => { say(token, '^done'); prompt(); }, 120),
  };

  fake._onLine = (line) => {
    fake.commands.push(line);
    const m = /^(\d+)(-.*)$/s.exec(line);
    let token;
    let command;
    if (m) {
      token = Number(m[1]);
      command = m[2];
    } else if (line.startsWith('-')) {
      // Some commands (e.g. -gdb-exit during close()) are sent without a token.
      token = undefined;
      command = line;
    } else {
      return; // not an MI command
    }
    if (handlers[command]) {
      handlers[command](token);
      return;
    }
    if (command.startsWith('-exec-')) {
      startRunning(token);
      if (o.autoStop) scheduleStop();
      return;
    }
    if (command.startsWith('-gdb-set ')) { reply(token, '^done'); return; }
    if (command.startsWith('-target-select extended-remote ')) {
      if (command.includes('badhost')) reply(token, '^error,msg="Could not connect to remote target."');
      else reply(token, '^connected,thread-id="1"');
      return;
    }
    if (command.startsWith('-file-exec-and-symbols ')) {
      fake.programLoaded = command;
      reply(token, '^done');
      return;
    }
    if (command.startsWith('-break-insert ')) {
      reply(token, '^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x401000",'
        + 'func="main",file="src/main.c",fullname="D:\\\\work\\\\demo\\\\src\\\\main.c",line="12",'
        + 'thread-groups=["i1"],times="0",original-location="main"}');
      return;
    }
    if (command === '-break-list') {
      reply(token, '^done,BreakpointTable={nr_rows="1",nr_cols="6",hdr=[{width="7",alignment="-1",'
        + 'col_name="number",colhdr="Num"}],body=[bkpt={number="1",type="breakpoint",disp="keep",'
        + 'enabled="y",addr="0x401000",func="main",file="src/main.c",line="12"}]}');
      return;
    }
    if (command.startsWith('-stack-list-frames')) {
      reply(token, '^done,stack=[frame={level="0",addr="0x401000",func="main",file="src/main.c",line="12"},'
        + 'frame={level="1",addr="0x401100",func="crt0",file="crt0.s",line="4"}]');
      return;
    }
    if (command.startsWith('-data-evaluate-expression ')) {
      reply(token, '^done,value="42"');
      return;
    }
    reply(token, `^error,msg="Undefined MI command: ${command.replace(/"/g, '\\"')}"`);
  };

  fake.spawn = (file, args, spawnOpts = {}) => {
    fake.spawnCalls.push({
      file,
      args,
      stdio: spawnOpts.stdio,
      env: spawnOpts.env,
      cwd: spawnOpts.cwd,
      shell: spawnOpts.shell,
      windowsHide: spawnOpts.windowsHide,
    });
    const child = new FakeChild(fake);
    fake.child = child;
    if (o.greet) {
      setTimeout(() => {
        child.data(`=thread-group-added,id="i1"${eol()}`);
        prompt();
      }, 1);
    }
    return child;
  };

  /** Emit raw MI text (for stderr/output/edge-case tests). */
  fake.emitRaw = (text) => fake.child.data(text);
  fake.emitStderr = (text) => fake.child.err(text);
  fake.emitExit = (code = 0) => fake.child.exit(code);
  return fake;
}
