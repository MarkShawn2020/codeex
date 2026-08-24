import { spawnSync } from 'node:child_process';
import { open as openFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const fullDiskAccessSettingsURL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export async function detectFullDiskAccess({
  platform = process.platform,
  env = process.env,
  homeDirectory = os.homedir(),
  openProbe = openFile,
} = {}) {
  const applicationPath = env.CODEEX_APPLICATION_PATH || '/Applications/Codeex.app';
  if (platform !== 'darwin') {
    return {
      supported: false,
      state: 'unsupported',
      granted: null,
      applicationPath,
      requiresRestart: false,
    };
  }

  // The native launcher performs this same probe as the responsible Codeex
  // process and passes the result to its Node control service. This avoids
  // accidentally reporting the terminal's TCC state during packaged use.
  if (env.CODEEX_FULL_DISK_ACCESS === '1' || env.CODEEX_FULL_DISK_ACCESS === '0') {
    const granted = env.CODEEX_FULL_DISK_ACCESS === '1';
    return {
      supported: true,
      state: granted ? 'granted' : 'not-granted',
      granted,
      applicationPath,
      requiresRestart: !granted,
    };
  }

  const probePath = path.join(
    homeDirectory,
    'Library',
    'Application Support',
    'com.apple.TCC',
    'TCC.db',
  );
  let handle;
  try {
    handle = await openProbe(probePath, 'r');
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, 0);
    return {
      supported: true,
      state: 'granted',
      granted: true,
      applicationPath,
      requiresRestart: false,
    };
  } catch (error) {
    const denied = error?.code === 'EPERM' || error?.code === 'EACCES';
    return {
      supported: true,
      state: denied ? 'not-granted' : 'unknown',
      granted: denied ? false : null,
      applicationPath,
      requiresRestart: true,
    };
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export function openFullDiskAccessSettings({ spawn = spawnSync } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Full Disk Access settings are only available on macOS.');
  }
  const result = spawn('/usr/bin/open', [fullDiskAccessSettingsURL], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Could not open Full Disk Access settings${detail ? `: ${detail}` : '.'}`);
  }
  return { opened: true };
}
