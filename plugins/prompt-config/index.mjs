import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handlePromptConfigRequest,
} from './prompt-config.mjs';

export const PROMPT_CONFIG_RUNTIME_MARKER = '__CODEEX_PROMPT_CONFIG__';

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeFile = path.join(pluginDirectory, 'runtime.js');

function assertStagedEntry(stage, entryFile) {
  const stagedRoot = path.resolve(stage);
  const entry = path.resolve(entryFile);
  if (entry !== stagedRoot && !entry.startsWith(`${stagedRoot}${path.sep}`)) {
    throw new Error('Prompt Config can only transform the staged Codeex webview.');
  }
  return entry;
}

export async function transformWebview(context) {
  if (!context?.stage || !context?.entryFile) {
    throw new Error('Codeex webview context is incomplete.');
  }
  const entryFile = assertStagedEntry(context.stage, context.entryFile);
  const source = await readFile(entryFile, 'utf8');
  if (source.includes(PROMPT_CONFIG_RUNTIME_MARKER)) {
    return { pluginId: 'prompt-config', transformedFiles: 0 };
  }
  const runtime = await readFile(runtimeFile, 'utf8');
  if (!runtime.includes(PROMPT_CONFIG_RUNTIME_MARKER)) {
    throw new Error('Prompt Config runtime marker is missing.');
  }
  await writeFile(entryFile, `${source}\n${runtime}\n`);
  return { pluginId: 'prompt-config', transformedFiles: 1 };
}

export async function handleControlRequest(context) {
  return await handlePromptConfigRequest(context);
}
