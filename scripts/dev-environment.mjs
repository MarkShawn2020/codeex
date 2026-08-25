import path from 'node:path';

export const devBundleIdentifier = 'ai.lovstudio.codeex.dev';
export const devDisplayName = 'Codeex Dev';
export const defaultDevtoolsPort = 9433;
export const defaultLovinspPort = 5778;

export function createDevEnvironment(source, projectRoot) {
  const devRoot = path.join(projectRoot, '.runtime', 'dev');
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
