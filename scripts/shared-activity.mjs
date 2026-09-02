import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const STATE_SCHEMA_VERSION = 1;

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, seenRecencyByThreadId: {} };
}

function normalizeState(value) {
  if (
    value?.schemaVersion !== STATE_SCHEMA_VERSION ||
    value.seenRecencyByThreadId == null ||
    typeof value.seenRecencyByThreadId !== 'object' ||
    Array.isArray(value.seenRecencyByThreadId)
  ) return emptyState();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    seenRecencyByThreadId: Object.fromEntries(
      Object.entries(value.seenRecencyByThreadId)
        .filter(([threadId, recencyAtMs]) =>
          /^[0-9a-f-]{36}$/i.test(threadId) && Number.isSafeInteger(recencyAtMs),
        ),
    ),
  };
}

async function readState(stateFile) {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.next-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

function readThreads(databaseFile, cutoffMs) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database.prepare(`
      SELECT
        id,
        recency_at_ms AS recencyAtMs,
        COALESCE(NULLIF(name, ''), NULLIF(title, ''), 'Untitled task') AS title,
        cwd
      FROM threads
      WHERE archived = 0
        AND preview <> ''
        AND recency_at_ms >= ?
      ORDER BY recency_at_ms DESC, id DESC
      LIMIT 500
    `).all(cutoffMs).map((thread) => ({
      id: thread.id,
      recencyAtMs: Number(thread.recencyAtMs),
      title: thread.title,
      cwd: thread.cwd,
    }));
  } finally {
    database.close();
  }
}

export function createSharedActivityService({
  codexHome,
  stateFile,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  now = () => Date.now(),
} = {}) {
  if (!codexHome || !stateFile) {
    throw new Error('Shared activity needs Codex home and a Codeex state file.');
  }
  const databaseFile = path.join(codexHome, 'state_5.sqlite');
  let writeQueue = Promise.resolve();

  const recentThreads = async () => {
    if (!(await exists(databaseFile))) return [];
    return readThreads(databaseFile, now() - lookbackMs);
  };

  const snapshot = async () => {
    const [state, threads] = await Promise.all([readState(stateFile), recentThreads()]);
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      scannedAtMs: now(),
      threads: threads.filter((thread) =>
        (state.seenRecencyByThreadId[thread.id] ?? 0) < thread.recencyAtMs,
      ),
    };
  };

  const persistSeen = (threadIds) => {
    const requested = new Set(threadIds);
    writeQueue = writeQueue.then(async () => {
      const [state, threads] = await Promise.all([readState(stateFile), recentThreads()]);
      let changed = false;
      for (const thread of threads) {
        if (!requested.has(thread.id)) continue;
        if ((state.seenRecencyByThreadId[thread.id] ?? 0) >= thread.recencyAtMs) continue;
        state.seenRecencyByThreadId[thread.id] = thread.recencyAtMs;
        changed = true;
      }
      if (changed) await writeState(stateFile, state);
    });
    return writeQueue;
  };

  return {
    async snapshot() {
      await writeQueue;
      return await snapshot();
    },
    async markSeen(threadIds) {
      if (!Array.isArray(threadIds) || threadIds.some((id) => typeof id !== 'string')) {
        const error = new Error('threadIds must be an array of task ids.');
        error.statusCode = 400;
        throw error;
      }
      await persistSeen(threadIds.slice(0, 500));
      return await snapshot();
    },
    async markAllSeen() {
      await persistSeen((await recentThreads()).map((thread) => thread.id));
      return await snapshot();
    },
  };
}

