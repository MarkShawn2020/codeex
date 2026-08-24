import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  cloneApp,
  cloneResources,
  codeexTabClient,
  devtoolsPort,
  outputWebview,
  pluginStateFile,
  runtimeBundleIdentifier,
  runtimeDisplayName,
  sourceWebview,
} from './paths.mjs';
import { readPluginState } from '../plugins/state.mjs';
import { readCodeSignature } from './code-signing.mjs';

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function filesBelow(root, extension) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(extension)) result.push(target);
    }
  }
  return result;
}

async function appAsarHash() {
  const archive = path.join(cloneResources, 'app.asar');
  const hash = createHash('sha256');
  hash.update(await readFile(archive));
  return hash.digest('hex');
}

function plistValue(key) {
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, path.join(cloneApp, 'Contents', 'Info.plist')],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function verifyStaticBuild({
  requireSignature = false,
  requireStableSignature = false,
  installedPluginIds,
} = {}) {
  const indexFile = path.join(outputWebview, 'index.html');
  if (!(await exists(indexFile))) throw new Error('Production webview has not been built.');
  const index = await readFile(indexFile, 'utf8');
  if (!index.includes('http://127.0.0.1:*')) {
    throw new Error('Production CSP does not allow installed local plugin bridges.');
  }
  const expected = new Set(
    installedPluginIds || (await readPluginState(pluginStateFile)).installed,
  );
  const jsFiles = await filesBelow(outputWebview, '.js');
  const codeexTabSource = await readFile(codeexTabClient, 'utf8');
  const codeexTabVersion = codeexTabSource.match(/const runtimeVersion = '([^']+)'/)?.[1];
  if (!codeexTabVersion) throw new Error('Could not resolve the current Codeex tab runtime version.');
  let marketplaceFound = false;
  let codeexTabFound = false;
  let currentCodeexTabFound = false;
  let codeexTabPlaceholderFound = false;
  let fullDiskAccessGuideFound = false;
  let lovinspRuntimeFound = false;
  let archiveSidebarRuntimeFound = false;
  let sourceMetadataCount = 0;
  let sourceLocationCount = 0;
  let nonCanonicalSourceLocationCount = 0;
  const canonicalSourcePrefix = `${sourceWebview}${path.sep}`;
  for (const file of jsFiles) {
    const code = await readFile(file, 'utf8');
    if (code.includes('data-codeex-market')) marketplaceFound = true;
    if (code.includes('__CODEEX_TAB_BOOTSTRAP__')) codeexTabFound = true;
    if (code.includes(`const runtimeVersion = '${codeexTabVersion}'`)) {
      currentCodeexTabFound = true;
    }
    if (code.includes('__CODEEX_CONTROL_CONFIG__')) codeexTabPlaceholderFound = true;
    if (code.includes('/api/permissions/full-disk-access/open-settings')) {
      fullDiskAccessGuideFound = true;
    }
    if (code.includes('lovinsp-component-')) lovinspRuntimeFound = true;
    if (
      code.includes('__CODEEX_ARCHIVE_SIDEBAR__') &&
      code.includes('/settings/data-controls')
    ) archiveSidebarRuntimeFound = true;
    sourceMetadataCount += code.split('data-insp-path').length - 1;
    for (const match of code.matchAll(/"data-insp-path":"([^"]+)"/g)) {
      sourceLocationCount += 1;
      if (!match[1].startsWith(canonicalSourcePrefix)) {
        nonCanonicalSourceLocationCount += 1;
      }
    }
    if (code.includes('__CODEEX_RUNTIME_CONFIG__')) marketplaceFound = true;
  }
  if (marketplaceFound) {
    throw new Error('The Codeex plugin center leaked into the Codex renderer.');
  }
  if (!codeexTabFound || codeexTabPlaceholderFound) {
    throw new Error('The embedded Codeex tab is missing or has an unresolved configuration.');
  }
  if (!currentCodeexTabFound) {
    throw new Error(`The embedded Codeex tab is stale; expected runtime ${codeexTabVersion}.`);
  }
  if (!fullDiskAccessGuideFound) {
    throw new Error('The embedded Codeex tab is missing the Full Disk Access guide.');
  }
  if (expected.has('lovinsp')) {
    if (!lovinspRuntimeFound) throw new Error('Installed Lovinsp runtime was not injected.');
    if (sourceLocationCount < 100) {
      throw new Error(`Only ${sourceLocationCount} Lovinsp source locations were emitted.`);
    }
    if (nonCanonicalSourceLocationCount > 0) {
      throw new Error(
        `${nonCanonicalSourceLocationCount} Lovinsp source locations do not use ${canonicalSourcePrefix}`,
      );
    }
  } else if (sourceMetadataCount > 0) {
    throw new Error('Lovinsp source markers remain after the plugin was disabled.');
  }
  if (expected.has('archive-sidebar')) {
    if (!archiveSidebarRuntimeFound) {
      throw new Error('Installed Archive Sidebar runtime was not injected.');
    }
  } else if (archiveSidebarRuntimeFound) {
    throw new Error('Archive Sidebar runtime remains after the plugin was disabled.');
  }

  const asarHash = await appAsarHash();
  const declaredHash = plistValue('ElectronAsarIntegrity:Resources/app.asar:hash');
  if (asarHash !== declaredHash) {
    throw new Error('ElectronAsarIntegrity does not match the cloned app.asar.');
  }
  if (plistValue('CFBundleDisplayName') !== runtimeDisplayName) {
    throw new Error(`Expected runtime display name ${runtimeDisplayName}.`);
  }
  if (plistValue('CFBundleIdentifier') !== runtimeBundleIdentifier) {
    throw new Error('Codeex runtime still shares the official Codex bundle identifier.');
  }
  const signature = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', cloneApp],
    { encoding: 'utf8' },
  );
  if (requireSignature && signature.status !== 0) {
    throw new Error(`Codeex signature is invalid: ${signature.stderr.trim()}`);
  }
  const signatureIdentity = readCodeSignature(cloneApp);
  if (requireStableSignature && signatureIdentity.adHoc) {
    throw new Error(
      'Codeex is ad-hoc signed; a stable Developer ID identity is required to retain macOS folder permissions.',
    );
  }
  return {
    jsFiles: jsFiles.length,
    marketplaceFound,
    codeexTabFound,
    codeexTabVersion,
    fullDiskAccessGuideFound,
    archiveSidebarRuntimeFound,
    sourceMetadataCount,
    sourceLocationCount,
    nonCanonicalSourceLocationCount,
    installedPluginIds: [...expected],
    signatureValid: signature.status === 0,
    signatureStable: signatureIdentity.valid && !signatureIdentity.adHoc,
    signingTeamIdentifier: signatureIdentity.teamIdentifier,
    asarHash,
  };
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError || 'not ready')}`);
}

async function evaluate(webSocketDebuggerUrl, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('CDP evaluation timed out.'));
    }, 15_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('CDP WebSocket failed.'));
    });
  });
}

async function portIsOpen(port) {
  if (!port) return false;
  return await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

export async function verifyRuntime({
  timeoutMs = 90_000,
  expectArchiveSidebar = false,
  expectLovinsp = false,
} = {}) {
  let latestTargets = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/list`, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = latestTargets.find((target) =>
      target.type === 'page' && target.webSocketDebuggerUrl && target.url === 'app://-/index.html',
    );
    if (page) {
      const state = await evaluate(page.webSocketDebuggerUrl, `(() => {
        const market = document.querySelector('codeex-market');
        const inspector = document.querySelector('lovinsp-component')
          || [...document.documentElement.children].find((node) => node.localName?.startsWith('lovinsp-component-'));
        const paths = document.querySelectorAll('[data-insp-path]');
        const archiveWrapper = document.querySelector('[data-codeex-archive-sidebar]');
        const archiveButton = archiveWrapper?.querySelector('button');
        return {
          title: document.title,
          url: location.href,
          marketplace: Boolean(market?.shadowRoot?.querySelector('[data-codeex-market]')),
          codeexTabAvailable: Boolean(window.__CODEEX_TAB_BOOTSTRAP__),
          lovinsp: Boolean(inspector),
          port: Number(inspector?.port || 0),
          paths: paths.length,
          sample: paths[0]?.getAttribute('data-insp-path') || null,
          archiveSidebar: Boolean(window.__CODEEX_ARCHIVE_SIDEBAR__),
          archiveSidebarCount: document.querySelectorAll('[data-codeex-archive-sidebar]').length,
          archiveSidebarLabel: archiveButton?.textContent?.trim() || null,
          archiveSidebarPreviousLabel:
            archiveWrapper?.previousElementSibling?.textContent?.trim() || null,
          archiveSidebarRoute: window.__CODEEX_ARCHIVE_SIDEBAR__?.route || null,
        };
      })()`);
      const lovinspReady = !expectLovinsp || (
        state?.lovinsp && state.paths > 0 && (await portIsOpen(state.port))
      );
      const archiveSidebarReady = expectArchiveSidebar
        ? (
          state?.archiveSidebar &&
          state.archiveSidebarCount === 1 &&
          state.archiveSidebarLabel === 'Archive' &&
          state.archiveSidebarPreviousLabel === 'Plugins' &&
          state.archiveSidebarRoute === '/settings/data-controls'
        )
        : !state?.archiveSidebar && state?.archiveSidebarCount === 0;
      if (
        !state?.marketplace &&
        state?.codeexTabAvailable &&
        state?.url === 'app://-/index.html' &&
        lovinspReady &&
        archiveSidebarReady
      ) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latestTargets = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/list`, 5_000);
  }
  throw new Error('Codex loaded, but the expected Codeex runtime was not active.');
}

export async function verifyArchiveSidebarNavigation({ timeoutMs = 30_000 } = {}) {
  const targets = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/list`, timeoutMs);
  const page = targets.find((target) =>
    target.type === 'page' && target.webSocketDebuggerUrl && target.url === 'app://-/index.html',
  );
  if (!page) throw new Error('Archive Sidebar smoke page was not found.');
  const clicked = await evaluate(page.webSocketDebuggerUrl, `(() => {
    const button = document.querySelector('[data-codeex-archive-sidebar] button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('Archive Sidebar button could not be clicked.');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(page.webSocketDebuggerUrl, `(() => ({
      browserPath: location.pathname,
      archivedChatsHeadingVisible: [...document.querySelectorAll('h1,h2,h3')]
        .some((heading) => heading.textContent?.trim() === 'Archived chats'),
      archivedChatsSearchVisible: [...document.querySelectorAll('input')]
        .some((input) => input.placeholder === 'Search archived chats'),
    }))()`);
    if (state?.archivedChatsHeadingVisible && state.archivedChatsSearchVisible) {
      return { ...state, path: '/settings/data-controls' };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Archive Sidebar click did not open Archived chats.');
}

export async function verifyPluginManagement({
  expectedPluginIds,
  pluginId = 'archive-sidebar',
  timeoutMs = 30_000,
} = {}) {
  const targets = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/list`, timeoutMs);
  const page = targets.find((target) =>
    target.type === 'page' && target.webSocketDebuggerUrl && target.url === 'app://-/index.html',
  );
  if (!page) throw new Error('Codeex management smoke page was not found.');

  const deadline = Date.now() + timeoutMs;
  let pluginDirectoryOpened = false;
  while (Date.now() < deadline && !pluginDirectoryOpened) {
    pluginDirectoryOpened = await evaluate(page.webSocketDebuggerUrl, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent?.trim() === 'Plugins');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!pluginDirectoryOpened) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!pluginDirectoryOpened) throw new Error('Plugins navigation entry was not found.');

  const officialDirectoryDeadline = Math.min(deadline, Date.now() + 8_000);
  let officialDirectoryFound = false;
  while (Date.now() < officialDirectoryDeadline && !officialDirectoryFound) {
    officialDirectoryFound = await evaluate(page.webSocketDebuggerUrl, `Boolean(
      document.querySelector('[role="group"][aria-label="Plugin directory"]')
    )`);
    if (!officialDirectoryFound) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  let usedDirectoryFixture = false;
  if (!officialDirectoryFound) {
    usedDirectoryFixture = await evaluate(page.webSocketDebuggerUrl, `(() => {
      document.querySelector('[data-codeex-management-fixture]')?.remove();
      const content = document.createElement('div');
      content.dataset.codeexManagementFixture = 'true';
      const row = document.createElement('div');
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Plugin directory');
      for (const [label, pressed] of [['Public', 'true'], ['Personal', 'false']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', pressed);
        button.className = pressed === 'true' ? 'fixture-selected' : 'fixture-inactive';
        group.append(button);
      }
      row.append(group);
      content.append(row, document.createElement('section'));
      document.body.append(content);
      return true;
    })()`);
  }

  let initial = null;
  while (Date.now() < deadline) {
    initial = await evaluate(page.webSocketDebuggerUrl, `(() => {
      const group = document.querySelector('[role="group"][aria-label="Plugin directory"]');
      const tab = group?.querySelector('[data-codeex-tab]');
      if (!tab) return null;
      if (tab.getAttribute('aria-pressed') !== 'true') {
        tab.click();
        return null;
      }
      const cards = [...document.querySelectorAll('.codeex-plugin-card')].map((card) => ({
        id: card.dataset.pluginId,
        installed: card.querySelector('.codeex-plugin-action')?.dataset.installed,
        action: card.querySelector('.codeex-plugin-action')?.textContent?.trim(),
      }));
      return cards.length ? cards : null;
    })()`);
    if (initial) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!initial) {
    const diagnostic = await evaluate(page.webSocketDebuggerUrl, `(() => ({
      runtimeVersion: window.__CODEEX_TAB_BOOTSTRAP__?.version || null,
      groups: [...document.querySelectorAll('[role="group"]')].map((group) => ({
        ariaLabel: group.getAttribute('aria-label'),
        text: group.textContent?.trim(),
      })),
      tabPressed: document.querySelector('[data-codeex-tab]')?.getAttribute('aria-pressed') || null,
      panel: document.querySelector('[data-codeex-tab-panel]')?.textContent?.trim() || null,
      error: document.querySelector('.codeex-tab-error')?.textContent?.trim() || null,
      cardCount: document.querySelectorAll('.codeex-plugin-card').length,
    }))()`);
    throw new Error(`Codeex management cards did not render: ${JSON.stringify(diagnostic)}`);
  }

  const actualIds = initial.map((card) => card.id).sort();
  const expectedIds = [...(expectedPluginIds || [])].sort();
  if (expectedIds.length && actualIds.join('\0') !== expectedIds.join('\0')) {
    throw new Error(
      `Codeex management rendered [${actualIds.join(', ')}], expected [${expectedIds.join(', ')}].`,
    );
  }
  if (new Set(actualIds).size !== actualIds.length) {
    throw new Error('Codeex management rendered duplicate plugin cards.');
  }
  const target = initial.find((card) => card.id === pluginId);
  if (!target || target.installed !== 'true' || target.action !== 'Uninstall') {
    throw new Error(`${pluginId} is not manageable as an installed plugin.`);
  }

  const clickAction = async () => await evaluate(page.webSocketDebuggerUrl, `(() => {
    const action = document.querySelector(
      '[data-plugin-id="${pluginId}"] .codeex-plugin-action',
    );
    if (!action || action.disabled) return false;
    action.click();
    return true;
  })()`);
  if (!(await clickAction())) throw new Error(`Could not uninstall ${pluginId} from Codeex management.`);

  let uninstalled = false;
  while (Date.now() < deadline && !uninstalled) {
    uninstalled = await evaluate(page.webSocketDebuggerUrl, `(() => {
      const action = document.querySelector(
        '[data-plugin-id="${pluginId}"] .codeex-plugin-action',
      );
      return action?.dataset.installed === 'false' && action.textContent?.trim() === 'Install';
    })()`);
    if (!uninstalled) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!uninstalled) throw new Error(`${pluginId} uninstall did not round-trip into its card state.`);
  if (!(await clickAction())) throw new Error(`Could not reinstall ${pluginId} from Codeex management.`);

  let reinstalled = false;
  while (Date.now() < deadline && !reinstalled) {
    reinstalled = await evaluate(page.webSocketDebuggerUrl, `(() => {
      const action = document.querySelector(
        '[data-plugin-id="${pluginId}"] .codeex-plugin-action',
      );
      return action?.dataset.installed === 'true' && action.textContent?.trim() === 'Uninstall';
    })()`);
    if (!reinstalled) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!reinstalled) throw new Error(`${pluginId} reinstall did not round-trip into its card state.`);
  return {
    pluginIds: actualIds,
    pluginId,
    uninstalled,
    reinstalled,
    usedDirectoryFixture,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = process.argv.includes('--runtime');
  try {
    const result = runtime ? await verifyRuntime() : await verifyStaticBuild();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
