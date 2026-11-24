import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsListings, parseSsListings, parseLsofListings } from '../src/probes/targets.mjs';

test('parseWindowsListings identifies renode gdb + monitor ports', () => {
  const netstat = [
    '  TCP    127.0.0.1:3333         0.0.0.0:0              LISTENING       12124',
    '  TCP    127.0.0.1:1234         0.0.0.0:0              LISTENING       12124',
    '  TCP    127.0.0.1:54321        0.0.0.0:0              LISTENING       9999',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
  ].join('\r\n');
  const tasklist = '"renode.exe","12124","Console","1","120,000 K"\r\n"evil.exe","9999","Console","1","1 K"';
  const targets = parseWindowsListings(netstat, tasklist);
  assert.deepEqual(targets.map((t) => t.endpoint).sort(), ['127.0.0.1:1234', '127.0.0.1:3333']);
  const gdb = targets.find((t) => t.port === 3333);
  assert.equal(gdb.role, 'gdb');
  assert.equal(gdb.process, 'renode.exe');
  const monitor = targets.find((t) => t.port === 1234);
  assert.equal(monitor.role, 'monitor');
});

test('parseSsListings parses users/pid and roles', () => {
  const ss = [
    'LISTEN 0 128 127.0.0.1:3333 0.0.0.0:* users:(("openocd",pid=222,fd=5))',
    'LISTEN 0 128 127.0.0.1:4444 0.0.0.0:* users:(("openocd",pid=222,fd=6))',
    'LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("nginx",pid=333,fd=7))',
  ].join('\n');
  const targets = parseSsListings(ss);
  assert.deepEqual(targets.map((t) => `${t.port}:${t.role}`).sort(), ['3333:gdb', '4444:telnet']);
  assert.equal(targets[0].process, 'openocd');
});

test('parseLsofListings parses mac lsof output', () => {
  const lsof = [
    'renode    12124 user   5u  IPv4 0x1234      0t0  TCP 127.0.0.1:3333 (LISTEN)',
    'renode    12124 user   6u  IPv4 0x1235      0t0  TCP 127.0.0.1:1234 (LISTEN)',
  ].join('\n');
  const targets = parseLsofListings(lsof);
  assert.equal(targets.length, 2);
  assert.equal(targets.find((t) => t.port === 3333).role, 'gdb');
  assert.equal(targets.find((t) => t.port === 1234).role, 'monitor');
});
