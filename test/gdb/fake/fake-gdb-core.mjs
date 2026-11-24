/**
 * State machine behind test/gdb/fake/fake-gdb.mjs.
 *
 * Split out so it can be unit-tested in-process (test/gdb/fake-gdb-core.test.mjs)
 * in environments where spawning a child with pipes is not allowed.
 *
 * Timing contract used by the tests:
 *  - -exec-run/-exec-continue/-exec-next: reply ^running + *running, then a
 *    *stopped breakpoint-hit after `stopDelayMs` (250ms by default). The delay
 *    leaves a window to interrupt while the program is "running".
 *  - -exec-interrupt --all: when running, cancel the pending stop and reply
 *    ^done + *stopped reason="signal-received" signal-name="SIGINT"; when not
 *    running, reply ^error ("The program is not being run.").
 *  - -gdb-exit: reply ^exit, then call `onExit(0)` shortly after.
 */
export const FRAME = 'frame={level="0",addr="0x401000",func="main",args=[],file="src/main.c",'
  + 'fullname="D:\\\\work\\\\demo\\\\src\\\\main.c",line="12",arch="i386:x86-64"}';

export function createFakeGdb({
  emit,
  onExit = () => undefined,
  stopDelayMs = 250,
  interruptDelayMs = 5,
  exitDelayMs = 10,
  prompt = () => emit('(gdb) '),
} = {}) {
  let running = false;
  let stopTimer = null;
  let exitTimer = null;

  const reply = (token, body) => {
    const prefix = token === undefined || token === null ? '' : String(token);
    emit(`${prefix}${body}`);
    prompt();
  };

  const clearStop = () => {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  };

  const emitStopBreakpoint = () => {
    running = false;
    stopTimer = null;
    emit('*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",'
      + `${FRAME},thread-id="1",stopped-threads="all"`);
    prompt();
  };

  const scheduleStop = () => {
    clearStop();
    stopTimer = setTimeout(emitStopBreakpoint, stopDelayMs);
  };

  const handlers = {
    '-exec-interrupt --all': (token) => {
      if (!running) {
        reply(token, '^error,msg="The program is not being run."');
        return;
      }
      clearStop();
      emit(`${token === undefined ? '' : token}^done`);
      prompt();
      stopTimer = setTimeout(() => {
        running = false;
        stopTimer = null;
        emit('*stopped,reason="signal-received",signal-name="SIGINT",signal-meaning="Interrupt",'
          + 'thread-id="1",stopped-threads="all"');
        prompt();
      }, interruptDelayMs);
    },
    '-gdb-exit': (token) => {
      emit(`${token === undefined ? '' : token}^exit`);
      exitTimer = setTimeout(() => onExit(0), exitDelayMs);
    },
  };

  function handleLine(line) {
    const m = /^(\d+)(-.*)$/s.exec(line);
    let token;
    let command;
    if (m) {
      token = Number(m[1]);
      command = m[2];
    } else if (line.startsWith('-')) {
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
      running = true;
      emit(`${token}^running`);
      emit('*running,thread-id="all"');
      prompt();
      scheduleStop();
      return;
    }
    if (command.startsWith('-gdb-set ')) { reply(token, '^done'); return; }
    if (command.startsWith('-target-select extended-remote ')) {
      reply(token, '^connected,thread-id="1"');
      return;
    }
    if (command.startsWith('-file-exec-and-symbols ')) { reply(token, '^done'); return; }
    if (command.startsWith('-break-insert ')) {
      reply(token, '^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",'
        + 'addr="0x401000",func="main",file="src/main.c",fullname="D:\\\\work\\\\demo\\\\src\\\\main.c",'
        + 'line="12",thread-groups=["i1"],times="0",original-location="main"}');
      return;
    }
    if (command.startsWith('-stack-list-frames')) {
      reply(token, `^done,stack=[${FRAME},frame={level="1",addr="0x401100",func="crt0",file="crt0.s",line="4"}]`);
      return;
    }
    if (command.startsWith('-data-evaluate-expression ')) { reply(token, '^done,value="42"'); return; }
    reply(token, `^error,msg="Undefined MI command: ${command.replace(/"/g, '\\"')}"`);
  }

  return {
    handleLine,
    get running() { return running; },
    dispose() {
      clearStop();
      if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    },
  };
}
