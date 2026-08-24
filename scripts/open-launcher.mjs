import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const launcher = '/Applications/Codeex.app';

try {
  await stat(launcher);
  const result = spawnSync('/usr/bin/open', [launcher], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  console.log('✓ Opened Codeex');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('Codeex is not installed. Run `pnpm install:app` first.');
  }
  throw error;
}
