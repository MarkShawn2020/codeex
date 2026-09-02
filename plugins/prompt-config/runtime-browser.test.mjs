import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleControlRequest } from './index.mjs';
import { officialCodexCli } from '../../scripts/paths.mjs';

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

async function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

function html(projectPath) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Prompt Config runtime test</title></head>
  <body>
    <main id="panel"></main>
    <aside>
      <section role="presentation">
        <header><button type="button" aria-expanded="true">Environment</button></header>
        <div><div class="flex flex-col gap-0.5 px-3.5"><button type="button" data-composer-navigation-target="run-location">Local</button></div></div>
      </section>
    </aside>
    <section data-composer-layout="multiline" role="presentation">
      <div data-codex-composer="true" contenteditable="true" aria-label="Do anything"></div>
      <footer data-composer-footer-responsive>
        <div></div>
        <div class="flex min-w-0 flex-1 justify-end">
          <button type="button" data-codeex-prompt-composer-button="true">Stale Prompt</button>
          <div id="composer-controls" class="flex"><button type="button" class="no-drag cursor-interaction flex rounded-full h-token-button-composer px-2 py-0 text-sm text-tertiary" data-composer-navigation-target="reasoning">Medium<svg data-native-model-chevron="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="me-0.5 h-3.5 w-3.5 shrink-0 text-tertiary"><path d="M12.1338 5.94433C12.3919 5.77382 12.7434 5.80202 12.9707 6.02929C13.1979 6.25656 13.2261 6.60807 13.0556 6.8662L12.9707 6.9707L8.47067 11.4707C8.21097 11.7304 7.78896 11.7304 7.52926 11.4707L3.02926 6.9707L2.9443 6.8662C2.77379 6.60807 2.80199 6.25656 3.02926 6.02929C3.25653 5.80202 3.60804 5.77382 3.86617 5.94433L3.97067 6.02929L7.99996 10.0586L12.0293 6.02929L12.1338 5.94433Z"></path></svg></button></div>
        </div>
      </footer>
    </section>
    <script>
      (() => {
        const panel = document.querySelector('#panel');
        let renderer = null;
        window.__CODEEX_TAB_BOOTSTRAP__ = {
          registerPanelExtension(_id, nextRenderer) {
            renderer = nextRenderer;
            this.render();
            return () => { renderer = null; panel.replaceChildren(); };
          },
          render() {
            if (renderer) panel.replaceChildren(renderer({ status: { plugins: [] } }));
          },
          async request(requestPath, init = {}) {
            const response = await fetch(requestPath, {
              ...init,
              headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Prompt Config request failed.');
            return body;
          },
        };
      })();
    </script>
    <script src="/runtime.js"></script>
    <script>
      const waitFor = async (predicate, label, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label + ': ' +
          JSON.stringify(window.__CODEEX_PROMPT_CONFIG__?.snapshot?.()));
      };
      const setNativeValue = (element, value, prototype) => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const composerSelector = '[data-codeex-prompt-composer]';
      (async () => {
        try {
          await waitFor(
            () => document.querySelector('#panel [data-prompt-surface="management"]'),
            'Codeex plugin management prompt panel',
          );
          const composerButton = await waitFor(
            () => document.querySelector('[data-codeex-prompt-composer-button]'),
            'new-task composer prompt button',
          );
          const modelButton = document.querySelector(
            '[data-composer-navigation-target="reasoning"]',
          );
          const composerButtonCount = document.querySelectorAll(
            '[data-codeex-prompt-composer-button]',
          ).length;
          if (composerButtonCount !== 1 || modelButton.nextElementSibling !== composerButton) {
            throw new Error('Prompt button was not mounted once, directly after the model switcher.');
          }
          if (!composerButton.classList.contains('h-token-button-composer') ||
              !composerButton.classList.contains('rounded-full')) {
            throw new Error('Prompt button did not inherit the native composer trigger style.');
          }
          composerButton.click();
          const composerPopover = await waitFor(
            () => document.querySelector(composerSelector),
            'composer prompt popover',
          );
          if (!composerPopover.classList.contains('bg-surface-elevated-secondary/90') ||
              !composerPopover.classList.contains('shadow-xl-spread')) {
            throw new Error('Prompt popover did not inherit the native elevated surface style.');
          }
          const scopeLabels = [...document.querySelectorAll(
            composerSelector + ' [data-prompt-scope]',
          )].map((element) => element.textContent);
          if (scopeLabels.join(',') !== 'System,User,Project') {
            throw new Error('Unexpected prompt scopes: ' + scopeLabels.join(','));
          }

          const systemEditor = await waitFor(() => {
            const editor = document.querySelector(composerSelector + ' [data-prompt-editor]');
            return editor && !editor.disabled && editor.getAttribute('aria-label') === 'System prompt'
              ? editor
              : null;
          }, 'system editor');
          setNativeValue(systemEditor, 'Browser system prompt', HTMLTextAreaElement.prototype);
          document.querySelector(composerSelector + ' [data-prompt-save]').click();
          await waitFor(
            () => window.__CODEEX_PROMPT_CONFIG__.snapshot().notice?.includes('Prompt saved'),
            'system save',
          );

          document.querySelector(composerSelector + ' [data-prompt-scope="user"]').click();
          const userEditor = await waitFor(() => {
            const editor = document.querySelector(composerSelector + ' [data-prompt-editor]');
            return editor && !editor.disabled && editor.getAttribute('aria-label') === 'User prompt'
              ? editor
              : null;
          }, 'user editor');
          setNativeValue(userEditor, 'Browser user prompt', HTMLTextAreaElement.prototype);
          document.querySelector(composerSelector + ' [data-prompt-save]').click();
          await waitFor(
            () => window.__CODEEX_PROMPT_CONFIG__.snapshot().notice?.includes('Prompt saved'),
            'user save',
          );

          document.querySelector(composerSelector + ' [data-prompt-scope="project"]').click();
          const projectInput = await waitFor(
            () => document.querySelector(composerSelector + ' [data-prompt-project-path]'),
            'project path input',
          );
          setNativeValue(projectInput, ${JSON.stringify(projectPath)}, HTMLInputElement.prototype);
          document.querySelector(composerSelector + ' [data-prompt-load]').click();
          const projectEditor = await waitFor(() => {
            const editor = document.querySelector(composerSelector + ' [data-prompt-editor]');
            return editor && !editor.disabled && editor.getAttribute('aria-label') === 'Project prompt'
              ? editor
              : null;
          }, 'project editor');
          setNativeValue(projectEditor, 'Browser project prompt', HTMLTextAreaElement.prototype);
          document.querySelector(composerSelector + ' [data-prompt-save]').click();
          await waitFor(
            () => window.__CODEEX_PROMPT_CONFIG__.snapshot().notice?.includes('Prompt saved'),
            'project save',
          );
          const signalBars = await waitFor(() => {
            const bars = [...composerButton.querySelectorAll(
              '[data-codeex-prompt-signal-bar]',
            )];
            return bars.length === 3 && bars.every((bar) => bar.dataset.configured === 'true')
              ? bars
              : null;
          }, 'configured prompt status bars');
          const chevron = composerButton.querySelector('.codeex-prompt-chevron');
          if (!chevron) throw new Error('Prompt button is missing its dropdown chevron.');
          const modelChevron = modelButton.querySelector(':scope > svg:last-of-type');
          await fetch('/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ok: true,
              snapshot: window.__CODEEX_PROMPT_CONFIG__.snapshot(),
              environmentPromptCount: document.querySelectorAll(
                '[data-codeex-prompt-environment]',
              ).length,
              managementText: document.querySelector(
                '#panel [data-prompt-surface="management"]',
              )?.textContent,
              composerText: document.querySelector(composerSelector)?.textContent,
              composerButtonCount,
              composerButtonAfterModel: modelButton.nextElementSibling === composerButton,
              composerButtonClass: composerButton.className,
              composerButtonTitle: composerButton.title,
              signalScopes: signalBars.map((bar) => ({
                scope: bar.dataset.promptScope,
                configured: bar.dataset.configured,
                available: bar.dataset.available,
              })),
              hasChevron: Boolean(chevron),
              chevronSource: chevron.dataset.codeexPromptChevronSource,
              chevronViewBox: chevron.getAttribute('viewBox'),
              chevronClass: chevron.getAttribute('class'),
              chevronPath: chevron.querySelector('path')?.getAttribute('d'),
              modelChevronPath: modelChevron?.querySelector('path')?.getAttribute('d'),
              composerPopoverClass: composerPopover.className,
              scopeLabels,
            }),
          });
        } catch (error) {
          await fetch('/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: error.message, stack: error.stack }),
          });
        }
      })();
    </script>
  </body>
