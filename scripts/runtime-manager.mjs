import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  cloneApp,
  cloneExecutable,
  projectRoot,
  runtimeActivePlugins,
  runtimeLogFile,
} from './paths.mjs';

const runnerScript = path.join(projectRoot, 'scripts', 'start.mjs');
const wrapperMode = process.env.CODEEX_WRAPPER_MODE === '1';
const runnerArguments = wrapperMode
  ? [runnerScript, '--managed', '--managed-wrapper', `--runtime-app=${cloneApp}`]
  : [runnerScript, '--managed'];
const runnerPrefix = `${process.execPath} ${runnerArguments.join(' ')}`;

function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function matchingPids(prefix) {
  return processRows()
    .filter((row) => row.command === prefix || row.command.startsWith(`${prefix} `))
    .map((row) => row.pid);
}

async function activePluginIds(pid) {
  if (!pid) return [];
  try {
    const state = JSON.parse(await readFile(runtimeActivePlugins, 'utf8'));
    return state.pid === pid && Array.isArray(state.installed) ? state.installed : [];
  } catch {
    return [];
  }
}

export async function enhancedCodexStatus() {
  const runtimePids = matchingPids(cloneExecutable);
  const runnerPids = matchingPids(runnerPrefix);
  const running = runtimePids.length > 0;
  const pid = runtimePids[0] || null;
  return {
    state: running ? 'running' : runnerPids.length > 0 ? 'starting' : 'stopped',
    pid,
    activePluginIds: await activePluginIds(pid),
  };
}

export async function launchEnhancedCodex() {
  const current = await enhancedCodexStatus();
  if (current.state === 'running') {
    spawnSync('/usr/bin/open', [cloneApp], { stdio: 'ignore' });
    return current;
  }
  if (current.state === 'starting') return current;

  await mkdir(path.dirname(runtimeLogFile), { recursive: true });
  const log = openSync(runtimeLogFile, 'a');
  const child = spawn(process.execPath, runnerArguments, {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, CODEEX_LAUNCHED_BY_CODEEX: '1' },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  return { state: 'starting', pid: null, activePluginIds: [] };
}

async function waitUntilStopped(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await enhancedCodexStatus()).state === 'stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out while stopping the enhanced Codex runtime.');
}

export async function stopEnhancedCodex() {
  const rows = processRows();
  const runtimePids = rows
    .filter((row) => row.command === cloneExecutable || row.command.startsWith(`${cloneExecutable} `))
    .map((row) => row.pid);
  const runnerPids = rows
    .filter((row) => row.command === runnerPrefix || row.command.startsWith(`${runnerPrefix} `))
    .map((row) => row.pid);
  for (const pid of runtimePids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (const pid of runnerPids) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  await waitUntilStopped();
}

export async function restartEnhancedCodex() {
  await stopEnhancedCodex();
  return await launchEnhancedCodex();
}
