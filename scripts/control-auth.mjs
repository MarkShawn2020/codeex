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
