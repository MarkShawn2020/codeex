import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { controlAuthFile } from './paths.mjs';

const defaultControlPort = 9342;

function validAuth(value) {
  return value &&
    Number.isInteger(value.port) &&
    value.port >= 1024 &&
    value.port <= 65535 &&
    typeof value.token === 'string' &&
    /^[a-f0-9]{64}$/.test(value.token);
}

export async function ensureControlAuth() {
  try {
    const existing = JSON.parse(await readFile(controlAuthFile, 'utf8'));
    if (validAuth(existing)) return existing;
  } catch {}

  const auth = {
    schemaVersion: 1,
    port: defaultControlPort,
    token: randomBytes(32).toString('hex'),
  };
  await mkdir(path.dirname(controlAuthFile), { recursive: true, mode: 0o700 });
  const stage = `${controlAuthFile}.next-${process.pid}`;
  await writeFile(stage, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(stage, controlAuthFile);
  await chmod(controlAuthFile, 0o600);
  return auth;
}

export async function reuseExistingControl(
  auth,
  { fetchImpl = fetch, timeoutMs = 3_000 } = {},
) {
  if (!validAuth(auth)) return null;
  const origin = `http://127.0.0.1:${auth.port}`;
  const headers = { 'X-Codeex-Token': auth.token };
  try {
    const statusResponse = await fetchImpl(`${origin}/api/status`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!statusResponse.ok) return null;
    const status = await statusResponse.json();
    if (status?.product?.name !== 'Codeex') return null;

    const launchResponse = await fetchImpl(`${origin}/api/launch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!launchResponse.ok) return null;
    return {
      url: `${origin}/?port=${auth.port}&token=${encodeURIComponent(auth.token)}&mode=wrapper`,
      port: auth.port,
    };
  } catch {
    return null;
  }
}
