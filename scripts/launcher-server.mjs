import { stat } from 'node:fs/promises';
import {
  launcherDist,
  pluginStateFile,
} from './paths.mjs';
import { startControlServer } from './control-server.mjs';
import { ensureControlAuth } from './control-auth.mjs';
import {
  enhancedCodexStatus,
  launchEnhancedCodex,
  restartEnhancedCodex,
  stopEnhancedCodex,
} from './runtime-manager.mjs';

async function main() {
  await stat(launcherDist);
  const wrapperMode = process.env.CODEEX_WRAPPER_MODE === '1';
  const auth = wrapperMode ? await ensureControlAuth() : null;
  const control = await startControlServer({
    stateFile: pluginStateFile,
    getActivePluginIds: () => [],
    isolated: false,
    staticRoot: launcherDist,
    getRuntimeStatus: enhancedCodexStatus,
    onLaunch: launchEnhancedCodex,
    onRestart: restartEnhancedCodex,
    ...(auth ? { authToken: auth.token, port: auth.port } : {}),
  });
  if (wrapperMode) await launchEnhancedCodex();
  const url = `http://127.0.0.1:${control.port}/?port=${control.port}&token=${encodeURIComponent(control.token)}&mode=${wrapperMode ? 'wrapper' : 'launcher'}`;
  process.stdout.write(`${JSON.stringify({ url, port: control.port })}\n`);
  const close = async () => {
    if (wrapperMode) await stopEnhancedCodex();
    await control.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
