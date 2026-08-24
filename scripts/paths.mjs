import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Always emit the canonical repository path into Lovinsp metadata. The old
// codex-diy compatibility symlink remains useful for running tasks, but must
// never leak back into newly instrumented production bundles.
export const projectRoot = realpathSync(
  path.resolve(fileURLToPath(new URL('..', import.meta.url))),
);
// Packaged Codeex keeps immutable launcher code inside the signed app and puts
// the cloned official runtime plus generated bridges in Application Support.
// Development continues to use the repository itself for both locations.
export const workRoot = path.resolve(process.env.CODEEX_WORK_ROOT || projectRoot);
export const officialApp = path.resolve(
  process.env.CODEX_APP_PATH || '/Applications/ChatGPT.app',
);
export const officialArchive = path.join(
  officialApp,
  'Contents',
  'Resources',
  'app.asar',
);
export const upstreamRoot = path.join(workRoot, '.codex-upstream');
export const upstreamApp = path.join(upstreamRoot, 'app');
export const sourceWebview = path.join(upstreamApp, 'webview');
export const runtimeRoot = path.join(workRoot, '.runtime');
// The prepared clone is immutable installation input. A packaged Codeex app can
// point the runtime pipeline at its own bundle without ever touching the clone
// that may be serving the current development session.
export const preparedCloneApp = path.join(runtimeRoot, 'Codeex.app');
export const cloneApp = path.resolve(
  process.env.CODEEX_RUNTIME_APP || preparedCloneApp,
);
export const preparedRuntimeBundleIdentifier = 'ai.lovstudio.codeex.runtime';
export const runtimeBundleIdentifier =
  process.env.CODEEX_RUNTIME_BUNDLE_IDENTIFIER || preparedRuntimeBundleIdentifier;
export const runtimeDisplayName = process.env.CODEEX_RUNTIME_DISPLAY_NAME || 'ChatGPT';
export const launcherDist = path.resolve(
  process.env.CODEEX_LAUNCHER_DIST || path.join(runtimeRoot, 'launcher-ui'),
);
export const runtimeActivePlugins = path.resolve(
  process.env.CODEEX_RUNTIME_STATE || path.join(runtimeRoot, 'active-plugins.json'),
);
export const cloneResources = path.join(cloneApp, 'Contents', 'Resources');
export const outputWebview = path.join(
  cloneResources,
  'app.asar.unpacked',
  'webview',
);
export const marketplaceEntry = path.join(projectRoot, 'marketplace', 'main.tsx');
export const lovinspBridgeEntry = path.join(projectRoot, 'bridge', 'main.tsx');
export const codeexTabClient = path.join(projectRoot, 'bridge', 'codeex-tab.js');
export const bridgeDist = path.join(runtimeRoot, 'bridges');
export const marketplaceClient = path.join(bridgeDist, 'marketplace-client.js');
export const lovinspClient = path.join(bridgeDist, 'lovinsp-client.js');
export const pluginRoot = path.join(projectRoot, 'plugins');
export const codeexSupportRoot = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Codeex',
);
export const controlAuthFile = path.join(codeexSupportRoot, 'control.json');
export const codeexUserData = path.resolve(
  process.env.CODEEX_USER_DATA || path.join(codeexSupportRoot, 'Electron'),
);
export const runtimeLogFile = path.join(
  os.homedir(),
  'Library',
  'Logs',
  'Codeex',
  'runtime.log',
);
export const pluginStateFile = path.resolve(
  process.env.CODEEX_PLUGIN_STATE ||
    process.env.LOV_CODEX_PLUGIN_STATE ||
    path.join(codeexSupportRoot, 'plugins.json'),
);
// Read the pre-Codeex local namespace once so existing plugin choices migrate.
const legacyProductName = ['Lov', 'Codex'].join('');
export const legacyPluginStateFile = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  legacyProductName,
  'plugins.json',
);
export const productIcon = path.join(projectRoot, 'assets', 'Codeex.icns');
export const cloneExecutable = path.join(
  process.env.CODEEX_RUNTIME_EXECUTABLE ||
    path.join(cloneApp, 'Contents', 'MacOS', 'ChatGPT'),
);
export const prepareStamp = path.join(upstreamRoot, 'metadata.json');
export const isolatedUserData = path.join(runtimeRoot, 'isolated-user-data');
export const isolatedPluginState = path.join(runtimeRoot, 'isolated-plugins.json');
export const devtoolsPort = Number(
  process.env.CODEEX_DEVTOOLS_PORT || process.env.LOV_CODEX_DEVTOOLS_PORT || 9333,
);
export const officialCodexCli = path.resolve(
  process.env.CODEEX_CODEX_CLI ||
    path.join(cloneApp, 'Contents', 'Resources', 'codex'),
);
