import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(cli, args, env) {
  const result = spawnSync(cli, args, { encoding: 'utf8', env });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Codex daemon command failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function version(cli, env) {
  const result = spawnSync(cli, ['--version'], { encoding: 'utf8', env });
  return result.status === 0 ? result.stdout.trim() : null;
}

function ensureManagedStandalone(sourceCli, env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const currentDirectory = path.join(codexHome, 'packages', 'standalone', 'current');
  const managedCli = path.join(currentDirectory, 'codex');
  if (existsSync(managedCli) && version(managedCli, env) === version(sourceCli, env)) {
    return managedCli;
  }
  mkdirSync(currentDirectory, { recursive: true, mode: 0o700 });
  const stagedCli = `${managedCli}.next-${process.pid}`;
  copyFileSync(sourceCli, stagedCli, constants.COPYFILE_FICLONE);
  chmodSync(stagedCli, 0o755);
  renameSync(stagedCli, managedCli);
  return managedCli;
}

export function beforeLaunch(context) {
  if (
    context.env.CODEEX_DISABLE_DAEMON === '1' ||
    context.env.LOV_CODEX_DISABLE_DAEMON === '1'
  ) {
    return { env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1' }, skipped: true };
  }
  const managedCli = ensureManagedStandalone(context.officialCodexCli, context.env);
  run(context.officialCodexCli, ['app-server', 'daemon', 'start'], context.env);
  const version = run(context.officialCodexCli, ['app-server', 'daemon', 'version'], context.env);
  return {
    env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1' },
    daemonVersion: version,
    managedCli,
  };
}
