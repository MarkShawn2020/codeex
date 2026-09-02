import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  verifyPromptConfiguration,
  verifyRuntime,
  verifyStaticBuild,
} from './verify.mjs';
import {
  resolveCodeSigningIdentity,
  signApplication,
} from './code-signing.mjs';
import { createRuntimeEnvironment } from './runtime-environment.mjs';

const smoke = process.argv.includes('--smoke');
const noLaunch = process.argv.includes('--no-launch');
const withDaemonize = process.argv.includes('--with-daemonize');
const withArchiveSidebar = process.argv.includes('--with-archive-sidebar');
const withPromptConfig = process.argv.includes('--with-prompt-config');
const withSafeArchive = process.argv.includes('--with-safe-archive');
const managedWrapper = process.argv.includes('--managed-wrapper');
const devMode = process.argv.includes('--dev');
const isolated = process.argv.includes('--isolated') || devMode;
const stateFile = isolated ? isolatedPluginState : normalPluginState;
const children = new Set();
let app = null;
let lovinspWatch = null;
let isolatedControl = null;
let activePluginIds = [];
let restarting = false;
let isolatedCodexHome = null;
let isolatedPromptProject = null;

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

async function removeIsolatedDirectory(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
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
    console.log(
      devMode
        ? `✓ Codeex Dev profile: ${userData}`
        : `✓ Enhanced Codex isolated test profile: ${userData}`,
    );
  } else {
    console.log(`✓ Enhanced Codex profile: ${userData}`);
  }
  const launchEnv = await applyBeforeLaunchHooks(plugins, {
    ...createRuntimeEnvironment(baseEnvironment(), cloneApp),
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
    await removeIsolatedDirectory(isolatedCodexHome);
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
  // Preparation is fingerprinted and cheap when current. Running it for the
  // managed wrapper prevents an older cloned app from surviving an official
  // Codex update with stale Info.plist privacy declarations or native assets.
  run(process.execPath, ['scripts/prepare-codex.mjs'], { inherit: true });
  if (isolated) {
    if (devMode) {
      if (!existsSync(stateFile)) {
        await writePluginState(await readPluginState(normalPluginState), stateFile);
      }
    } else {
      await rm(stateFile, { force: true });
      const isolatedPluginIds = ['lovinsp'];
      if (withArchiveSidebar) isolatedPluginIds.unshift('archive-sidebar');
      if (withDaemonize) isolatedPluginIds.unshift('daemonize');
      if (withPromptConfig) isolatedPluginIds.unshift('prompt-config');
      if (withSafeArchive) isolatedPluginIds.unshift('safe-archive');
      await writePluginState({
        schemaVersion: 1,
        installed: isolatedPluginIds,
      }, stateFile);
    }
    if (withDaemonize || withPromptConfig) {
      isolatedCodexHome = await mkdtemp('/tmp/codeex-smoke-');
    }
    if (withPromptConfig) {
      isolatedPromptProject = path.join(isolatedCodexHome, 'prompt-project');
      await mkdir(isolatedPromptProject, { recursive: true });
      isolatedPromptProject = await realpath(isolatedPromptProject);
      await writeFile(
        path.join(isolatedCodexHome, 'config.toml'),
        `[projects.${JSON.stringify(isolatedPromptProject)}]\ntrust_level = "trusted"\n`,
      );
    }
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
      expectPromptConfig: plugins.some((plugin) => plugin.id === 'prompt-config'),
      expectSafeArchive: plugins.some((plugin) => plugin.id === 'safe-archive'),
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
  if (runtime?.promptConfig) {
    console.log('  Prompt Config: system, user, and project configuration UI is active');
  }
  if (runtime?.safeArchive) {
    console.log(`  Safe Archive: active-writer handling ${runtime.safeArchiveVersion} is active`);
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

  if (smoke && withPromptConfig) {
    const catalog = await discoverPlugins();
    const management = await verifyPluginManagement({
      expectedPluginIds: catalog.map((plugin) => plugin.id),
      pluginId: 'prompt-config',
    });
    const restoredState = await readPluginState(stateFile);
    if (!restoredState.installed.includes('prompt-config')) {
      throw new Error('Prompt Config management exercise did not restore desired state.');
    }
    const prompt = await verifyPromptConfiguration({ projectPath: isolatedPromptProject });
    const systemConfig = await readFile(path.join(isolatedCodexHome, 'config.toml'), 'utf8');
    const userAgents = await readFile(path.join(isolatedCodexHome, 'AGENTS.md'), 'utf8');
    const projectAgents = await readFile(path.join(isolatedPromptProject, 'AGENTS.md'), 'utf8');
    if (
      !systemConfig.includes(prompt.systemPrompt) ||
      userAgents !== prompt.userPrompt ||
      projectAgents !== prompt.projectPrompt
    ) {
      throw new Error('Prompt Config UI did not round-trip all three native instruction levels.');
    }
    console.log(
      `✓ Prompt Config rendered with ${management.pluginIds.length} plugins and saved system/user/project prompts`,
    );
  }

  if (smoke) {
    await stopAll();
    // Packaged Electron can leave native helper handles attached after its main
    // process exits. A smoke run has no interactive work left at this point.
    process.exit(0);
  } else {
    console.log('Codeex is running with the full Codex interface. Plugin management is available from the Codeex menu.');
  }
}

main().catch(async (error) => {
  await stopAll();
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
