import { cp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  codeexTabClient,
  cloneResources,
  lovinspClient,
  outputWebview,
  pluginStateFile,
  sourceWebview,
} from './paths.mjs';
import { ensureControlAuth } from './control-auth.mjs';
import { loadPluginModule } from '../plugins/catalog.mjs';
import { installedPlugins } from '../plugins/state.mjs';

async function embeddedControlAuth() {
  const configuredPort = process.env.CODEEX_CONTROL_PORT;
  const configuredToken = process.env.CODEEX_CONTROL_TOKEN;
  if (configuredPort === undefined && configuredToken === undefined) {
    return await ensureControlAuth();
  }
  const port = Number(configuredPort);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof configuredToken !== 'string' ||
    !/^[a-f0-9]{48,64}$/.test(configuredToken)
  ) {
    throw new Error('Invalid isolated Codeex control configuration.');
  }
  return { port, token: configuredToken };
}

export async function filesBelow(root, extension) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(extension)) result.push(target);
    }
  }
  return result;
}

export async function buildWebview() {
  const stage = path.join(
    cloneResources,
    'app.asar.unpacked',
    `.webview-next-${process.pid}`,
  );
  await rm(stage, { recursive: true, force: true });
  await cp(sourceWebview, stage, { recursive: true, force: true });

  const indexFile = path.join(stage, 'index.html');
  let html = await readFile(indexFile, 'utf8');
  html = html.replace(
    /connect-src &#39;self&#39;/,
    "connect-src &#39;self&#39; http://127.0.0.1:* http://localhost:*",
  );
  const entryMatch = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^\"]+\.js)"/);
  if (!entryMatch) throw new Error('Could not find the Codex production entry in index.html.');
  const entryFile = path.join(stage, entryMatch[1]);

  const pluginResults = {};
  const plugins = await installedPlugins(pluginStateFile);
  for (const plugin of plugins) {
    const module = await loadPluginModule(plugin);
    if (typeof module.transformWebview !== 'function') continue;
    pluginResults[plugin.id] = await module.transformWebview({
      stage,
      entryFile,
      sourceWebview,
      lovinspClient,
      filesBelow,
    });
  }
  const [tabSource, controlAuth, transformedEntry] = await Promise.all([
    readFile(codeexTabClient, 'utf8'),
    embeddedControlAuth(),
    readFile(entryFile, 'utf8'),
  ]);
  const encodedControlConfig = Buffer.from(JSON.stringify({
    port: controlAuth.port,
    token: controlAuth.token,
  })).toString('base64');
  if (!tabSource.includes('__CODEEX_CONTROL_CONFIG__')) {
    throw new Error('The embedded Codeex tab is missing its control configuration placeholder.');
  }
  const tabRuntime = tabSource.replace('__CODEEX_CONTROL_CONFIG__', encodedControlConfig);
  await writeFile(entryFile, `${tabRuntime}\n${transformedEntry}`);
  await writeFile(indexFile, html);
  await rm(outputWebview, { recursive: true, force: true });
  await rename(stage, outputWebview);

  console.log(`✓ Built enhanced Codex with ${plugins.length} installed plugin(s)`);
  if (pluginResults.lovinsp) {
    console.log(
      `  Lovinsp: ${pluginResults.lovinsp.sourceMarkers} nodes across ${pluginResults.lovinsp.transformedFiles} production chunks`,
    );
  }
  return { plugins: plugins.map((plugin) => plugin.id), pluginResults };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildWebview().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
