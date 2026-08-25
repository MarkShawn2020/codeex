const inheritedLauncherIdentityKeys = [
  '__CFBundleIdentifier',
  'XPC_FLAGS',
  'XPC_SERVICE_NAME',
  'CODEEX_LAUNCHED_FROM_FINDER',
];

export function createRuntimeEnvironment(source, applicationPath) {
  const environment = { ...source };
  for (const key of inheritedLauncherIdentityKeys) delete environment[key];

  // The Electron process is a separate application. Point application-aware
  // integrations at that bundle instead of the menu-bar supervisor that
  // happened to spawn it.
  environment.CODEEX_APPLICATION_PATH = applicationPath;
  return environment;
}
