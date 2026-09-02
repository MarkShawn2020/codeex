import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  instrumentArchiveCall,
  instrumentArchiveFailure,
  instrumentArchiveFlow,
} from './instrument.mjs';
import { transformWebview } from './index.mjs';

const archiveCall = 'archiveThread:t=>e.manager.sendRequest(`thread/archive`,{threadId:t})';
const failureHandler =
  '.then(()=>{v()}).catch(()=>{y(),h.get(d).danger(u.formatMessage({' +
  'id:`localTaskRow.archiveError`,defaultMessage:`Failed to archive conversation`}))})';

async function stageWebview(files) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-safe-archive-transform-'));
  const assets = path.join(temporary, 'assets');
  await mkdir(assets);
  const written = {};
  for (const [name, code] of Object.entries(files)) {
    const target = path.join(assets, name);
    await writeFile(target, code);
    written[name] = target;
  }
  return { stage: temporary, files: written };
}

test('instruments the unique production archive call and task-row failure handler', () => {
  const source = `const adapter={${archiveCall}};promise${failureHandler}`;
  const result = instrumentArchiveFlow(source);
  assert.equal(result.archiveCalls, 1);
  assert.equal(result.failureHandlers, 1);
  assert.match(result.code, /__CODEEX_SAFE_ARCHIVE_RUNTIME__\.archiveThread/);
  assert.match(result.code, /archive:\(\)=>e\.manager\.sendRequest\(`thread\/archive`/);
  assert.match(result.code, /handleFailure\(__codeexSafeArchiveError\)/);
  assert.match(result.code, /\{y\(\);return\}y\(\),h\.get/);
});

test('instruments each half independently so upstream may split them across chunks', () => {
  const call = instrumentArchiveCall(`const adapter={${archiveCall}};`);
  assert.equal(call.archiveCalls, 1);
  assert.match(call.code, /__CODEEX_SAFE_ARCHIVE_RUNTIME__\.archiveThread/);
  const failure = instrumentArchiveFailure(`promise${failureHandler}`);
  assert.equal(failure.failureHandlers, 1);
  assert.match(failure.code, /handleFailure\(__codeexSafeArchiveError\)/);
});

test('refuses ambiguous production archive contracts', () => {
  const missing = instrumentArchiveFlow('const unrelated = true;');
  assert.equal(missing.archiveCalls, 0);
  assert.equal(missing.code, 'const unrelated = true;');
  const duplicateSource = `${archiveCall};${archiveCall};${failureHandler}`;
  const duplicate = instrumentArchiveFlow(duplicateSource);
  assert.equal(duplicate.archiveCalls, 2);
  assert.equal(duplicate.failureHandlers, 0);
  assert.equal(duplicate.code, duplicateSource);
});

test('transforms a single production chunk and injects the browser runtime into the entry', async () => {
  const { stage, files } = await stageWebview({
    'index-test.js': 'globalThis.__ENTRY__ = true;',
    'app-initial-test.js': `const adapter={${archiveCall}};promise${failureHandler}`,
  });
  try {
    const result = await transformWebview({
      stage,
      entryFile: files['index-test.js'],
      filesBelow: async () => Object.values(files),
    });
    assert.deepEqual(result, {
      pluginId: 'safe-archive',
      transformedFiles: 2,
      archiveCalls: 1,
      failureHandlers: 1,
    });
    assert.match(await readFile(files['index-test.js'], 'utf8'), /__CODEEX_SAFE_ARCHIVE_RUNTIME__/);
    assert.match(await readFile(files['app-initial-test.js'], 'utf8'), /\.archiveThread\(\{/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('instruments an archive flow split across two production chunks', async () => {
  const { stage, files } = await stageWebview({
    'index-test.js': 'globalThis.__ENTRY__ = true;',
    'app-initial-test.js': `const adapter={${archiveCall}};`,
    'app-primary-test.js': `promise${failureHandler}`,
    // A chunk mentioning archiveThread without the native contract, plus the
    // localised toast string, must not be mistaken for either half.
    'locale-test.js': 'const messages={archiveThread:`Archive chat`,archiveError:`Failed`};',
  });
  try {
    const result = await transformWebview({
      stage,
      entryFile: files['index-test.js'],
      filesBelow: async () => Object.values(files),
    });
    assert.deepEqual(result, {
      pluginId: 'safe-archive',
      transformedFiles: 3,
      archiveCalls: 1,
      failureHandlers: 1,
    });
    assert.match(await readFile(files['index-test.js'], 'utf8'), /__CODEEX_SAFE_ARCHIVE_RUNTIME__/);
    assert.match(await readFile(files['app-initial-test.js'], 'utf8'), /\.archiveThread\(\{/);
    assert.match(
      await readFile(files['app-primary-test.js'], 'utf8'),
      /handleFailure\(__codeexSafeArchiveError\)/,
    );
    assert.equal(
      await readFile(files['locale-test.js'], 'utf8'),
      'const messages={archiveThread:`Archive chat`,archiveError:`Failed`};',
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('instruments both halves when the entry chunk also carries the archive call', async () => {
  const { stage, files } = await stageWebview({
    'index-test.js': `globalThis.__ENTRY__=true;const adapter={${archiveCall}};promise${failureHandler}`,
  });
  try {
    const result = await transformWebview({
      stage,
      entryFile: files['index-test.js'],
      filesBelow: async () => Object.values(files),
    });
    assert.deepEqual(result, {
      pluginId: 'safe-archive',
      transformedFiles: 1,
      archiveCalls: 1,
      failureHandlers: 1,
    });
    const entryCode = await readFile(files['index-test.js'], 'utf8');
    assert.match(entryCode, /\.archiveThread\(\{/);
    assert.match(entryCode, /handleFailure\(__codeexSafeArchiveError\)/);
    assert.match(entryCode, /__CODEEX_SAFE_ARCHIVE_RUNTIME__/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('refuses to build when the archive failure toast is missing or duplicated', async () => {
  const missing = await stageWebview({
    'index-test.js': 'globalThis.__ENTRY__ = true;',
    'app-initial-test.js': `const adapter={${archiveCall}};`,
  });
  try {
    await assert.rejects(
      transformWebview({
        stage: missing.stage,
        entryFile: missing.files['index-test.js'],
        filesBelow: async () => Object.values(missing.files),
      }),
      /expected one archive failure toast across the production bundle; found 0/,
    );
  } finally {
    await rm(missing.stage, { recursive: true, force: true });
  }

  const duplicated = await stageWebview({
    'index-test.js': 'globalThis.__ENTRY__ = true;',
    'app-initial-test.js': `const adapter={${archiveCall}};promise${failureHandler}`,
    'app-primary-test.js': `promise${failureHandler}`,
  });
  try {
    await assert.rejects(
      transformWebview({
        stage: duplicated.stage,
        entryFile: duplicated.files['index-test.js'],
        filesBelow: async () => Object.values(duplicated.files),
      }),
      /expected one archive failure toast across the production bundle; found 2/,
    );
    assert.equal(
      await readFile(duplicated.files['index-test.js'], 'utf8'),
      'globalThis.__ENTRY__ = true;',
    );
  } finally {
    await rm(duplicated.stage, { recursive: true, force: true });
  }
});
