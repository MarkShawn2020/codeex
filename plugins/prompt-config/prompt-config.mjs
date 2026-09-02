import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestAppServer } from './app-server-client.mjs';

export const PROMPT_CONFIG_ROUTE = '/api/plugins/prompt-config/config';
export const SYSTEM_PROMPT_KEY_PATH = 'developer_instructions';
export const PROMPT_KEY_PATH = SYSTEM_PROMPT_KEY_PATH;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_PROMPT_LENGTH = 64 * 1024;
const AGENTS_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md'];

export class PromptConfigRequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PromptConfigRequestError';
    this.statusCode = statusCode;
  }
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function canonicalProjectDirectory(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw new PromptConfigRequestError('Choose an absolute project directory first.');
  }
  const expanded = expandHome(projectPath.trim());
  if (!path.isAbsolute(expanded)) {
    throw new PromptConfigRequestError('Project directory must be an absolute path.');
  }
  try {
    const canonical = await realpath(expanded);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new PromptConfigRequestError(`Project directory does not exist: ${expanded}`);
  }
}

function assertCodexHome(codexHome) {
  if (!codexHome || !path.isAbsolute(codexHome)) {
    throw new PromptConfigRequestError('The Codex home directory is unavailable.', 500);
  }
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function documentVersion(source) {
  return source == null
    ? null
    : `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

async function resolveAgentsDocument(directory) {
  const candidates = await Promise.all(AGENTS_CANDIDATES.map(async (name) => {
    const filePath = path.join(directory, name);
    return { filePath, source: await readOptionalFile(filePath) };
  }));
  const active = candidates.find(({ source }) => source != null && source.trim() !== '');
  const selected = active || candidates.find(({ source }) => source != null) || candidates.at(-1);
  return { ...selected, candidates };
}

export async function resolvePromptTarget({ scope, projectPath, codexHome }) {
  assertCodexHome(codexHome);
  if (scope === 'system') {
    return {
      kind: 'config',
      scope,
      cwd: null,
      filePath: path.join(codexHome, 'config.toml'),
      layerMatches(layer) {
        return layer?.name?.type === 'user';
      },
    };
  }
  if (scope === 'user') {
    return {
      kind: 'document',
      scope,
      directory: codexHome,
      document: await resolveAgentsDocument(codexHome),
    };
  }
  if (scope !== 'project') {
    throw new PromptConfigRequestError('Prompt scope must be system, user, or project.');
  }
  const canonical = await canonicalProjectDirectory(projectPath);
  return {
    kind: 'document',
    scope,
    projectPath: canonical,
    directory: canonical,
    document: await resolveAgentsDocument(canonical),
  };
}

function systemPromptFromLayer(layer) {
  return typeof layer?.config?.[SYSTEM_PROMPT_KEY_PATH] === 'string'
    ? layer.config[SYSTEM_PROMPT_KEY_PATH]
    : '';
}

async function readSystemPrompt({ target, codexHome, officialCodexCli, appServerRequest }) {
  const result = await appServerRequest({
    codexCli: officialCodexCli,
    codexHome,
    method: 'config/read',
    params: { cwd: null, includeLayers: true },
  });
  const layer = result.layers?.find((candidate) => target.layerMatches(candidate));
  const prompt = systemPromptFromLayer(layer);
  const effectivePrompt = typeof result.config?.[SYSTEM_PROMPT_KEY_PATH] === 'string'
    ? result.config[SYSTEM_PROMPT_KEY_PATH]
    : '';
  return {
    scope: target.scope,
    projectPath: null,
    filePath: target.filePath,
    prompt,
    effectivePrompt,
    inherited: false,
    overridden: Boolean(layer) && prompt !== effectivePrompt,
    version: layer?.version || null,
  };
}

async function readDocumentPrompt({ target, codexHome }) {
  const source = target.document.source || '';
  let effectivePrompt = source;
  let inherited = false;
  if (target.scope === 'project') {
    const userDocument = await resolveAgentsDocument(codexHome);
    const userPrompt = userDocument.source || '';
    inherited = source.trim() === '' && userPrompt.trim() !== '';
    effectivePrompt = [userPrompt, source]
      .filter((part) => part.trim() !== '')
      .join('\n\n');
  }
  return {
    scope: target.scope,
    projectPath: target.projectPath || null,
    filePath: target.document.filePath,
    prompt: source,
    effectivePrompt,
    inherited,
    overridden: false,
    version: documentVersion(target.document.source),
  };
}

export async function readPromptConfig({
  scope,
  projectPath,
  codexHome,
  officialCodexCli,
  appServerRequest = requestAppServer,
}) {
  const target = await resolvePromptTarget({ scope, projectPath, codexHome });
  if (target.kind === 'config') {
    return await readSystemPrompt({ target, codexHome, officialCodexCli, appServerRequest });
  }
  return await readDocumentPrompt({ target, codexHome });
}

function promptSummaryEntry(prompt, available = true) {
  const normalized = typeof prompt === 'string' ? prompt.trim() : '';
  return {
    available,
    configured: normalized !== '',
    characters: Array.from(normalized).length,
  };
}

export async function readPromptSummary({
  projectPath,
  codexHome,
  officialCodexCli,
  appServerRequest = requestAppServer,
}) {
  const [system, user] = await Promise.all([
    readPromptConfig({
      scope: 'system',
      codexHome,
      officialCodexCli,
      appServerRequest,
    }),
    readPromptConfig({
      scope: 'user',
      codexHome,
      officialCodexCli,
      appServerRequest,
    }),
  ]);
  let project = null;
  let projectError = null;
  if (typeof projectPath === 'string' && projectPath.trim() !== '') {
    try {
      project = await readPromptConfig({
        scope: 'project',
        projectPath,
        codexHome,
        officialCodexCli,
        appServerRequest,
      });
    } catch (error) {
      if (!(error instanceof PromptConfigRequestError)) throw error;
      projectError = error.message;
    }
  }
  const scopes = {
    system: promptSummaryEntry(system.prompt),
    user: promptSummaryEntry(user.prompt),
    project: project
      ? promptSummaryEntry(project.prompt)
      : promptSummaryEntry('', false),
  };
  return {
    projectPath: project?.projectPath || projectPath?.trim() || null,
    projectError,
    scopes,
    totalCharacters: Object.values(scopes)
      .reduce((total, entry) => total + entry.characters, 0),
  };
}

async function replaceDocumentAtomically({ target, prompt, expectedVersion }) {
  const filePath = target.document.filePath;
  const previousSource = target.document.source;
  const currentVersion = documentVersion(previousSource);
  if ((expectedVersion || null) !== (currentVersion || null)) {
    throw new PromptConfigRequestError(
      `${target.scope === 'project' ? 'Project' : 'User'} prompt changed on disk. Reload it before saving again.`,
      409,
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.codeex-next-${process.pid}-${Date.now()}`;
  await writeFile(temporary, prompt, { mode: 0o600 });
  const latestSource = await readOptionalFile(filePath);
  if (latestSource !== previousSource) {
    await rm(temporary, { force: true });
    throw new PromptConfigRequestError(
      `${target.scope === 'project' ? 'Project' : 'User'} prompt changed while saving. Reload it and try again.`,
      409,
    );
  }
  await rename(temporary, filePath);
  try {
    const verifiedSource = await readFile(filePath, 'utf8');
    if (verifiedSource !== prompt) throw new Error('The saved prompt did not match the requested text.');
  } catch (error) {
    const rollback = `${filePath}.codeex-rollback-${process.pid}-${Date.now()}`;
    if (previousSource == null) {
      await rm(filePath, { force: true });
    } else {
      await writeFile(rollback, previousSource, { mode: 0o600 });
      await rename(rollback, filePath);
    }
    throw new Error(
      `${target.scope === 'project' ? 'Project' : 'User'} prompt validation failed; the previous document was restored. ${error.message}`,
    );
  }
  return { filePath, version: documentVersion(prompt) };
}

export async function writePromptConfig({
  scope,
  projectPath,
  prompt,
  expectedVersion,
  expectedPrompt,
  codexHome,
  officialCodexCli,
  appServerRequest = requestAppServer,
}) {
  if (typeof prompt !== 'string') {
    throw new PromptConfigRequestError('Prompt must be text.');
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new PromptConfigRequestError(`Prompt is longer than ${MAX_PROMPT_LENGTH} characters.`);
  }
  const target = await resolvePromptTarget({ scope, projectPath, codexHome });
  if (target.kind === 'config') {
    await mkdir(path.dirname(target.filePath), { recursive: true });
    const writeSystemPrompt = async (version) => await appServerRequest({
        codexCli: officialCodexCli,
        codexHome,
        method: 'config/value/write',
        params: {
          keyPath: SYSTEM_PROMPT_KEY_PATH,
          value: prompt,
          mergeStrategy: 'upsert',
          filePath: null,
          expectedVersion: version || null,
        },
      });
    let result;
    try {
      result = await writeSystemPrompt(expectedVersion);
    } catch (error) {
      if (
        typeof expectedPrompt !== 'string' ||
        !/modified since last read|changed on disk/i.test(error?.message || '')
      ) throw error;
      const current = await readSystemPrompt({
        target,
        codexHome,
        officialCodexCli,
        appServerRequest,
      });
      if (current.prompt !== expectedPrompt) {
        throw new PromptConfigRequestError(
          'System prompt changed on disk. Reload it before saving again.',
          409,
        );
      }
      result = await writeSystemPrompt(current.version);
    }
    return {
      scope: target.scope,
      projectPath: null,
      filePath: result.filePath || target.filePath,
      prompt,
      effectivePrompt: prompt,
      version: result.version,
      status: result.status,
      overridden: result.status === 'okOverridden',
      overriddenMetadata: result.overriddenMetadata || null,
    };
  }

  const saved = await replaceDocumentAtomically({ target, prompt, expectedVersion });
  const refreshedTarget = await resolvePromptTarget({ scope, projectPath, codexHome });
  const refreshed = await readDocumentPrompt({ target: refreshedTarget, codexHome });
  const selectedAfterSave = path.resolve(refreshed.filePath) === path.resolve(saved.filePath);
  const overridden = !selectedAfterSave || refreshed.prompt !== prompt;
  return {
    scope: target.scope,
    projectPath: target.projectPath || null,
    filePath: saved.filePath,
    prompt,
    effectivePrompt: refreshed.effectivePrompt,
    version: saved.version,
    status: overridden ? 'okOverridden' : 'ok',
    overridden,
    overriddenMetadata: null,
  };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new PromptConfigRequestError('Prompt Config request body is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new PromptConfigRequestError('Prompt Config request body is not valid JSON.');
  }
}

export async function handlePromptConfigRequest({
  request,
  url,
  codexHome,
  officialCodexCli,
}) {
  if (url.pathname !== PROMPT_CONFIG_ROUTE) return null;
  const scope = url.searchParams.get('scope') || 'system';
  const projectPath = url.searchParams.get('projectPath') || undefined;
  if (request.method === 'GET') {
    return {
      status: 200,
      body: url.searchParams.get('summary') === '1'
        ? await readPromptSummary({
            projectPath,
            codexHome,
            officialCodexCli,
          })
        : await readPromptConfig({
            scope,
            projectPath,
            codexHome,
            officialCodexCli,
          }),
    };
  }
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    return {
      status: 200,
      body: await writePromptConfig({
        scope: body.scope || scope,
        projectPath: body.projectPath || projectPath,
        prompt: body.prompt,
        expectedVersion: body.expectedVersion,
        expectedPrompt: body.expectedPrompt,
        codexHome,
        officialCodexCli,
      }),
    };
  }
  throw new PromptConfigRequestError('Prompt Config only accepts GET and POST.', 405);
}
