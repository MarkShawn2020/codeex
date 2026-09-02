import os from 'node:os';
import path from 'node:path';

export const devBundleIdentifier = 'ai.lovstudio.codeex.dev';
export const devDisplayName = 'Codeex Dev';
export const defaultDevtoolsPort = 9433;
export const defaultLovinspPort = 5778;

export function createDevWatchTargets(projectRoot) {
  return [
    { path: path.join(projectRoot, 'bridge'), recursive: true },
    { path: path.join(projectRoot, 'marketplace'), recursive: true },
    { path: path.join(projectRoot, 'plugins'), recursive: true },
    { path: path.join(projectRoot, 'scripts'), recursive: true },
    // Watching this file directly on macOS emits a change event when Vite's
    // config runner merely opens it. Watch the containing directory and filter
    // by filename so a read cannot terminate a healthy Codeex Dev runtime.
    { path: projectRoot, recursive: false, filename: 'vite.config.ts' },
  ];
}

export function describeDevWatchChange(target, filename) {
  const changed = filename == null ? '' : String(filename);
  if (target.filename && changed !== target.filename) return null;
  return changed ? path.join(path.basename(target.path), changed) : target.path;
}

export function resolveDevRoot(source = process.env, homeDirectory = os.homedir()) {
  return path.resolve(
    source.CODEEX_DEV_ROOT ||
      path.join(homeDirectory, 'Library', 'Application Support', 'Codeex Dev'),
  );
}

export function createDevEnvironment(
  source,
  projectRoot,
  homeDirectory = os.homedir(),
) {
  const devRoot = resolveDevRoot(source, homeDirectory);
  return {
    ...source,
    CODEEX_RUNTIME_ROOT:
      source.CODEEX_DEV_RUNTIME_ROOT || path.join(devRoot, 'runtime'),
    CODEEX_UPSTREAM_ROOT:
      source.CODEEX_DEV_UPSTREAM_ROOT || path.join(devRoot, 'upstream'),
    CODEEX_RUNTIME_BUNDLE_IDENTIFIER:
      source.CODEEX_DEV_BUNDLE_IDENTIFIER || devBundleIdentifier,
    CODEEX_RUNTIME_DISPLAY_NAME:
      source.CODEEX_DEV_DISPLAY_NAME || devDisplayName,
    CODEEX_DEVTOOLS_PORT:
      source.CODEEX_DEVTOOLS_PORT || String(defaultDevtoolsPort),
    CODEEX_LOVINSP_PORT:
      source.CODEEX_LOVINSP_PORT || String(defaultLovinspPort),
  };
}
