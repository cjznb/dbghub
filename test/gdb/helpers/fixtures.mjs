/** Fixture loading helpers for the GDB/MI parser tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Read a fixture file as UTF-8 text (binary-exact bytes preserved verbatim). */
export function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Real gdb 16.3 transcripts (see test/gdb/tools/capture-fixtures.mjs). */
export const REAL_FIXTURES = [
  'native-startup.txt',
  'native-run-exited.txt',
  'native-starti-step.txt',
  'arm-symbols-break.txt',
  'pipe-crlf.txt',
];

/** Hand-written records for syntax that is hard to produce without a target. */
export const SYNTHETIC_FIXTURE = 'synthetic-events.txt';

/** Split text into chunks of the given sizes (cycles through the list). */
export function chunkText(text, sizes) {
  const chunks = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const size = Math.max(1, sizes[k % sizes.length]);
    chunks.push(text.slice(i, i + size));
    i += size;
    k++;
  }
  return chunks;
}
