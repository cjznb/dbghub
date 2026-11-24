#!/usr/bin/env node
/**
 * Minimal fake gdb process speaking GDB/MI on stdin/stdout.
 *
 * Used by test/gdb/gdb-session-spawn.test.mjs to exercise GdbSession against a
 * real child process (pipe transport) without a debugger or a target. It is
 * NOT a gdb substitute: it only implements the commands the tests send.
 * The protocol logic lives in ./fake-gdb-core.mjs so it can be unit-tested
 * in-process when pipes are unavailable.
 *
 * Run directly: node test/gdb/fake/fake-gdb.mjs
 */
import readline from 'node:readline';
import { createFakeGdb } from './fake-gdb-core.mjs';

const rl = readline.createInterface({ input: process.stdin });

const fake = createFakeGdb({
  emit: (line) => process.stdout.write(`${line}\n`),
  onExit: (code) => {
    fake.dispose();
    process.exit(code);
  },
});

// gdb prints its thread-group notification and the first prompt on startup.
process.stdout.write('=thread-group-added,id="i1"\n');
process.stdout.write('(gdb) \n');

rl.on('line', (line) => fake.handleLine(line));
rl.on('close', () => {
  fake.dispose();
  process.exit(0);
});
