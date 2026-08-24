import type { CodeexStatus } from './types';

export type RuntimeConfig = {
  port: number;
  token: string;
  embedded: boolean;
};

const encodedConfig = '__CODEEX_RUNTIME_CONFIG__';

export function runtimeConfig(): RuntimeConfig {
  if (encodedConfig.startsWith('__')) {
    const params = new URLSearchParams(location.search);
    const port = Number(params.get('port') || location.port || 0);
    const token = params.get('token') || '';
    return port && token
      ? { port, token, embedded: true }
      : { port: 0, token: '', embedded: false };
  }
  return JSON.parse(atob(encodedConfig)) as RuntimeConfig;
}

const previewStatus: CodeexStatus = {
  product: {
    name: 'Codeex',
    version: '0.4.0',
    upstreamVersion: '26.818.41509',
    buildFlavor: 'prod',
  },
  restartRequired: false,
  permissions: {
    fullDiskAccess: {
      supported: true,
      state: 'not-granted',
      granted: false,
      applicationPath: '/Applications/Codeex.app',
      requiresRestart: true,
    },
  },
  runtime: {
    daemonAvailable: false,
    isolated: false,
    enhancedCodex: { state: 'stopped', pid: null, activePluginIds: [] },
  },
  plugins: [
    {
      id: 'lovinsp',
      name: 'Lovinsp',
      version: '1.8.0',
      description: '在生产 Codex 界面中检查元素，并定位到对应 bundle 源码。',
      category: '开发工具',
      icon: 'inspect',
      permissions: [{ label: '修改渲染层', detail: '注入元素定位元数据与本地桥' }],
      installed: true,
      active: true,
      requiresRestart: true,
    },
    {
      id: 'daemonize',
      name: 'Daemonize',
      version: '0.1.0',
      description: '让 app-server 独立于界面运行，为界面重启后恢复任务提供基础。',
      category: '运行时',
      icon: 'daemon',
      permissions: [{ label: '后台进程', detail: '启动 Codex app-server daemon' }],
      installed: false,
      active: false,
      requiresRestart: true,
    },
  ],
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const config = runtimeConfig();
  if (!config.embedded) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return previewStatus as T;
  }
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Codeex-Token': config.token,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

export const api = {
  status: () => request<CodeexStatus>('/api/status'),
  setInstalled: (pluginId: string, installed: boolean) =>
    request<CodeexStatus>(
      `/api/plugins/${encodeURIComponent(pluginId)}/${installed ? 'install' : 'uninstall'}`,
      { method: 'POST' },
    ),
  restart: () => request<{ accepted: boolean }>('/api/restart', { method: 'POST' }),
  launch: () => request<{ accepted: boolean }>('/api/launch', { method: 'POST' }),
  openFullDiskAccessSettings: () =>
    request<{ opened: boolean }>(
      '/api/permissions/full-disk-access/open-settings',
      { method: 'POST' },
    ),
};
