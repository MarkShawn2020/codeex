import { open, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { requestAppServer } from '../prompt-config/app-server-client.mjs';

export const SAFE_ARCHIVE_ROUTE = '/api/plugins/safe-archive';
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

export class SafeArchiveRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SafeArchiveRequestError';
    this.statusCode = statusCode;
  }
}

function assertThreadId(threadId) {
  if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) {
    throw new SafeArchiveRequestError('Safe Archive needs a valid thread ID.');
  }
  return threadId.toLowerCase();
}

async function findRolloutBelow(root, threadId) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return target;
      }
    }
  }
  return null;
}

export async function findRolloutFile(codexHome, threadId) {
  const id = assertThreadId(threadId);
  return await findRolloutBelow(path.join(codexHome, 'sessions'), id) ||
    await findRolloutBelow(path.join(codexHome, 'archived_sessions'), id);
}

async function readSessionMetadata(rolloutFile) {
  if (!rolloutFile) return null;
  const handle = await open(rolloutFile, 'r');
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = source.indexOf('\n');
    const firstLine = newline < 0 ? source : source.slice(0, newline);
    const entry = JSON.parse(firstLine);
    return entry?.type === 'session_meta' ? entry.payload || null : null;
  } finally {
    await handle.close();
  }
}

export function openWriterProcesses(rolloutFile, run = spawnSync) {
  if (!rolloutFile) return [];
  const result = run('/usr/sbin/lsof', ['-Fpc', '--', rolloutFile], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 && !result.stdout) return [];
  const processes = [];
  let current = null;
  for (const line of String(result.stdout || '').split('\n')) {
    if (line.startsWith('p')) {
      current = { pid: Number(line.slice(1)), command: null };
      if (Number.isSafeInteger(current.pid)) processes.push(current);
    } else if (line.startsWith('c') && current) {
      current.command = line.slice(1) || null;
    }
  }
  return processes;
}

function ownerLabel(metadata, processes) {
  if (metadata?.model_provider === 'yoda') return 'Yoda';
  if (metadata?.originator === 'codex-desktop') return 'Codex Desktop';
  if (metadata?.originator === 'codex-tui' || metadata?.source === 'cli') return 'Codex CLI';
  if (processes.some((process) => process.command === 'codex')) return 'Codex';
  return 'another Codex client';
}

export async function inspectThreadOwnership({
  threadId,
  codexHome,
  inspectOpenProcesses = openWriterProcesses,
}) {
  const id = assertThreadId(threadId);
  const rolloutFile = await findRolloutFile(codexHome, id);
  const metadata = await readSessionMetadata(rolloutFile);
  const processes = inspectOpenProcesses(rolloutFile).map(({ pid, command }) => ({
    pid,
    command: typeof command === 'string' ? command : null,
  }));
  return {
    threadId: id,
    activeWriter: processes.length > 0,
    owner: ownerLabel(metadata, processes),
    originator: typeof metadata?.originator === 'string' ? metadata.originator : null,
    source: typeof metadata?.source === 'string' ? metadata.source : null,
    cwd: typeof metadata?.cwd === 'string' ? metadata.cwd : null,
    rollout: rolloutFile ? path.basename(rolloutFile) : null,
    writerPids: processes.map(({ pid }) => pid),
  };
}

export function isActiveWriterError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /already has an active writer/i.test(message);
}

function stateFile(codexHome) {
  return path.join(codexHome, 'codeex', 'safe-archive.json');
}

async function readState(codexHome) {
  try {
    const parsed = JSON.parse(await readFile(stateFile(codexHome), 'utf8'));
    return {
      schemaVersion: 1,
      pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, pending: {} };
  }
}

