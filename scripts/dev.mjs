import { rmSync, watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDevWatchTargets,
  describeDevWatchChange,
  createDevEnvironment,
  devBundleIdentifier,
  resolveDevRoot,
} from './dev-environment.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const devRoot = resolveDevRoot(process.env);
const lockFile = path.join(devRoot, 'runner.lock');
const environment = createDevEnvironment(process.env, projectRoot);
const runtimeScript = path.join(projectRoot, 'scripts', 'start.mjs');
const watchedTargets = createDevWatchTargets(projectRoot);

let child = null;
let stopping = false;
let restarting = false;
let restartQueued = false;
let restartTimer = null;
const watchers = [];

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function devRuntimeProcessIds() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect Codeex Dev processes: ${result.stderr.trim()}`);
  }
  const runtimePrefix = `${environment.CODEEX_RUNTIME_ROOT}${path.sep}`;
  return result.stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter((match) => match && match[2].includes(runtimePrefix))
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid !== process.pid);
}

async function cleanupDevRuntimeProcesses() {
  const stale = devRuntimeProcessIds();
  if (stale.length === 0) return;
  for (const pid of stale) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + 2_000;
  let remaining = stale.filter(processExists);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = remaining.filter(processExists);
  }
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  console.log(`✓ Cleaned ${stale.length} stale Codeex Dev helper processes`);
}

function releaseLock() {
  rmSync(lockFile, { recursive: true, force: true });
}

async function acquireLock() {
  await mkdir(devRoot, { recursive: true });
  try {
    await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' });
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existingPid = null;
    try {
      existingPid = Number((await readFile(lockFile, 'utf8')).trim());
    } catch {}
    if (Number.isSafeInteger(existingPid) && processExists(existingPid)) {
      throw new Error(`Codeex Dev is already running (PID ${existingPid}).`);
    }
    await rm(lockFile, { recursive: true, force: true });
  }
  await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' });
}

async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      reject(new Error(`${label} port ${port} is unavailable: ${error.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(resolve);
    });
  });
}

function launchRuntime() {
  const next = spawn(process.execPath, [runtimeScript, '--dev'], {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });
  child = next;
  next.once('error', (error) => {
    if (!stopping) console.error(error instanceof Error ? error.stack : error);
  });
  next.once('exit', (code, signal) => {
    if (child === next) child = null;
    if (stopping || restarting) return;
    console.error(
      `Codeex Dev stopped (${signal ? `signal ${signal}` : `exit ${code ?? 1}`}).`,
    );
    void shutdown(code ?? 1);
  });
}

async function stopRuntime() {
  const running = child;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => running.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Timed out while stopping Codeex Dev.')),
      15_000,
    )),
  ]);
}

async function restartRuntime(reason) {
  if (stopping) return;
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  try {
    console.log(`↻ Restarting Codeex Dev after ${reason}`);
    await stopRuntime();
    await cleanupDevRuntimeProcesses();
    launchRuntime();
  } finally {
    restarting = false;
  }
  if (restartQueued) {
    restartQueued = false;
    await restartRuntime('queued source changes');
  }
}

function scheduleRestart(changed) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartRuntime(changed).catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      void shutdown(1);
    });
  }, 300);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  try {
    await stopRuntime();
    await cleanupDevRuntimeProcesses();
  } finally {
    releaseLock();
    process.exit(code);
  }
}

async function main() {
  await acquireLock();
  await Promise.all([
    assertPortAvailable(Number(environment.CODEEX_DEVTOOLS_PORT), 'DevTools'),
    assertPortAvailable(Number(environment.CODEEX_LOVINSP_PORT), 'Lovinsp'),
  ]);
  for (const target of watchedTargets) {
    watchers.push(watch(
      target.path,
      { recursive: target.recursive },
      (_event, filename) => {
        const changed = describeDevWatchChange(target, filename);
        if (changed) scheduleRestart(changed);
      },
    ));
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      releaseLock();
      void shutdown(0);
    });
  }
  console.log(
    `✓ Codeex Dev isolated (${devBundleIdentifier}; DevTools ${environment.CODEEX_DEVTOOLS_PORT}; Lovinsp ${environment.CODEEX_LOVINSP_PORT})`,
  );
  await cleanupDevRuntimeProcesses();
  launchRuntime();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : error);
  releaseLock();
  process.exitCode = 1;
});
