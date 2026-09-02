import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { discoverPlugins } from '../plugins/catalog.mjs';
import { projectRoot } from './paths.mjs';

async function filesBelow(root, extension) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (
        entry.isDirectory() &&
        !['node_modules', '.runtime', '.release', '.codex-upstream', '.git'].includes(entry.name)
      ) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(target);
    }
  }
  return files;
}

const files = await filesBelow(projectRoot, '.mjs');
files.push(path.join(projectRoot, 'bridge', 'codeex-tab.js'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
}
const plugins = await discoverPlugins();
if (!plugins.some((plugin) => plugin.id === 'lovinsp')) throw new Error('Lovinsp plugin missing.');
if (!plugins.some((plugin) => plugin.id === 'daemonize')) throw new Error('Daemonize plugin missing.');
if (!plugins.some((plugin) => plugin.id === 'safe-archive')) {
  throw new Error('Safe Archive plugin missing.');
}
const codeexTab = await readFile(path.join(projectRoot, 'bridge', 'codeex-tab.js'), 'utf8');
for (const nativeClass of [
  'flex flex-col gap-4',
  '@min-[581px]/skills-grid:grid-cols-2',
  'h-token-button-composer',
  'text-codex-description',
  'border-b border-subtle',
]) {
  if (!codeexTab.includes(nativeClass)) {
    throw new Error(`Codeex tab no longer follows the native plugin UI contract: ${nativeClass}`);
  }
}
for (const legacyStyle of ['codeex-tab-intro', 'min-height: 204px', 'translateY(-1px)']) {
  if (codeexTab.includes(legacyStyle)) {
    throw new Error(`Legacy standalone plugin-center styling remains: ${legacyStyle}`);
  }
}
if (!codeexTab.includes('for (const plugin of state.status.plugins)')) {
  throw new Error('Codeex management must render every plugin returned by the catalog.');
}
if (codeexTab.includes("['lovinsp', 'daemonize'].includes(item.id)")) {
  throw new Error('Codeex management still uses the retired hard-coded plugin allowlist.');
}
console.log(`✓ Checked ${files.length} modules and ${plugins.length} plugin manifests`);
