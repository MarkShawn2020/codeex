import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from './control-server.mjs';
import { projectRoot } from './paths.mjs';
import {
  parseDeveloperIdIdentities,
  resolveCodeSigningIdentity,
} from './code-signing.mjs';
import {
  createDevEnvironment,
  defaultDevtoolsPort,
  defaultLovinspPort,
  devBundleIdentifier,
  devDisplayName,
} from './dev-environment.mjs';
import { detectFullDiskAccess } from './macos-permissions.mjs';
import { launcherInfoPlist } from './launcher-plist.mjs';
import { createRuntimeEnvironment } from './runtime-environment.mjs';
import {
  isSupervisorAttached,
  parseSupervisorPid,
} from './supervisor-lifecycle.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-test-'));
const stateFile = path.join(temporary, 'plugins.json');
let activePluginIds = ['lovinsp'];
let restartRequests = 0;
let launchRequests = 0;
let fullDiskAccessSettingsRequests = 0;
const control = await startControlServer({
  stateFile,
  getActivePluginIds: () => activePluginIds,
  isolated: true,
  onRestart: () => { restartRequests += 1; },
  onLaunch: () => { launchRequests += 1; },
  getFullDiskAccessStatus: () => ({
    supported: true,
    state: 'not-granted',
    granted: false,
    applicationPath: '/Applications/Codeex.app',
    requiresRestart: true,
  }),
  onOpenFullDiskAccessSettings: () => { fullDiskAccessSettingsRequests += 1; },
});

