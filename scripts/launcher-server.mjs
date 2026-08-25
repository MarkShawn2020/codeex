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
import {
  isSupervisorAttached,
  parseSupervisorPid,
} from './supervisor-lifecycle.mjs';

async function main() {
  await stat(launcherDist);
  const wrapperMode = process.env.CODEEX_WRAPPER_MODE === '1';
  const supervisorPid = wrapperMode
    ? parseSupervisorPid(process.env.CODEEX_SUPERVISOR_PID)
    : null;
  if (wrapperMode && !supervisorPid) {
    throw new Error('Managed Codeex is missing its supervisor process identity.');
  }
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
  let closing = false;
  let supervisorWatchdog = null;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (supervisorWatchdog) clearInterval(supervisorWatchdog);
    try {
      if (wrapperMode) await stopEnhancedCodex();
    } finally {
      await control.close();
      process.exit(0);
    }
  };
  if (wrapperMode) {
    supervisorWatchdog = setInterval(() => {
      if (!isSupervisorAttached(supervisorPid)) void close();
    }, 1_000);
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
