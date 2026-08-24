import { discoverPlugins } from '../plugins/catalog.mjs';
import { readPluginState, setPluginInstalled } from '../plugins/state.mjs';
import { pluginStateFile } from './paths.mjs';

const [command = 'list', pluginId] = process.argv.slice(2);

async function main() {
  if (command === 'install' || command === 'uninstall') {
    if (!pluginId) throw new Error(`Usage: pnpm plugins ${command} <plugin-id>`);
    await setPluginInstalled(pluginId, command === 'install', pluginStateFile);
    console.log(`✓ ${pluginId} ${command === 'install' ? 'installed' : 'uninstalled'}; restart Codeex to apply`);
  } else if (command !== 'list') {
    throw new Error('Usage: pnpm plugins [list|install|uninstall] [plugin-id]');
  }
  const [catalog, state] = await Promise.all([discoverPlugins(), readPluginState(pluginStateFile)]);
  const installed = new Set(state.installed);
  for (const plugin of catalog) {
    console.log(`${installed.has(plugin.id) ? '●' : '○'} ${plugin.id.padEnd(12)} ${plugin.version}  ${plugin.name}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
