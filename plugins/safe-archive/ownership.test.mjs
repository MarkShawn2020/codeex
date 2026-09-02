import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deferArchive,
  inspectThreadOwnership,
  isActiveWriterError,
  processPendingArchives,
} from './ownership.mjs';

const threadId = '01a03bd3-a88c-7701-997c-0c18e83add4a';

test('reports whitelisted ownership metadata without exposing process arguments', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-safe-archive-owner-'));
  try {
    const sessions = path.join(temporary, 'sessions', '2026', '08', '26');
    await mkdir(sessions, { recursive: true });
    const rollout = path.join(sessions, `rollout-test-${threadId}.jsonl`);
    await writeFile(rollout, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: threadId,
        originator: 'codex-tui',
        source: 'cli',
        model_provider: 'yoda',
        cwd: '/tmp/project',
      },
    })}\n`);
    const ownership = await inspectThreadOwnership({
      threadId,
      codexHome: temporary,
      inspectOpenProcesses: () => [{ pid: 42, command: 'untrusted arguments are not returned' }],
    });
    assert.deepEqual(ownership, {
      threadId,
      activeWriter: true,
      owner: 'Yoda',
      originator: 'codex-tui',
      source: 'cli',
      cwd: '/tmp/project',
      rollout: `rollout-test-${threadId}.jsonl`,
      writerPids: [42],
    });
    assert.equal(JSON.stringify(ownership).includes('untrusted arguments'), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('persists active-writer archive intent and completes it after release', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-safe-archive-pending-'));
  let currentTime = 1_000;
  let writerActive = true;
  const archiveThread = async () => {
    if (writerActive) throw new Error(`thread ${threadId} already has an active writer`);
    return {};
  };
  try {
    const deferred = await deferArchive({
      threadId,
      codexHome: temporary,
      officialCodexCli: '/tmp/codex',
      archiveThread,
      now: () => currentTime,
    });
    assert.equal(deferred.completed.length, 0);
    assert.equal(deferred.pending.length, 1);
    assert.equal(deferred.pending[0].attempts, 1);
    assert.equal(deferred.pending[0].activeWriter, true);
    assert.equal(deferred.pending[0].nextAttemptAt, 6_000);

    writerActive = false;
    currentTime = 6_000;
    const completed = await processPendingArchives({
      codexHome: temporary,
      officialCodexCli: '/tmp/codex',
      archiveThread,
      now: () => currentTime,
    });
    assert.deepEqual(completed.pending, []);
    assert.deepEqual(completed.completed, [{ threadId, archivedAt: currentTime }]);
    const saved = JSON.parse(await readFile(
      path.join(temporary, 'codeex', 'safe-archive.json'),
      'utf8',
    ));
    assert.deepEqual(saved.pending, {});
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('classifies only the native active-writer failure', () => {
  assert.equal(isActiveWriterError(new Error(`thread ${threadId} already has an active writer`)), true);
  assert.equal(isActiveWriterError(new Error('Model provider not found')), false);
});