async function writeState(codexHome, state) {
  const target = stateFile(codexHome);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.next-${process.pid}`;
  await writeFile(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(next, target);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown archive error.');
}

async function archiveWithAppServer({ threadId, codexHome, officialCodexCli }) {
  return await requestAppServer({
    codexCli: officialCodexCli,
    codexHome,
    method: 'thread/archive',
    params: { threadId },
  });
}

export async function processPendingArchives({
  codexHome,
  officialCodexCli,
  archiveThread = archiveWithAppServer,
  now = Date.now,
  forceThreadId = null,
}) {
  const state = await readState(codexHome);
  const completed = [];
  const currentTime = now();
  for (const [threadId, record] of Object.entries(state.pending)) {
    if (forceThreadId && threadId !== forceThreadId) continue;
    if (!forceThreadId && Number(record.nextAttemptAt || 0) > currentTime) continue;
    try {
      await archiveThread({ threadId, codexHome, officialCodexCli });
      delete state.pending[threadId];
      completed.push({ threadId, archivedAt: currentTime });
    } catch (error) {
      const attempts = Number(record.attempts || 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 5_000 * (2 ** Math.min(attempts - 1, 6)));
      state.pending[threadId] = {
        ...record,
        attempts,
        updatedAt: currentTime,
        nextAttemptAt: currentTime + backoff,
        activeWriter: isActiveWriterError(error),
        lastError: errorMessage(error).slice(0, 1_000),
      };
    }
  }
  await writeState(codexHome, state);
  return { pending: Object.values(state.pending), completed };
}

export async function deferArchive({
  threadId,
  codexHome,
  officialCodexCli,
  archiveThread = archiveWithAppServer,
  now = Date.now,
}) {
  const id = assertThreadId(threadId);
  const state = await readState(codexHome);
  const currentTime = now();
  state.pending[id] = {
    threadId: id,
    requestedAt: state.pending[id]?.requestedAt || currentTime,
    updatedAt: currentTime,
    nextAttemptAt: currentTime,
    attempts: state.pending[id]?.attempts || 0,
    activeWriter: true,
    lastError: state.pending[id]?.lastError || null,
  };
  await writeState(codexHome, state);
  return await processPendingArchives({
    codexHome,
    officialCodexCli,
    archiveThread,
    now,
    forceThreadId: id,
  });
}

async function cancelDeferredArchive({ threadId, codexHome }) {
  const id = assertThreadId(threadId);
  const state = await readState(codexHome);
  delete state.pending[id];
  await writeState(codexHome, state);
  return { pending: Object.values(state.pending), cancelled: id };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new SafeArchiveRequestError('Safe Archive request body is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new SafeArchiveRequestError('Safe Archive request body is not valid JSON.');
  }
}

export async function handleSafeArchiveRequest(context, dependencies = {}) {
  const { request, url, codexHome, officialCodexCli } = context;
  if (!url.pathname.startsWith(`${SAFE_ARCHIVE_ROUTE}/`)) return null;
  const route = url.pathname.slice(SAFE_ARCHIVE_ROUTE.length);
  if (route === '/ownership' && request.method === 'GET') {
    return {
      status: 200,
      body: await inspectThreadOwnership({
        threadId: url.searchParams.get('threadId'),
        codexHome,
        inspectOpenProcesses: dependencies.inspectOpenProcesses,
      }),
    };
  }
  if (route === '/pending' && request.method === 'GET') {
    return {
      status: 200,
      body: await processPendingArchives({
        codexHome,
        officialCodexCli,
        archiveThread: dependencies.archiveThread,
        now: dependencies.now,
      }),
    };
  }
  if ((route === '/defer' || route === '/cancel') && request.method === 'POST') {
    const body = await readJsonBody(request);
    return {
      status: 200,
      body: route === '/defer'
        ? await deferArchive({
            threadId: body.threadId,
            codexHome,
            officialCodexCli,
            archiveThread: dependencies.archiveThread,
            now: dependencies.now,
          })
        : await cancelDeferredArchive({ threadId: body.threadId, codexHome }),
    };
  }
  throw new SafeArchiveRequestError('Safe Archive route or method is not supported.', 405);
}
