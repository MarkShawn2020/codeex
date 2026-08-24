import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeLaunch } from '../plugins/daemonize/index.mjs';
import { officialCodexCli } from './paths.mjs';

// Keep the path short: macOS unix-domain sockets are limited by SUN_LEN.
const codexHome = await mkdtemp(path.join('/tmp', 'lcd-'));
const env = { ...process.env, CODEX_HOME: codexHome };
try {
  const result = beforeLaunch({ env, officialCodexCli });
  assert.equal(result.env.CODEX_APP_SERVER_USE_LOCAL_DAEMON, '1');
  const version = JSON.parse(result.daemonVersion);
  assert.equal(typeof version, 'object');
  assert.match(JSON.stringify(version), /0\.149\.0-alpha\.4\.1/);
  console.log(`✓ Daemonize started isolated app-server ${JSON.stringify(version)}`);
} finally {
  const stopped = spawnSync(officialCodexCli, ['app-server', 'daemon', 'stop'], {
    env,
    encoding: 'utf8',
  });
  if (stopped.status !== 0) {
    console.error(stopped.stderr || stopped.stdout);
    process.exitCode = 1;
  }
  await rm(codexHome, { recursive: true, force: true });
}
