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
import { detectFullDiskAccess } from './macos-permissions.mjs';

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
