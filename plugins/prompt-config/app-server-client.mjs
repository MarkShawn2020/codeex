import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;

function protocolError(error) {
  if (error == null) return 'Unknown app-server error.';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}

export async function requestAppServer({
  codexCli,
  codexHome,
  method,
  params,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = spawn,
}) {
  if (!codexCli || !codexHome || !method) {
    throw new Error('Prompt Config app-server request is incomplete.');
  }
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(codexCli, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      finish(new Error(`Codex app-server timed out while handling ${method}.`));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null && child.pid != null) {
        const terminate = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGTERM');
        }, 250);
        terminate.unref();
      }
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`Codex app-server initialize failed: ${protocolError(message.error)}`));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ id: 2, method, params });
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        finish(new Error(`Codex ${method} failed: ${protocolError(message.error)}`));
      } else {
        finish(null, message.result);
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch (error) {
            finish(new Error(`Codex app-server returned invalid JSON: ${error.message}`));
          }
        }
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const suffix = stderr.trim() ? ` ${stderr.trim()}` : '';
      finish(new Error(
        `Codex app-server exited before ${method} completed (${signal || code || 'unknown'}).${suffix}`,
      ));
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codeex-prompt-config', version: '0.2.0' },
        capabilities: { experimentalApi: false },
      },
    });
  });
}
