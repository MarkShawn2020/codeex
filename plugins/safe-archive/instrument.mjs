const RUNTIME_REFERENCE = 'globalThis.__CODEEX_SAFE_ARCHIVE_RUNTIME__';

// Upstream splits the archive flow across production chunks and re-splits it
// between releases. Both halves are located by these literals so a chunk
// rename or a move to another chunk cannot silently skip instrumentation.
export const ARCHIVE_CALL_HINT = 'archiveThread:';
export const ARCHIVE_FAILURE_HINT = 'id:`localTaskRow.archiveError`';

function archiveCallMatch(source) {
  return source.match(
    /archiveThread:([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\.manager\.sendRequest\((`|'|")thread\/archive\3,\{threadId:\1\}\)/g,
  ) || [];
}

export function instrumentArchiveCall(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Safe Archive instrumentation needs JavaScript source.');
  }
  const matches = archiveCallMatch(source);
  if (matches.length !== 1) {
    return { code: source, archiveCalls: matches.length };
  }
  const call = matches[0];
  const parsed = call.match(
    /^archiveThread:([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\.manager\.sendRequest\((`|'|")thread\/archive\3,\{threadId:\1\}\)$/,
  );
  const [, threadId, manager, quote] = parsed;
  const replacement =
    `archiveThread:${threadId}=>${RUNTIME_REFERENCE}.archiveThread({` +
    `threadId:${threadId},archive:()=>${manager}.manager.sendRequest(` +
    `${quote}thread/archive${quote},{threadId:${threadId}})})`;
  return { code: source.replace(call, replacement), archiveCalls: 1 };
}

export function instrumentArchiveFailure(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Safe Archive instrumentation needs JavaScript source.');
  }
  const messageIndex = source.indexOf(ARCHIVE_FAILURE_HINT);
  if (
    messageIndex < 0 ||
    source.indexOf(ARCHIVE_FAILURE_HINT, messageIndex + ARCHIVE_FAILURE_HINT.length) >= 0
  ) {
    return { code: source, failureHandlers: 0 };
  }
  const windowStart = Math.max(0, messageIndex - 1_000);
  const prefix = source.slice(windowStart, messageIndex);
  const catchOffset = prefix.lastIndexOf('.catch(()=>{');
  if (catchOffset < 0) return { code: source, failureHandlers: 0 };
  const catchIndex = windowStart + catchOffset;
  const bodyStart = catchIndex + '.catch(()=>{'.length;
  const restoreMatch = source.slice(bodyStart, messageIndex).match(
    /^([A-Za-z_$][\w$]*)\(\),/,
  );
  if (!restoreMatch) return { code: source, failureHandlers: 0 };
  const errorName = '__codeexSafeArchiveError';
  const replacement =
    `.catch(${errorName}=>{` +
    `if(${RUNTIME_REFERENCE}?.handleFailure(${errorName})){${restoreMatch[1]}();return}`;
  return {
    code: `${source.slice(0, catchIndex)}${replacement}${source.slice(bodyStart)}`,
    failureHandlers: 1,
  };
}

// Convenience for the single-chunk case: both halves in one production chunk.
export function instrumentArchiveFlow(source) {
  const call = instrumentArchiveCall(source);
  if (call.archiveCalls !== 1) {
    return { code: source, archiveCalls: call.archiveCalls, failureHandlers: 0 };
  }
  const failure = instrumentArchiveFailure(call.code);
  return {
    code: failure.code,
    archiveCalls: 1,
    failureHandlers: failure.failureHandlers,
  };
}
