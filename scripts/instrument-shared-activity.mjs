export const SHARED_ACTIVITY_INSTRUMENTATION_MARKER = '__CODEEX_SHARED_ACTIVITY_INSTRUMENTED__';

const identifier = '[A-Za-z_$][\\w$]*';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueMatch(source, expression, contract) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new Error(`Shared activity expected one ${contract}; found ${matches.length}.`);
  }
  return matches[0];
}

export function instrumentSharedActivity(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Shared activity instrumentation needs JavaScript source.');
  }
  if (source.includes(SHARED_ACTIVITY_INSTRUMENTATION_MARKER)) {
    return { code: source, activityCoordinators: 0, clearHandlers: 0 };
  }

  const coordinator = uniqueMatch(
    source,
    new RegExp(
      `function (${identifier})\\((${identifier}),(${identifier})\\)\\{` +
      `(${identifier})\\.get\\(\\2\\.node\\)\\?\\.stop\\(\\);(?=[\\s\\S]{0,25000}archivedItemsById)`,
      'g',
    ),
    'native activity coordinator',
  );
  const [, coordinatorName, store, sidebarMode, coordinatorRegistry] = coordinator;
  const coordinatorStart = coordinator.index;
  const nextFunction = source.indexOf('function ', coordinatorStart + coordinator[0].length);
  const coordinatorEnd = nextFunction < 0 ? source.length : nextFunction;
  const coordinatorSource = source.slice(coordinatorStart, coordinatorEnd);

  const itemReader = uniqueMatch(
    coordinatorSource,
    new RegExp(`for\\(let\\{item:${identifier}\\}of (${identifier})\\(${escapeRegex(store)}\\.get,${escapeRegex(sidebarMode)}\\)\\)`, 'g'),
    'activity item reader',
  )[1];
  const markRecent = uniqueMatch(
    coordinatorSource,
    new RegExp(`(${identifier})\\(${escapeRegex(store)},(${identifier})\\.item\\.threadEntry\\.key,\\2\\.recencyAt\\)`, 'g'),
    'native recent-task writer',
  )[1];
  const markRecentDefinition = uniqueMatch(
    source,
    new RegExp(
      `function ${escapeRegex(markRecent)}\\((${identifier}),${identifier},${identifier}\\)\\{[\\s\\S]{0,1000}?` +
      `new Map\\(\\1\\.get\\((${identifier})\\)\\)`,
      'g',
    ),
    'native recent-task state',
  );
  const recentAtom = markRecentDefinition[2];

  const attach =
    `globalThis.__CODEEX_SHARED_ACTIVITY__?.attach({` +
    `items:()=>${itemReader}(${store}.get,${sidebarMode}),` +
    `getRecent:()=>${store}.get(${recentAtom}),` +
    `setRecent:${SHARED_ACTIVITY_INSTRUMENTATION_MARKER}=>` +
    `${store}.set(${recentAtom},${SHARED_ACTIVITY_INSTRUMENTATION_MARKER})});`;
  let code =
    source.slice(0, coordinatorStart + coordinator[0].length) +
    attach +
    source.slice(coordinatorStart + coordinator[0].length);

  const clearCoordinator = uniqueMatch(
    code,
    new RegExp(
      `function (${identifier})\\((${identifier})\\)\\{` +
      `${escapeRegex(coordinatorRegistry)}\\.get\\(\\2\\.node\\)\\?\\.stop\\(\\),` +
      `${escapeRegex(coordinatorRegistry)}\\.delete\\(\\2\\.node\\),` +
      `\\2\\.set\\(${identifier},null\\),\\2\\.set\\(${escapeRegex(recentAtom)},new Map\\)`,
      'g',
    ),
    'activity teardown',
  );
  const teardownInjectionAt = clearCoordinator.index + clearCoordinator[0].indexOf('{') + 1;
  code =
    code.slice(0, teardownInjectionAt) +
    'globalThis.__CODEEX_SHARED_ACTIVITY__?.detach();' +
    code.slice(teardownInjectionAt);

  const clearRead = uniqueMatch(
    code,
    new RegExp(
      `function (${identifier})\\((${identifier}),${identifier}\\)\\{` +
      `let ${identifier}=\\2\\.get\\(${identifier}\\);[\\s\\S]{0,500}?` +
      `\\2\\.set\\(${escapeRegex(recentAtom)},new Map\\),` +
      `\\2\\.set\\(${identifier},\\{\\.\\.\\.${identifier},items:${identifier}\\.items\\.filter`,
      'g',
    ),
    'clear-read handler',
  );
  const clearInjectionAt = clearRead.index + clearRead[0].indexOf('{') + 1;
  code =
    code.slice(0, clearInjectionAt) +
    'globalThis.__CODEEX_SHARED_ACTIVITY__?.markAllSeen();' +
    code.slice(clearInjectionAt);

  return { code, activityCoordinators: 1, clearHandlers: 1, coordinatorName };
}

