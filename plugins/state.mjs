import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  legacyPluginStateFile,
  pluginStateFile as defaultStateFile,
} from '../scripts/paths.mjs';
import { discoverPlugins } from './catalog.mjs';

export const defaultInstalledPluginIds = ['lovinsp'];

export async function readPluginState(stateFile = defaultStateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    return {
      schemaVersion: 1,
      installed: Array.isArray(parsed.installed)
        ? [...new Set(parsed.installed.filter((id) => typeof id === 'string'))]
        : [...defaultInstalledPluginIds],
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (stateFile === defaultStateFile) {
      try {
        const legacy = JSON.parse(await readFile(legacyPluginStateFile, 'utf8'));
        const migrated = {
          schemaVersion: 1,
          installed: Array.isArray(legacy.installed)
            ? [...new Set(legacy.installed.filter((id) => typeof id === 'string'))]
            : [...defaultInstalledPluginIds],
        };
        await writePluginState(migrated, stateFile);
        return migrated;
      } catch (legacyError) {
        if (legacyError?.code !== 'ENOENT') throw legacyError;
      }
    }
    return { schemaVersion: 1, installed: [...defaultInstalledPluginIds] };
  }
}

export async function writePluginState(state, stateFile = defaultStateFile) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const next = `${stateFile}.next-${process.pid}`;
  await writeFile(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(next, stateFile);
}

export async function setPluginInstalled(pluginId, installed, stateFile = defaultStateFile) {
  const catalog = await discoverPlugins();
  if (!catalog.some((plugin) => plugin.id === pluginId)) {
    throw new Error(`Unknown Codeex plugin: ${pluginId}`);
  }
  const state = await readPluginState(stateFile);
  const ids = new Set(state.installed);
  if (installed) ids.add(pluginId);
  else ids.delete(pluginId);
  const next = { schemaVersion: 1, installed: [...ids].sort() };
  await writePluginState(next, stateFile);
  return next;
}

export async function installedPlugins(stateFile = defaultStateFile) {
  const [catalog, state] = await Promise.all([discoverPlugins(), readPluginState(stateFile)]);
  const installed = new Set(state.installed);
  return catalog.filter((plugin) => installed.has(plugin.id));
}
