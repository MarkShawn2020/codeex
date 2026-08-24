import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  cloneApp,
  cloneExecutable,
  codeexUserData,
  devtoolsPort,
  isolatedPluginState,
  isolatedUserData,
  officialCodexCli,
  pluginStateFile as normalPluginState,
  projectRoot,
  runtimeActivePlugins,
  workRoot,
} from './paths.mjs';
import { discoverPlugins, loadPluginModule } from '../plugins/catalog.mjs';
import { installedPlugins, readPluginState, writePluginState } from '../plugins/state.mjs';
import { startControlServer } from './control-server.mjs';
import {
  verifyArchiveSidebarNavigation,
  verifyPluginManagement,
  verifyRuntime,
  verifyStaticBuild,
} from './verify.mjs';
import {
  resolveCodeSigningIdentity,
  signApplication,
} from './code-signing.mjs';

const isolated = process.argv.includes('--isolated');
const smoke = process.argv.includes('--smoke');
const noLaunch = process.argv.includes('--no-launch');
const withDaemonize = process.argv.includes('--with-daemonize');
const withArchiveSidebar = process.argv.includes('--with-archive-sidebar');
const managedWrapper = process.argv.includes('--managed-wrapper');
const stateFile = isolated ? isolatedPluginState : normalPluginState;
const children = new Set();
let app = null;
let lovinspWatch = null;
let isolatedControl = null;
let activePluginIds = [];
let restarting = false;
let isolatedCodexHome = null;

