export type Permission = {
  label: string;
  detail: string;
};

export type PluginStatus = {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  icon: 'inspect' | 'daemon';
  permissions: Permission[];
  installed: boolean;
  active: boolean;
  requiresRestart: boolean;
};

export type CodeexStatus = {
  product: {
    name: string;
    version: string;
    upstreamVersion: string;
    buildFlavor: string;
  };
  plugins: PluginStatus[];
  restartRequired: boolean;
  permissions: {
    fullDiskAccess: {
      supported: boolean;
      state: 'granted' | 'not-granted' | 'unknown' | 'unsupported';
      granted: boolean | null;
      applicationPath: string;
      requiresRestart: boolean;
    };
  };
  runtime: {
    daemonAvailable: boolean;
    isolated: boolean;
    enhancedCodex: {
      state: 'stopped' | 'starting' | 'running';
      pid: number | null;
      activePluginIds: string[];
    };
  };
};
