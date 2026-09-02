import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSharedActivityService } from './shared-activity.mjs';

test('backfills recent shared tasks and advances Codeex read watermarks', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-shared-activity-'));
  try {
    const codexHome = path.join(temporary, '.codex');
    await mkdir(codexHome);
    const database = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        recency_at_ms INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        preview TEXT NOT NULL,
        name TEXT,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      'INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = 1_800_000_000_000;
    insert.run('00000000-0000-4000-8000-000000000001', now - 1_000, 0, 'ready', 'Recent', '', '/recent');
    insert.run('00000000-0000-4000-8000-000000000002', now - 2_000, 1, 'archived', 'Archived', '', '/archived');
    insert.run('00000000-0000-4000-8000-000000000003', now - 9 * 86_400_000, 0, 'old', 'Old', '', '/old');
    database.close();

    const service = createSharedActivityService({
      codexHome,
      stateFile: path.join(temporary, 'activity.json'),
      now: () => now,
    });
    const initial = await service.snapshot();
    assert.deepEqual(initial.threads.map((thread) => thread.id), [
      '00000000-0000-4000-8000-000000000001',
    ]);

    const seen = await service.markSeen(['00000000-0000-4000-8000-000000000001']);
    assert.deepEqual(seen.threads, []);

    const update = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    update.prepare('UPDATE threads SET recency_at_ms = ? WHERE id = ?').run(
      now,
      '00000000-0000-4000-8000-000000000001',
    );
    update.close();
    assert.equal((await service.snapshot()).threads.length, 1);
    assert.deepEqual((await service.markAllSeen()).threads, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