function baseEnvironment() {
  return {
    ...process.env,
    ...(isolatedCodexHome ? { CODEX_HOME: isolatedCodexHome } : {}),
    ...(isolatedControl ? {
      CODEEX_CONTROL_PORT: String(isolatedControl.port),
      CODEEX_CONTROL_TOKEN: isolatedControl.token,
    } : {}),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
}

function startLovinspWatch() {
  const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteConfig = path.join(projectRoot, 'vite.config.ts');
  const child = spawn(
    process.execPath,
    [
      viteCli,
      'build',
      '--watch',
      '--config',
      viteConfig,
      '--configLoader',
      'runner',
    ],
    {
      // Both Vite and Lovinsp create caches relative to cwd. Packaged launcher
      // code lives in a signed, read-only app bundle, so all mutable build state
      // belongs in the per-user runtime workspace.
      cwd: workRoot,
      env: {
        ...baseEnvironment(),
        CODEEX_BUILD_TARGET: 'lovinsp',
        LOVINSP: '1',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const onChunk = (chunk, destination) => {
      const text = chunk.toString();
      destination.write(text);
      output = `${output}${text}`.slice(-20_000);
      if (/built in [\d.]+(?:ms|s)/i.test(output)) resolve();
    };
    child.stdout.on('data', (chunk) => onChunk(chunk, process.stdout));
    child.stderr.on('data', (chunk) => onChunk(chunk, process.stderr));
    child.once('exit', (code) => reject(new Error(`Lovinsp build watcher exited before ready (${code}).`)));
    child.once('error', reject);
  });
  return { child, ready };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function signClone(signingPlan) {
  spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', cloneApp], { stdio: 'ignore' });
  const applied = signApplication(cloneApp, { plan: signingPlan });
  console.log(
    applied.stable
      ? `✓ Codeex signed with stable identity: ${applied.label}`
      : '⚠ Codeex uses an ad-hoc signature; macOS folder permissions can be requested again after each rebuild.',
  );
}

async function applyBeforeLaunchHooks(plugins, env) {
  const launchEnv = { ...env };
  for (const plugin of plugins) {
    const module = await loadPluginModule(plugin);
    if (typeof module.beforeLaunch !== 'function') continue;
    const result = await module.beforeLaunch({ env: launchEnv, officialCodexCli });
    Object.assign(launchEnv, result?.env || {});
    console.log(`✓ ${plugin.name} launch hook is active`);
  }
  return launchEnv;
}

async function buildAndLaunch() {
  const signingPlan = resolveCodeSigningIdentity();
  const plugins = await installedPlugins(stateFile);
  const installedPluginIds = plugins.map((plugin) => plugin.id);
  const wantsLovinsp = plugins.some((plugin) => plugin.id === 'lovinsp');
  if (wantsLovinsp && !lovinspWatch) {
    lovinspWatch = startLovinspWatch();
    await lovinspWatch.ready;
  } else if (!wantsLovinsp && lovinspWatch) {
    await stopProcess(lovinspWatch.child);
    lovinspWatch = null;
  }

  let staticResult = null;
  if (managedWrapper && !wantsLovinsp) {
    try {
      staticResult = await verifyStaticBuild({
        requireSignature: true,
        requireStableSignature: signingPlan.stable,
        installedPluginIds,
      });
      console.log('✓ Packaged Codeex runtime is already current');
    } catch {
      // A plugin change intentionally invalidates this fast path. Rebuild the
      // installed renderer and sign the complete wrapper before relaunching it.
    }
  }
  // Lovinsp's local source-opening server can move when its preferred port is
  // already occupied. Rebuild its injected client on every managed launch so
  // the packaged renderer always points at the server started above.
  if (!staticResult) {
    run(process.execPath, ['scripts/build-webview.mjs'], {
      inherit: true,
      env: {
        ...baseEnvironment(),
        CODEEX_PLUGIN_STATE: stateFile,
      },
    });
    signClone(signingPlan);
    staticResult = await verifyStaticBuild({
      requireSignature: true,
      requireStableSignature: signingPlan.stable,
      installedPluginIds,
    });
    console.log(`✓ Enhanced Codex signed; plugins: ${installedPluginIds.join(', ') || 'none'}`);
  }
  activePluginIds = installedPluginIds;
  if (noLaunch) return { plugins, staticResult };

  const userData = isolated ? isolatedUserData : codeexUserData;
  await mkdir(userData, { recursive: true });
  const args = [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${userData}`,
  ];
  if (isolated) {
    console.log(`✓ Enhanced Codex isolated test profile: ${userData}`);
  } else {
    console.log(`✓ Enhanced Codex profile: ${userData}`);
  }
  const launchEnv = await applyBeforeLaunchHooks(plugins, {
    ...baseEnvironment(),
    CODEX_SPARKLE_ENABLED: 'false',
  });
  const child = spawn(cloneExecutable, args, {
    cwd: projectRoot,
    env: launchEnv,
    stdio: 'inherit',
  });
  app = child;
  children.add(child);
  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (app === child) app = null;
    console.error(
      `Codeex renderer exited (pid ${child.pid}; code ${code ?? 'none'}; signal ${signal ?? 'none'}; restarting ${restarting}).`,
    );
    if (!restarting && !smoke) {
      stopAll().finally(() => { process.exitCode = code || 0; });
    }
  });
  await spawned;
  if (!isolated) {
    await writeFile(
      runtimeActivePlugins,
      `${JSON.stringify({ pid: child.pid, installed: activePluginIds, launchedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return { plugins, staticResult };
}

async function restartCodeex() {
  if (restarting) return;
  restarting = true;
  try {
    await stopProcess(app);
    await buildAndLaunch();
  } finally {
    restarting = false;
  }
}

async function stopAll() {
  await stopProcess(app);
  if (lovinspWatch) await stopProcess(lovinspWatch.child);
  lovinspWatch = null;
  if (isolatedControl) {
    await isolatedControl.close();
    isolatedControl = null;
  }
  if (isolatedCodexHome) {
    spawnSync(officialCodexCli, ['app-server', 'daemon', 'stop'], {
      env: baseEnvironment(),
      stdio: 'ignore',
    });
    await rm(isolatedCodexHome, { recursive: true, force: true });
    isolatedCodexHome = null;
  }
}

function isolatedDaemonStatus() {
  const result = spawnSync(officialCodexCli, ['app-server', 'daemon', 'version'], {
    env: baseEnvironment(),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopAll().finally(() => process.exit(0)); });
}

async function main() {
  if (!managedWrapper || !existsSync(cloneApp)) {
    run(process.execPath, ['scripts/prepare-codex.mjs'], { inherit: true });
  }
  if (isolated) {
    await rm(stateFile, { force: true });
    const isolatedPluginIds = ['lovinsp'];
    if (withArchiveSidebar) isolatedPluginIds.unshift('archive-sidebar');
    if (withDaemonize) isolatedPluginIds.unshift('daemonize');
    await writePluginState({
      schemaVersion: 1,
      installed: isolatedPluginIds,
    }, stateFile);
    if (withDaemonize) isolatedCodexHome = await mkdtemp('/tmp/lcd-smoke-');
    isolatedControl = await startControlServer({
      stateFile,
      getActivePluginIds: () => activePluginIds,
      isolated: true,
      codexHome: isolatedCodexHome,
    });
  }
  const { plugins } = await buildAndLaunch();
  if (noLaunch) {
    await stopAll();
    return;
  }

  let runtime = null;
  const expectArchiveSidebar = plugins.some((plugin) => plugin.id === 'archive-sidebar');
  try {
    runtime = await verifyRuntime({
      expectArchiveSidebar,
      expectLovinsp: plugins.some((plugin) => plugin.id === 'lovinsp'),
    });
  } catch (error) {
    if (smoke) throw error;
    // Runtime verification is a diagnostic for an interactive, managed launch.
    // A missing/late renderer marker must never close the user's running app.
    console.warn(
      `⚠ Codeex runtime verification did not complete; keeping the app open: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  if (runtime) {
    console.log(`✓ Enhanced production Codex is active (${runtime.title})`);
  }
  if (runtime?.lovinsp) {
    console.log(`  Lovinsp: ${runtime.paths} nodes; bridge ${runtime.port}; ${runtime.sample}`);
  }
  if (runtime?.archiveSidebar) {
    console.log(
      `  Archive Sidebar: ${runtime.archiveSidebarLabel} follows ${runtime.archiveSidebarPreviousLabel}`,
    );
  }
  if (smoke && expectArchiveSidebar) {
    const archiveNavigation = await verifyArchiveSidebarNavigation();
    console.log(`✓ Archive Sidebar opened ${archiveNavigation.path}`);
    const catalog = await discoverPlugins();
    const management = await verifyPluginManagement({
      expectedPluginIds: catalog.map((plugin) => plugin.id),
    });
    const restoredState = await readPluginState(stateFile);
    if (!restoredState.installed.includes('archive-sidebar')) {
      throw new Error('Archive Sidebar management exercise did not restore desired state.');
    }
    console.log(
      `✓ Codeex management rendered ${management.pluginIds.join(', ')} and round-tripped Archive install/uninstall${
        management.usedDirectoryFixture ? ' (isolated directory fixture)' : ''
      }`,
    );
  }

  if (smoke && withDaemonize) {
    const daemonBefore = isolatedDaemonStatus();
    await restartCodeex();
    const resumed = await verifyRuntime({ expectLovinsp: true });
    const daemonAfter = isolatedDaemonStatus();
    if (
      daemonBefore.status !== 'running' ||
      daemonAfter.status !== 'running' ||
      daemonBefore.socketPath !== daemonAfter.socketPath
    ) {
      throw new Error('Daemonize did not preserve its app-server endpoint across UI restart.');
    }
    console.log(
      `✓ Daemonize kept ${daemonAfter.appServerVersion} running while Codeex UI restarted (${resumed.title})`,
    );
  }

  if (smoke) {
    await stopAll();
  } else {
    console.log('Codeex is running with the full Codex interface. Plugin management is available from the Codeex menu.');
  }
}

main().catch(async (error) => {
  await stopAll();
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
