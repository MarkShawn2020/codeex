import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Check,
  ChevronRight,
  Eye,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  Play,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { api } from './api';
import type { PluginStatus } from './types';
import logoSvg from '../assets/logo.svg?raw';

function PluginIcon({ type }: { type: PluginStatus['icon'] }) {
  return <span className="plugin-icon">{type === 'inspect' ? <Eye /> : <Server />}</span>;
}

function PluginCard({ plugin }: { plugin: PluginStatus }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (installed: boolean) => api.setInstalled(plugin.id, installed),
    onSuccess: (status) => queryClient.setQueryData(['status'], status),
  });
  return (
    <article className="plugin-card">
      <div className="plugin-heading">
        <PluginIcon type={plugin.icon} />
        <div className="plugin-title">
          <div>
            <h3>{plugin.name}</h3>
            <span className="version">v{plugin.version}</span>
          </div>
          <span className="category">{plugin.category}</span>
        </div>
        <button
          className={plugin.installed ? 'button secondary' : 'button primary'}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(!plugin.installed)}
        >
          {mutation.isPending ? (
            <LoaderCircle className="spin" />
          ) : plugin.installed ? (
            '卸载'
          ) : (
            '安装'
          )}
        </button>
      </div>
      <p>{plugin.description}</p>
      <div className="plugin-meta">
        <span className={plugin.active ? 'state active' : 'state'}>
          {plugin.active ? <Check /> : <Power />}
          {plugin.active ? '当前已启用' : plugin.installed ? '重启 Codeex 后启用' : '未安装'}
        </span>
        {plugin.requiresRestart && <span>变更需重启 Codex</span>}
      </div>
      <details>
        <summary>
          权限与作用域 <ChevronRight />
        </summary>
        {plugin.permissions.map((permission) => (
          <div className="permission" key={permission.label}>
            <ShieldCheck />
            <div><strong>{permission.label}</strong><span>{permission.detail}</span></div>
          </div>
        ))}
      </details>
      {mutation.error && <div className="inline-error">{mutation.error.message}</div>}
    </article>
  );
}

export function App() {
  const [filter, setFilter] = useState<'all' | 'installed'>('all');
  const [query, setQuery] = useState('');
  const status = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 1_500,
  });
  const launch = useMutation({
    mutationFn: api.launch,
    onSuccess: () => status.refetch(),
  });
  const restart = useMutation({
    mutationFn: api.restart,
    onSuccess: () => status.refetch(),
  });
  const openFullDiskAccess = useMutation({
    mutationFn: api.openFullDiskAccessSettings,
  });
  const codexState = status.data?.runtime.enhancedCodex.state || 'stopped';
  // Keep the plugin center usable while an older control server is still
  // running during an in-place Codeex upgrade.
  const fullDiskAccess = status.data?.permissions?.fullDiskAccess;
  const plugins = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (status.data?.plugins || []).filter((plugin) => {
      if (filter === 'installed' && !plugin.installed) return false;
      return !normalized || `${plugin.name} ${plugin.description}`.toLowerCase().includes(normalized);
    });
  }, [filter, query, status.data]);

  return (
    <div className="market-shell" data-codeex-market>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" dangerouslySetInnerHTML={{ __html: logoSvg }} />
          <div><strong>Codeex</strong><span>Codex 插件中心</span></div>
        </div>
        <div className="top-actions">
          {status.data && (
            <span className="upstream">Codex {status.data.product.upstreamVersion} · production</span>
          )}
          <button
            className="button launch-button"
            disabled={launch.isPending || codexState === 'starting'}
            onClick={() => launch.mutate()}
          >
            {launch.isPending || codexState === 'starting' ? (
              <><LoaderCircle className="spin" /> 正在准备…</>
            ) : codexState === 'running' ? (
              <><ExternalLink /> 显示 Codeex</>
            ) : (
              <><Play /> 启动 Codeex</>
            )}
          </button>
        </div>
      </header>

      <div className="market-layout">
        <aside>
          <button className={filter === 'all' ? 'nav-item selected' : 'nav-item'} onClick={() => setFilter('all')}>
            <Box /> 插件市场
          </button>
          <button className={filter === 'installed' ? 'nav-item selected' : 'nav-item'} onClick={() => setFilter('installed')}>
            <Check /> 已安装
          </button>
          <div className="aside-note">
            <span>工作方式</span>
            <p>Codeex 主窗口就是完整 Codex；这里仅用于安装和管理本地插件。</p>
          </div>
        </aside>

        <main>
          <div className="hero-row">
            <div><span className="eyebrow">CODEEX LOCAL PLUGINS</span><h1>{filter === 'all' ? '插件中心' : '已安装插件'}</h1><p>为完整 Codex 界面安装可审计、可移除的本地能力。</p></div>
            <label className="search"><Search /><input aria-label="搜索插件" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件" /></label>
          </div>

          {fullDiskAccess?.supported && fullDiskAccess.state !== 'granted' && (
            <div className="access-banner">
              <HardDrive />
              <div>
                <strong>建议启用“完全磁盘访问权限”</strong>
                <span>避免 macOS 分别询问下载、文稿、桌面、项目和附件权限。</span>
                <span>在系统设置中开启 Codeex；若列表中没有，请点击“+”添加 {fullDiskAccess.applicationPath}。完成后重新启动 Codeex。</span>
              </div>
              <button
                className="button primary"
                disabled={openFullDiskAccess.isPending}
                onClick={() => openFullDiskAccess.mutate()}
              >
                {openFullDiskAccess.isPending ? '正在打开…' : '打开系统设置'}
              </button>
            </div>
          )}

          {status.data?.restartRequired && (
            <div className="restart-banner">
              <RefreshCw />
              <div><strong>运行中的 Codeex 尚未应用新配置</strong><span>重启 Codeex 后生效；Daemonize 后台服务不会随界面退出。</span></div>
              <button className="button primary" disabled={restart.isPending} onClick={() => restart.mutate()}>
                {restart.isPending ? '正在重启…' : '重启 Codeex'}
              </button>
            </div>
          )}

          {status.isLoading && <div className="loading"><LoaderCircle className="spin" /> 正在读取本地插件…</div>}
          {status.error && <div className="error-panel"><strong>无法连接 Codeex 控制服务</strong><span>{status.error.message}</span></div>}
          <section className="plugin-list">
            {plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} />)}
            {!status.isLoading && plugins.length === 0 && <div className="empty">没有匹配的插件。</div>}
          </section>
        </main>
      </div>
    </div>
  );
}
