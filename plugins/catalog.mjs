import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginRoot } from '../scripts/paths.mjs';

function validateManifest(manifest, manifestFile) {
  for (const field of ['id', 'name', 'version', 'description', 'entry']) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      throw new Error(`Invalid plugin manifest ${manifestFile}: missing ${field}`);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    throw new Error(`Invalid plugin id in ${manifestFile}: ${manifest.id}`);
  }
  return manifest;
}

export async function discoverPlugins() {
  const entries = await readdir(pluginRoot, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(pluginRoot, entry.name);
    const manifestFile = path.join(directory, 'plugin.json');
    let manifest;
    try {
      manifest = validateManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.id !== entry.name) {
      throw new Error(`Plugin directory ${entry.name} does not match id ${manifest.id}.`);
    }
    plugins.push({ ...manifest, directory, manifestFile });
  }
  return plugins;
}

export async function loadPluginModule(plugin) {
  const entry = path.resolve(plugin.directory, plugin.entry);
  if (!entry.startsWith(`${plugin.directory}${path.sep}`)) {
    throw new Error(`Plugin ${plugin.id} entry escapes its directory.`);
  }
  return await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
}
