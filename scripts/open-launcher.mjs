import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { controlAuthFile } from './paths.mjs';

const launcher = '/Applications/Codeex.app';
const runtimeTimeoutMs = 120_000;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function validControlAuth(value) {
  return value &&
    Number.isInteger(value.port) &&
    value.port >= 1024 &&
    value.port <= 65535 &&
    typeof value.token === 'string' &&
    /^[a-f0-9]{64}$/.test(value.token);
}

async function readControlAuth() {
  const value = JSON.parse(await readFile(controlAuthFile, 'utf8'));
  if (!validControlAuth(value)) throw new Error('Codeex control credentials are invalid.');
  return value;
}

async function controlRequest(auth, route, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${auth.port}${route}`, {
    method,
    headers: { 'X-Codeex-Token': auth.token },
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`Codeex control request failed (${response.status}).`);
  return await response.json();
}

function runtimeApplicationPath(pid) {
  const command = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  const marker = '.app/Contents/MacOS/';
  const markerIndex = command.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Codeex runtime ${pid} is running from an unexpected executable.`);
  }
  return command.slice(0, markerIndex + 4);
}

async function waitForControl(deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const auth = await readControlAuth();
      await controlRequest(auth, '/api/status');
      return auth;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Codeex launcher did not become ready within ${runtimeTimeoutMs / 1_000} seconds. ` +
    `See ~/Library/Logs/Codeex/supervisor.log.${lastError ? ` Last error: ${lastError.message}` : ''}`,
  );
}

async function waitForRuntime(auth, deadline) {
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const status = await controlRequest(auth, '/api/status');
    const runtime = status?.runtime?.enhancedCodex;
    lastState = runtime?.state || 'unknown';
    if (lastState === 'running' && Number.isInteger(runtime.pid)) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Codeex runtime did not start within ${runtimeTimeoutMs / 1_000} seconds ` +
    `(last state: ${lastState}). See ~/Library/Logs/Codeex/runtime.log.`,
  );
}

try {
  await stat(launcher);
  const deadline = Date.now() + runtimeTimeoutMs;
  run('/usr/bin/open', [launcher]);
  const auth = await waitForControl(deadline);
  await controlRequest(auth, '/api/launch', 'POST');
  const runtime = await waitForRuntime(auth, deadline);
  run('/usr/bin/open', [runtimeApplicationPath(runtime.pid)]);
  console.log(`✓ Codeex is running (PID ${runtime.pid})`);
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('Codeex is not installed. Run `pnpm install:app` first.');
  }
  throw error;
}
