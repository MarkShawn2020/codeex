import { rmSync, watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDevEnvironment,
  devBundleIdentifier,
} from './dev-environment.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const devRoot = path.join(projectRoot, '.runtime', 'dev');
const lockFile = path.join(devRoot, 'runner.lock');
const environment = createDevEnvironment(process.env, projectRoot);
const runtimeScript = path.join(projectRoot, 'scripts', 'start.mjs');
const watchedTargets = [
  { path: path.join(projectRoot, 'bridge'), recursive: true },
  { path: path.join(projectRoot, 'marketplace'), recursive: true },
  { path: path.join(projectRoot, 'plugins'), recursive: true },
  { path: path.join(projectRoot, 'scripts'), recursive: true },
  { path: path.join(projectRoot, 'vite.config.ts'), recursive: false },
];

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
    launchRuntime();
  } finally {
    restarting = false;
  }
  if (restartQueued) {
    restartQueued = false;
    await restartRuntime('queued source changes');
  }
}

function scheduleRestart(target, filename) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  const changed = filename
    ? path.join(path.basename(target.path), String(filename))
    : target.path;
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
      (_event, filename) => { scheduleRestart(target, filename); },
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
  launchRuntime();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : error);
  releaseLock();
  process.exitCode = 1;
});
