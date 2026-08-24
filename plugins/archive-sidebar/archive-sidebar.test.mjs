import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transformWebview } from './index.mjs';
import {
  ARCHIVE_SETTINGS_ROUTE,
  RUNTIME_MARKER,
  installArchiveSidebar,
} from './runtime.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-archive-sidebar-'));
const stage = path.join(temporary, 'webview');
const entryFile = path.join(stage, 'assets', 'app-initial-fixture.js');

try {
  await mkdir(path.dirname(entryFile), { recursive: true });
  await writeFile(entryFile, 'globalThis.__fixture = true;\n');
  const result = await transformWebview({ stage, entryFile });
  const transformed = await readFile(entryFile, 'utf8');
  assert.equal(result.transformedFiles, 1);
  assert.equal(result.route, ARCHIVE_SETTINGS_ROUTE);
  assert.ok(transformed.includes(RUNTIME_MARKER));
  assert.ok(transformed.includes(ARCHIVE_SETTINGS_ROUTE));
  assert.ok(transformed.includes(installArchiveSidebar.toString()));

  const repeated = await transformWebview({ stage, entryFile });
  assert.equal(repeated.transformedFiles, 0);
  assert.equal(transformed, await readFile(entryFile, 'utf8'));
  assert.equal(transformed.split(RUNTIME_MARKER).length - 1, 1);
  console.log('✓ Archive Sidebar staged transform and idempotence passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
