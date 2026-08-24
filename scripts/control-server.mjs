import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPlugins } from '../plugins/catalog.mjs';
import { readPluginState, setPluginInstalled } from '../plugins/state.mjs';
import { prepareStamp, projectRoot } from './paths.mjs';
import {
  detectFullDiskAccess,
  openFullDiskAccessSettings,
} from './macos-permissions.mjs';

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function packageVersion() {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

async function upstreamMetadata() {
  try { return JSON.parse(await readFile(prepareStamp, 'utf8')); } catch { return {}; }
}

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Codeex-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export async function startControlServer({
  stateFile,
  getActivePluginIds,
  isolated,
  codexHome,
  onRestart,
  onLaunch,
  getRuntimeStatus,
  getFullDiskAccessStatus = detectFullDiskAccess,
  onOpenFullDiskAccessSettings = openFullDiskAccessSettings,
  staticRoot,
  authToken,
  port = 0,
}) {
  const token = authToken || randomBytes(24).toString('hex');
  const status = async () => {
    const [catalog, state, metadata, version, fullDiskAccess] = await Promise.all([
      discoverPlugins(),
      readPluginState(stateFile),
      upstreamMetadata(),
      packageVersion(),
      getFullDiskAccessStatus(),
    ]);
    const installed = new Set(state.installed);
    const enhancedCodex = getRuntimeStatus
      ? await getRuntimeStatus()
      : { state: 'running', pid: null, activePluginIds: getActivePluginIds() };
    const active = new Set(enhancedCodex.activePluginIds || []);
    const codexRoot = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const daemonSocket = path.join(codexRoot, 'app-server-control', 'app-server-control.sock');
    return {
      product: {
        name: 'Codeex',
        version,
        upstreamVersion: metadata.fingerprint?.version || 'unknown',
        buildFlavor: metadata.fingerprint?.buildFlavor || 'unknown',
      },
      plugins: catalog.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        category: plugin.category,
        icon: plugin.icon,
        permissions: plugin.permissions || [],
        installed: installed.has(plugin.id),
        active: active.has(plugin.id),
        requiresRestart: Boolean(plugin.requiresRestart),
      })),
      restartRequired: enhancedCodex.state === 'running' &&
        [...installed].sort().join('\0') !== [...active].sort().join('\0'),
      permissions: {
        fullDiskAccess,
      },
      runtime: {
        daemonAvailable: await exists(daemonSocket),
        isolated: Boolean(isolated),
        enhancedCodex,
      },
    };
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && staticRoot && !url.pathname.startsWith('/api/')) {
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const target = path.resolve(staticRoot, relative);
        if (target !== path.resolve(staticRoot) && !target.startsWith(`${path.resolve(staticRoot)}${path.sep}`)) {
          return send(response, 403, { error: 'Forbidden.' });
        }
        try {
          const body = await readFile(target);
          response.writeHead(200, {
            'Content-Type': contentType(target),
            'Cache-Control': target.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable',
          });
          response.end(body);
        } catch (error) {
          if (error?.code === 'ENOENT') return send(response, 404, { error: 'Not found.' });
          throw error;
        }
        return;
      }
      if (request.method === 'OPTIONS') return send(response, 204, {});
      if (request.headers['x-codeex-token'] !== token) {
        return send(response, 401, { error: 'Unauthorized Codeex request.' });
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return send(response, 200, await status());
      }
      if (request.method === 'POST' && url.pathname === '/api/launch' && onLaunch) {
        await onLaunch();
        return send(response, 202, { accepted: true });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/permissions/full-disk-access/open-settings'
      ) {
        await onOpenFullDiskAccessSettings();
        return send(response, 202, { opened: true });
      }
      const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(install|uninstall)$/);
      if (request.method === 'POST' && pluginMatch) {
        await setPluginInstalled(
          decodeURIComponent(pluginMatch[1]),
          pluginMatch[2] === 'install',
          stateFile,
        );
        return send(response, 200, await status());
      }
      if (request.method === 'POST' && url.pathname === '/api/restart') {
        if (!onRestart) return send(response, 409, { error: 'Codex is not managed by Codeex.' });
        send(response, 202, { accepted: true });
        setTimeout(() => {
          Promise.resolve(onRestart()).catch((error) => {
            console.error(error instanceof Error ? error.stack : error);
          });
        }, 100);
        return;
      }
      send(response, 404, { error: 'Not found.' });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Control server did not bind.');
  return {
    port: address.port,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
