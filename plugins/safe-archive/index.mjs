import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHIVE_CALL_HINT,
  ARCHIVE_FAILURE_HINT,
  instrumentArchiveCall,
  instrumentArchiveFailure,
} from './instrument.mjs';
import { handleSafeArchiveRequest } from './ownership.mjs';

export const SAFE_ARCHIVE_RUNTIME_MARKER = '__CODEEX_SAFE_ARCHIVE_RUNTIME__';

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeFile = path.join(pluginDirectory, 'runtime.js');
const scanConcurrency = 24;

function assertStagedEntry(stage, entryFile) {
  const stagedRoot = path.resolve(stage);
  const entry = path.resolve(entryFile);
  if (entry !== stagedRoot && !entry.startsWith(`${stagedRoot}${path.sep}`)) {
    throw new Error('Safe Archive can only transform the staged Codeex webview.');
  }
  return entry;
}

function countOccurrences(source, needle) {
  let total = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    total += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return total;
}

// Upstream moves the archive call and its failure toast between production
// chunks across releases, so both halves are located by content instead of by
// chunk name. Every staged chunk that mentions either hint is collected here.
async function collectCandidates(stage, files) {
  const candidates = new Map();
  let cursor = 0;
  const workers = Array.from({ length: scanConcurrency }, async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      const target = assertStagedEntry(stage, file);
      const source = await readFile(target, 'utf8');
      const callHints = countOccurrences(source, ARCHIVE_CALL_HINT);
      const failureHints = countOccurrences(source, ARCHIVE_FAILURE_HINT);
      if (callHints === 0 && failureHints === 0) continue;
      candidates.set(target, { source, callHints, failureHints });
    }
  });
  await Promise.all(workers);
  return candidates;
}

export async function transformWebview(context) {
  if (!context?.stage || !context?.entryFile || typeof context?.filesBelow !== 'function') {
    throw new Error('Codeex webview context is incomplete.');
  }
  const entryFile = assertStagedEntry(context.stage, context.entryFile);
  const entrySource = await readFile(entryFile, 'utf8');
  if (entrySource.includes(SAFE_ARCHIVE_RUNTIME_MARKER)) {
    return {
      pluginId: 'safe-archive',
      transformedFiles: 0,
      archiveCalls: 1,
      failureHandlers: 1,
    };
  }

  const candidates = await collectCandidates(
    context.stage,
    await context.filesBelow(context.stage, '.js'),
  );
  const totalFailureHints = [...candidates.values()]
    .reduce((total, candidate) => total + candidate.failureHints, 0);
  if (totalFailureHints !== 1) {
    throw new Error(
      `Safe Archive expected one archive failure toast across the production bundle; found ${totalFailureHints}.`,
    );
  }

  const pending = new Map();
  let archiveCalls = 0;
  let failureHandlers = 0;
  for (const [file, candidate] of candidates) {
    let code = candidate.source;
    if (candidate.callHints > 0) {
      const instrumented = instrumentArchiveCall(code);
      archiveCalls += instrumented.archiveCalls;
      code = instrumented.code;
    }
    if (candidate.failureHints > 0) {
      const instrumented = instrumentArchiveFailure(code);
      failureHandlers += instrumented.failureHandlers;
      code = instrumented.code;
    }
    if (code !== candidate.source) pending.set(file, code);
  }
  if (archiveCalls !== 1 || failureHandlers !== 1) {
    throw new Error(
      `Safe Archive expected one native archive call and failure handler; found ` +
      `${archiveCalls} and ${failureHandlers}.`,
    );
  }

  const runtime = await readFile(runtimeFile, 'utf8');
  if (!runtime.includes(SAFE_ARCHIVE_RUNTIME_MARKER)) {
    throw new Error('Safe Archive runtime marker is missing.');
  }
  // The entry chunk carries the runtime, so fold any instrumentation it also
  // received into a single write instead of clobbering it afterwards.
  const entryCode = pending.get(entryFile) ?? entrySource;
  pending.set(entryFile, `${entryCode}\n${runtime}\n`);
  await Promise.all(
    [...pending].map(([file, code]) => writeFile(file, code)),
  );
  return {
    pluginId: 'safe-archive',
    transformedFiles: pending.size,
    archiveCalls,
    failureHandlers,
  };
}

export async function handleControlRequest(context) {
  return await handleSafeArchiveRequest(context);
}