async function request(route, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${control.port}${route}`, {
    method,
    headers: { 'X-Codeex-Token': control.token },
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

try {
  const devEnvironment = createDevEnvironment({ PATH: '/usr/bin' }, projectRoot);
  assert.equal(devEnvironment.CODEEX_RUNTIME_BUNDLE_IDENTIFIER, devBundleIdentifier);
  assert.equal(devEnvironment.CODEEX_RUNTIME_DISPLAY_NAME, devDisplayName);
  assert.equal(devEnvironment.CODEEX_DEVTOOLS_PORT, String(defaultDevtoolsPort));
  assert.equal(devEnvironment.CODEEX_LOVINSP_PORT, String(defaultLovinspPort));
  assert.equal(
    devEnvironment.CODEEX_RUNTIME_ROOT,
    path.join(projectRoot, '.runtime', 'dev', 'runtime'),
  );
  assert.equal(
    devEnvironment.CODEEX_UPSTREAM_ROOT,
    path.join(projectRoot, '.runtime', 'dev', 'upstream'),
  );
  assert.equal(devEnvironment.PATH, '/usr/bin');
  const overriddenDevEnvironment = createDevEnvironment({
    CODEEX_RUNTIME_ROOT: '/tmp/must-not-be-reused',
    CODEEX_UPSTREAM_ROOT: '/tmp/must-not-be-reused',
    CODEEX_DEV_RUNTIME_ROOT: '/tmp/codeex-dev-runtime',
    CODEEX_DEV_UPSTREAM_ROOT: '/tmp/codeex-dev-upstream',
    CODEEX_DEVTOOLS_PORT: '10433',
    CODEEX_LOVINSP_PORT: '10778',
  }, projectRoot);
  assert.equal(overriddenDevEnvironment.CODEEX_RUNTIME_ROOT, '/tmp/codeex-dev-runtime');
  assert.equal(overriddenDevEnvironment.CODEEX_UPSTREAM_ROOT, '/tmp/codeex-dev-upstream');
  assert.equal(overriddenDevEnvironment.CODEEX_DEVTOOLS_PORT, '10433');
  assert.equal(overriddenDevEnvironment.CODEEX_LOVINSP_PORT, '10778');

  const runtimeEnvironment = createRuntimeEnvironment({
    __CFBundleIdentifier: 'ai.lovstudio.codeex',
    XPC_FLAGS: '0x0',
    XPC_SERVICE_NAME: 'application.ai.lovstudio.codeex',
    CODEEX_LAUNCHED_FROM_FINDER: '1',
    CODEEX_APPLICATION_PATH: '/Applications/Codeex.app',
    CODEEX_PLUGIN_STATE: '/tmp/plugins.json',
  }, '/tmp/Runtime/Codeex.app');
  assert.equal(runtimeEnvironment.__CFBundleIdentifier, undefined);
  assert.equal(runtimeEnvironment.XPC_FLAGS, undefined);
  assert.equal(runtimeEnvironment.XPC_SERVICE_NAME, undefined);
  assert.equal(runtimeEnvironment.CODEEX_LAUNCHED_FROM_FINDER, undefined);
  assert.equal(runtimeEnvironment.CODEEX_APPLICATION_PATH, '/tmp/Runtime/Codeex.app');
  assert.equal(runtimeEnvironment.CODEEX_PLUGIN_STATE, '/tmp/plugins.json');
  assert.equal(parseSupervisorPid('42'), 42);
  assert.equal(parseSupervisorPid('0'), null);
  assert.equal(parseSupervisorPid('not-a-pid'), null);
  assert.equal(isSupervisorAttached(42, { currentParentPid: 42, signal: () => {} }), true);
  assert.equal(isSupervisorAttached(42, { currentParentPid: 1, signal: () => {} }), false);
  assert.equal(isSupervisorAttached(42, {
    currentParentPid: 42,
    signal: () => { throw new Error('missing'); },
  }), false);

  const launcherSource = await readFile(path.join(projectRoot, 'launcher', 'main.swift'), 'utf8');
  assert.match(launcherSource, /environment\["CODEEX_APPLICATION_PATH"\] = runtimeApp\.path/);
  assert.doesNotMatch(launcherSource, /showFullDiskAccessGuidanceIfNeeded/);
  assert.doesNotMatch(launcherSource, /CodeexFullDiskAccessGuidanceVersion/);
  assert.match(launcherSource, /applicationShouldHandleReopen/);
  assert.match(launcherSource, /private func activateRuntime\(attemptsRemaining:/);
  assert.match(launcherSource, /showCodeex\(\)/);
  const runtimeManagerSource = await readFile(
    path.join(projectRoot, 'scripts', 'runtime-manager.mjs'),
    'utf8',
  );
  assert.doesNotMatch(runtimeManagerSource, /spawnSync\('\/usr\/bin\/open'/);
  const openLauncherSource = await readFile(
    path.join(projectRoot, 'scripts', 'open-launcher.mjs'),
    'utf8',
  );
  assert.match(openLauncherSource, /await controlRequest\(auth, '\/api\/launch', 'POST'\)/);
  assert.match(openLauncherSource, /await waitForRuntime\(auth, deadline\)/);
  assert.match(openLauncherSource, /Codeex is running \(PID/);
  assert.doesNotMatch(openLauncherSource, /Opened Codeex/);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.dev, 'node scripts/dev.mjs');
  assert.match(packageJson.scripts['dev:plugin-center'], /CODEEX_BUILD_TARGET=launcher vite/);
  const launcherPlist = launcherInfoPlist({
    version: '1.2.3&test',
    nodePath: '/tmp/node',
    projectRoot: '/tmp/codeex',
    launcherDist: '/tmp/codeex/.runtime/launcher-ui',
  });
  assert.match(launcherPlist, /<key>LSUIElement<\/key><true\/>/);
  assert.match(launcherPlist, /<key>CodeexRuntimeMode<\/key><string>local-clone<\/string>/);
  assert.match(launcherPlist, /<key>CodeexLauncherDist<\/key><string>\/tmp\/codeex\/\.runtime\/launcher-ui<\/string>/);
  assert.match(launcherPlist, /<key>CFBundleVersion<\/key><string>1\.2\.3&amp;test<\/string>/);
  assert.doesNotMatch(launcherPlist, /CodeexRuntime<\/string>/);
  const identityFixture = [
    '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Example Team (TEAMID1234)"',
    '  2) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Developer (TEAMID1234)"',
  ].join('\n');
  const parsedIdentities = parseDeveloperIdIdentities(identityFixture);
  assert.equal(parsedIdentities.length, 1);
  assert.equal(parsedIdentities[0].hash, 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
  const stablePlan = resolveCodeSigningIdentity({
    env: {},
    discoveredIdentities: parsedIdentities,
  });
  assert.equal(stablePlan.stable, true);
  const fallbackPlan = resolveCodeSigningIdentity({
    env: {},
    discoveredIdentities: [],
  });
  assert.equal(fallbackPlan.identity, '-');
  assert.equal(fallbackPlan.stable, false);
  const grantedAccess = await detectFullDiskAccess({
    platform: 'darwin',
    env: {},
    openProbe: async () => ({
      read: async () => ({ bytesRead: 1 }),
      close: async () => {},
    }),
  });
  assert.equal(grantedAccess.state, 'granted');
  const deniedAccess = await detectFullDiskAccess({
    platform: 'darwin',
    env: {},
    openProbe: async () => {
      const error = new Error('denied');
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(deniedAccess.state, 'not-granted');
  assert.equal(await realpath(projectRoot), projectRoot);
  const initial = await request('/api/status');
  assert.equal(initial.permissions.fullDiskAccess.state, 'not-granted');
  assert.equal(initial.plugins.find((plugin) => plugin.id === 'archive-sidebar').installed, false);
  assert.equal(initial.plugins.find((plugin) => plugin.id === 'lovinsp').installed, true);
  assert.equal(initial.plugins.find((plugin) => plugin.id === 'daemonize').installed, false);
  const installed = await request('/api/plugins/daemonize/install', 'POST');
  assert.equal(installed.restartRequired, true);
  assert.equal(installed.plugins.find((plugin) => plugin.id === 'daemonize').installed, true);
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(saved.installed, ['daemonize', 'lovinsp']);
  activePluginIds = ['daemonize', 'lovinsp'];
  const active = await request('/api/status');
  assert.equal(active.restartRequired, false);
  await request('/api/restart', 'POST');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(restartRequests, 1);
  await request('/api/launch', 'POST');
  assert.equal(launchRequests, 1);
  await request('/api/permissions/full-disk-access/open-settings', 'POST');
  assert.equal(fullDiskAccessSettingsRequests, 1);
  console.log('✓ Plugin state, authenticated control API, and launch/restart handoff passed');
} finally {
  await control.close();
  await rm(temporary, { recursive: true, force: true });
}