</html>`;
}

test('Prompt Config browser UI saves system, user, and project prompts from the composer', async (context) => {
  const chrome = await findChrome();
  if (!chrome) {
    context.skip('Chrome-compatible browser is unavailable.');
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-prompt-browser-'));
  const codexHome = path.join(temporary, 'codex-home');
  const project = path.join(temporary, 'project');
  const chromeData = path.join(temporary, 'chrome');
  let browser = null;
  let server = null;
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const canonicalProject = await realpath(project);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      `[projects.${JSON.stringify(canonicalProject)}]\ntrust_level = "trusted"\n`,
    );
    const runtime = await readFile(path.join(pluginDirectory, 'runtime.js'), 'utf8');
    let resolveResult;
    const browserResult = new Promise((resolve) => { resolveResult = resolve; });
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html(canonicalProject));
          return;
        }
        if (url.pathname === '/runtime.js') {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.end(runtime);
          return;
        }
        if (url.pathname === '/result' && request.method === 'POST') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolveResult(result);
          response.end('{}');
          return;
        }
        const handled = await handleControlRequest({
          request,
          url,
          codexHome,
          officialCodexCli,
        });
        if (!handled) {
          response.statusCode = 404;
          response.end('{"error":"Not found"}');
          return;
        }
        response.statusCode = handled.status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(handled.body));
      } catch (error) {
        response.statusCode = error?.statusCode || 500;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    browser = spawn(chrome, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${chromeData}`,
      `http://127.0.0.1:${address.port}/`,
    ], { stdio: 'ignore' });
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Prompt Config browser test timed out.')), 45_000);
      timer.unref();
    });
    const result = await Promise.race([browserResult, timeout]);
    assert.equal(result.ok, true, result.error || result.stack);
    assert.equal(result.snapshot.scope, 'project');
    assert.equal(result.snapshot.composerMounted, true);
    assert.equal(result.snapshot.composerOpen, true);
    assert.equal(result.composerButtonCount, 1);
    assert.equal(result.composerButtonAfterModel, true);
    assert.match(result.composerButtonClass, /h-token-button-composer/);
    assert.equal(result.hasChevron, true);
    assert.equal(result.chevronSource, 'model');
    assert.equal(result.chevronViewBox, '0 0 16 16');
    assert.match(result.chevronClass, /h-3\.5/);
    assert.equal(result.chevronPath, result.modelChevronPath);
    assert.deepEqual(result.signalScopes, [
      { scope: 'system', configured: 'true', available: 'true' },
      { scope: 'user', configured: 'true', available: 'true' },
      { scope: 'project', configured: 'true', available: 'true' },
    ]);
    assert.match(result.composerButtonTitle, /Developer: Configured/);
    assert.match(result.composerButtonTitle, /User: Configured/);
    assert.match(result.composerButtonTitle, /Project: Configured/);
    assert.match(result.composerButtonTitle, /Total: \d+ characters/);
    assert.equal(
      result.snapshot.promptSummary.totalCharacters,
      Array.from('Browser system promptBrowser user promptBrowser project prompt').length,
    );
    assert.match(result.composerPopoverClass, /bg-surface-elevated-secondary\/90/);
    assert.deepEqual(result.scopeLabels, ['System', 'User', 'Project']);
    assert.equal(result.environmentPromptCount, 0);
    assert.match(result.managementText, /Prompt configuration/);
    assert.match(result.composerText, /SystemUserProject/);
    assert.match(
      await readFile(path.join(codexHome, 'config.toml'), 'utf8'),
      /developer_instructions = "Browser system prompt"/,
    );
    assert.equal(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8'), 'Browser user prompt');
    assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), 'Browser project prompt');
  } finally {
    browser?.kill('SIGTERM');
    await new Promise((resolve) => server?.close(resolve) || resolve());
    await rm(temporary, { recursive: true, force: true });
  }
});
