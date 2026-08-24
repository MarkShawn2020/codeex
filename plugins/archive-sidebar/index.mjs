import { readFile, writeFile } from 'node:fs/promises';
import {
  ARCHIVE_SETTINGS_ROUTE,
  RUNTIME_MARKER,
  installArchiveSidebar,
} from './runtime.mjs';

export async function transformWebview(context) {
  if (!context?.stage || !context?.entryFile) {
    throw new Error('Codeex webview context is incomplete.');
  }
  const entryCode = await readFile(context.entryFile, 'utf8');
  if (entryCode.includes(RUNTIME_MARKER)) {
    return {
      pluginId: 'archive-sidebar',
      route: ARCHIVE_SETTINGS_ROUTE,
      runtimeMarkers: 1,
      transformedFiles: 0,
    };
  }
  const runtime = `\n;(${installArchiveSidebar.toString()})(globalThis);\n`;
  await writeFile(context.entryFile, `${entryCode}${runtime}`);
  return {
    pluginId: 'archive-sidebar',
    route: ARCHIVE_SETTINGS_ROUTE,
    runtimeMarkers: 1,
    transformedFiles: 1,
  };
}
