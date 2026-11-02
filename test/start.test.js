import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'htmlboard.js');

test('starting htmlboard for a folder it already shows prints that canvas instead of starting another', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htmlboard-start-'));
  fs.writeFileSync(path.join(dir, 'home.html'), '<!DOCTYPE html><title>Home</title>');
  const server = await startServer({ dir, port: 3961 });
  try {
    const out = await new Promise((resolve) => execFile(process.execPath, [CLI, dir, '-p', '3961'], { timeout: 10000 },
      (error, stdout) => resolve({ code: error?.code ?? 0, killed: error?.killed, stdout })));
    assert.equal(out.killed, undefined, 'it started a server');
    assert.equal(out.code, 0);
    assert.match(out.stdout, /already running for this folder/);
    assert.match(out.stdout, /http:\/\/localhost:3961/);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
