import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PROMPT_CONFIG_RUNTIME_MARKER,
  transformWebview,
} from './index.mjs';
import {
  SYSTEM_PROMPT_KEY_PATH,
  readPromptConfig,
  readPromptSummary,
  resolvePromptTarget,
  writePromptConfig,
} from './prompt-config.mjs';
import { officialCodexCli } from '../../scripts/paths.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'codeex-prompt-config-'));
const stage = path.join(temporary, 'webview');
const entryFile = path.join(stage, 'assets', 'app-initial-fixture.js');
const codexHome = path.join(temporary, 'codex-home');
const project = path.join(temporary, 'project');

try {
  await mkdir(path.dirname(entryFile), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(entryFile, 'globalThis.__fixture = true;\n');

  const transformed = await transformWebview({ stage, entryFile });
  assert.equal(transformed.transformedFiles, 1);
  const output = await readFile(entryFile, 'utf8');
  assert.ok(output.includes(PROMPT_CONFIG_RUNTIME_MARKER));
  assert.ok(output.includes('data-codeex-prompt-config'));
  assert.ok(output.includes('dataset.promptEditor'));
  assert.ok(!output.includes('dataset.codeexPromptEnvironment'));
  assert.ok(output.includes('dataset.codeexPromptComposerButton'));
  assert.ok(output.includes('dataset.codeexPromptComposer'));
  assert.match(output, /\['system', 'user', 'project'\]/);
  const repeated = await transformWebview({ stage, entryFile });
  assert.equal(repeated.transformedFiles, 0);
  assert.equal(output, await readFile(entryFile, 'utf8'));
  await assert.rejects(
    transformWebview({ stage, entryFile: path.join(temporary, 'outside.js') }),
    /staged Codeex webview/,
  );

  const systemTarget = await resolvePromptTarget({ scope: 'system', codexHome });
  assert.equal(systemTarget.kind, 'config');
  assert.equal(systemTarget.cwd, null);
  assert.equal(systemTarget.filePath, path.join(codexHome, 'config.toml'));
  const userTarget = await resolvePromptTarget({ scope: 'user', codexHome });
  assert.equal(userTarget.kind, 'document');
  assert.equal(userTarget.document.filePath, path.join(codexHome, 'AGENTS.md'));
  const projectTarget = await resolvePromptTarget({
    scope: 'project',
    projectPath: project,
    codexHome,
  });
  const canonicalProject = await realpath(project);
  assert.equal(projectTarget.projectPath, canonicalProject);
  assert.equal(projectTarget.document.filePath, path.join(canonicalProject, 'AGENTS.md'));
  await assert.rejects(
    resolvePromptTarget({ scope: 'project', projectPath: 'relative/project', codexHome }),
    /absolute path/,
  );
  await assert.rejects(
    resolvePromptTarget({ scope: 'unknown', codexHome }),
    /system, user, or project/,
  );

  const calls = [];
  const fakeRequest = async (request) => {
    calls.push(request);
    if (request.method === 'config/read') {
      return {
        config: { [SYSTEM_PROMPT_KEY_PATH]: 'effective system prompt' },
        layers: [{
          name: { type: 'user', file: path.join(codexHome, 'config.toml') },
          version: 'sha256:system',
          config: { [SYSTEM_PROMPT_KEY_PATH]: 'system prompt' },
        }],
      };
    }
    return {
      filePath: path.join(codexHome, 'config.toml'),
      version: 'sha256:next',
      status: 'ok',
      overriddenMetadata: null,
    };
  };
  const fakeRead = await readPromptConfig({
    scope: 'system',
    codexHome,
    officialCodexCli,
    appServerRequest: fakeRequest,
  });
  assert.equal(fakeRead.prompt, 'system prompt');
  assert.equal(fakeRead.effectivePrompt, 'effective system prompt');
  assert.equal(fakeRead.version, 'sha256:system');
  const fakeWrite = await writePromptConfig({
    scope: 'system',
    prompt: 'next system prompt',
    expectedVersion: 'sha256:system',
    codexHome,
    officialCodexCli,
    appServerRequest: fakeRequest,
  });
  assert.equal(fakeWrite.version, 'sha256:next');
  assert.deepEqual(calls.at(-1).params, {
    keyPath: SYSTEM_PROMPT_KEY_PATH,
    value: 'next system prompt',
    mergeStrategy: 'upsert',
    filePath: null,
    expectedVersion: 'sha256:system',
  });

  let retryWrites = 0;
  const retryRequest = async (request) => {
    if (request.method === 'config/value/write') {
      retryWrites += 1;
      if (retryWrites === 1) {
        throw new Error('Configuration was modified since last read.');
      }
      assert.equal(request.params.expectedVersion, 'sha256:latest');
      return {
        filePath: path.join(codexHome, 'config.toml'),
        version: 'sha256:retried',
        status: 'ok',
      };
    }
    return {
      config: { [SYSTEM_PROMPT_KEY_PATH]: 'system prompt' },
      layers: [{
        name: { type: 'user', file: path.join(codexHome, 'config.toml') },
        version: 'sha256:latest',
        config: { [SYSTEM_PROMPT_KEY_PATH]: 'system prompt' },
      }],
    };
  };
  const retriedWrite = await writePromptConfig({
    scope: 'system',
    prompt: 'retried system prompt',
    expectedPrompt: 'system prompt',
    expectedVersion: 'sha256:stale',
    codexHome,
    officialCodexCli,
    appServerRequest: retryRequest,
  });
  assert.equal(retriedWrite.version, 'sha256:retried');
  assert.equal(retryWrites, 2);

  await assert.rejects(
    writePromptConfig({
      scope: 'system',
      prompt: 'must not overwrite another system prompt',
      expectedPrompt: 'older system prompt',
      expectedVersion: 'sha256:stale',
      codexHome,
      officialCodexCli,
      appServerRequest: async (request) => {
        if (request.method === 'config/value/write') {
          throw new Error('Configuration was modified since last read.');
        }
        return {
          config: { [SYSTEM_PROMPT_KEY_PATH]: 'changed elsewhere' },
          layers: [{
            name: { type: 'user' },
            version: 'sha256:changed',
            config: { [SYSTEM_PROMPT_KEY_PATH]: 'changed elsewhere' },
          }],
        };
      },
    }),
    /System prompt changed on disk/,
  );

  await access(officialCodexCli);
  const systemPrompt = 'Treat the configured prompt hierarchy as developer guidance.';
  const userPrompt = 'Always explain risky changes before applying them.';
  const projectPrompt = 'For this project, run the focused prompt-config test.';
  await writeFile(
    path.join(codexHome, 'config.toml'),
    `[projects.${JSON.stringify(canonicalProject)}]\ntrust_level = "trusted"\n`,
  );

  const initialSystem = await readPromptConfig({
    scope: 'system',
    codexHome,
    officialCodexCli,
  });
  const savedSystem = await writePromptConfig({
    scope: 'system',
    prompt: systemPrompt,
    expectedVersion: initialSystem.version,
    codexHome,
    officialCodexCli,
  });
  assert.equal(savedSystem.status, 'ok');
  const readSystem = await readPromptConfig({
    scope: 'system',
    codexHome,
    officialCodexCli,
  });
  assert.equal(readSystem.prompt, systemPrompt);

  const initialUser = await readPromptConfig({
    scope: 'user',
    codexHome,
    officialCodexCli,
  });
  assert.equal(initialUser.version, null);
  const savedUser = await writePromptConfig({
    scope: 'user',
    prompt: userPrompt,
    expectedVersion: initialUser.version,
    codexHome,
    officialCodexCli,
  });
  assert.equal(savedUser.status, 'ok');
  const readUser = await readPromptConfig({ scope: 'user', codexHome, officialCodexCli });
  assert.equal(readUser.prompt, userPrompt);
  assert.equal(readUser.filePath, path.join(codexHome, 'AGENTS.md'));

  const inheritedProject = await readPromptConfig({
    scope: 'project',
    projectPath: project,
    codexHome,
    officialCodexCli,
  });
  assert.equal(inheritedProject.prompt, '');
  assert.equal(inheritedProject.effectivePrompt, userPrompt);
  assert.equal(inheritedProject.inherited, true);
  const savedProject = await writePromptConfig({
    scope: 'project',
    projectPath: project,
    prompt: projectPrompt,
    expectedVersion: inheritedProject.version,
    codexHome,
    officialCodexCli,
  });
  assert.equal(savedProject.status, 'ok');
  const readProject = await readPromptConfig({
    scope: 'project',
    projectPath: project,
    codexHome,
    officialCodexCli,
  });
  assert.equal(readProject.prompt, projectPrompt);
  assert.equal(readProject.effectivePrompt, `${userPrompt}\n\n${projectPrompt}`);
  assert.equal(readProject.inherited, false);
  assert.match(
    await readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    /developer_instructions/,
  );
  assert.equal(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8'), userPrompt);
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), projectPrompt);

  const summary = await readPromptSummary({
    projectPath: project,
    codexHome,
    officialCodexCli,
  });
  assert.deepEqual(summary.scopes, {
    system: { available: true, configured: true, characters: Array.from(systemPrompt).length },
    user: { available: true, configured: true, characters: Array.from(userPrompt).length },
    project: { available: true, configured: true, characters: Array.from(projectPrompt).length },
  });
  assert.equal(
    summary.totalCharacters,
    Array.from(systemPrompt + userPrompt + projectPrompt).length,
  );

  const summaryWithoutProject = await readPromptSummary({
    codexHome,
    officialCodexCli,
  });
  assert.deepEqual(summaryWithoutProject.scopes.project, {
    available: false,
    configured: false,
    characters: 0,
  });

  await writeFile(path.join(codexHome, 'AGENTS.override.md'), 'Override user prompt');
  const overrideUser = await readPromptConfig({ scope: 'user', codexHome, officialCodexCli });
  assert.equal(overrideUser.prompt, 'Override user prompt');
  assert.equal(overrideUser.filePath, path.join(codexHome, 'AGENTS.override.md'));
  await writeFile(path.join(codexHome, 'AGENTS.override.md'), 'Changed elsewhere');
  await assert.rejects(
    writePromptConfig({
      scope: 'user',
      prompt: 'Stale write',
      expectedVersion: overrideUser.version,
      codexHome,
      officialCodexCli,
    }),
    /changed on disk/,
  );

  console.log('✓ Prompt Config staged runtime and native system/user/project round-trip passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
