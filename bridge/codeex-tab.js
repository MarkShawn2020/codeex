(() => {
  const runtimeVersion = '0.7.0';
  const previousBootstrap = window.__CODEEX_TAB_BOOTSTRAP__;
  if (previousBootstrap?.version === runtimeVersion) return;
  previousBootstrap?.dispose?.();

  const config = JSON.parse(atob('__CODEEX_CONTROL_CONFIG__'));
  const groupSelector = '[role="group"][aria-label="Plugin directory"]';
  const hiddenAttribute = 'data-codeex-tab-hidden';
  const handledAttribute = 'data-codeex-tab-handled';
  const panelExtensions = new Map();
  const state = {
    active: false,
    busyPluginId: null,
    busyPermission: false,
    permissionSettingsOpened: false,
    status: null,
    error: null,
    syncing: false,
    refreshTimer: null,
    searchInput: null,
  };
  let controller = null;
  let observer = null;
  let disposed = false;
  const englishDescriptions = {
    lovinsp: 'Inspect the production Codex interface and jump to the matching bundle source.',
    daemonize: 'Keep app-server independent from the window so tasks can recover after a UI restart.',
  };
  const iconMarkup = {
    inspect: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    daemon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/></svg>',
    prompt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z"/><path d="M8 9h8M8 12h5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.7 2.8 8.1 7 10 4.2-1.9 7-5.3 7-10V6l-7-3Z"/><path d="m9.2 12 1.8 1.8 3.8-4"/></svg>',
  };
  const nativeClasses = {
    section: 'codeex-tab-panel flex flex-col gap-4',
    sectionHeader: 'flex items-center justify-between gap-3 pe-0.5 pb-2 text-default [padding-inline-start:var(--sectioned-page-leading-inset,0.5rem)] border-b border-subtle',
    sectionTitle: 'flex min-h-7 items-center gap-1.5 text-lg leading-6 font-medium',
    secondaryText: 'text-secondary text-sm leading-relaxed text-codex-description',
    gridWrap: 'flex min-h-0 flex-1 flex-col',
    gridContainer: '@container',
    grid: 'codeex-plugin-grid grid grid-cols-1 gap-x-6 gap-y-2 @min-[581px]/skills-grid:grid-cols-2',
    card: 'codeex-plugin-card flex flex-col gap-2.5 border-border/40 rounded-2xl border p-2 hover:bg-text/5 outline-none group justify-center border-none text-base select-none',
    cardRow: 'flex items-center gap-3',
    iconOuter: 'shrink-0',
    icon: 'codeex-plugin-icon flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface ring-1 ring-border ring-inset',
    cardBody: 'flex min-w-0 flex-1 items-center gap-3',
    cardCopy: 'flex min-w-0 flex-1 justify-center gap-0.5 flex-col',
    nameRow: 'flex min-w-0 items-center gap-2',
    name: 'codeex-plugin-name truncate text-default font-medium',
    version: 'codeex-plugin-version shrink-0 text-xs text-tertiary',
    description: 'codeex-plugin-description text-secondary text-sm leading-relaxed flex flex-col gap-0.5 text-codex-description',
    descriptionLine: 'line-clamp-1',
    actionWrap: 'flex shrink-0 items-center',
    primaryButton: 'codeex-plugin-action no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-default disabled:opacity-40 flex rounded-lg border-default bg-primary-soft-alpha enabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover h-token-button-composer px-2 py-0 text-base leading-[18px]',
    ghostButton: 'codeex-plugin-action no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-default disabled:opacity-40 flex rounded-lg text-tertiary enabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px]',
  };

  for (const previousStyle of document.querySelectorAll('[data-codeex-tab-styles]')) {
    previousStyle.remove();
  }
  const style = document.createElement('style');
  style.dataset.codeexTabStyles = 'true';
  style.textContent = `
    .codeex-plugin-icon svg {
      fill: none;
      height: 20px;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.65;
      width: 20px;
    }
    .codeex-runtime-state { align-items: center; display: inline-flex; gap: 7px; white-space: nowrap; }
    .codeex-runtime-state::before { background: currentColor; border-radius: 999px; content: ''; height: 6px; opacity: .72; width: 6px; }
    .codeex-restart-row { border-top: 1px solid var(--border-subtle, color-mix(in srgb, currentColor 8%, transparent)); }
    .codeex-access-card { background: color-mix(in srgb, currentColor 2.5%, transparent); }
    .codeex-access-icon svg { fill: none; height: 20px; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.65; width: 20px; }
    .codeex-access-state { align-items: center; display: inline-flex; gap: 6px; white-space: nowrap; }
    .codeex-access-state::before { background: currentColor; border-radius: 999px; content: ''; height: 6px; width: 6px; }
    .codeex-access-state[data-granted="true"] { color: var(--text-success, #3f9b66); }
    .codeex-tab-error { color: var(--text-danger, #c44747); }
  `;
  document.head.append(style);

  function isCurrentRuntime() {
    return !disposed && window.__CODEEX_TAB_BOOTSTRAP__ === controller;
  }

  function controlRequest(path, init) {
    return fetch(`http://127.0.0.1:${config.port}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Codeex-Token': config.token,
        ...(init?.headers || {}),
      },
    }).then(async (response) => {
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) {
        throw new Error(payload?.error || text || `Request failed (${response.status})`);
      }
      return payload;
    });
  }

  function makePluginCard(plugin) {
    const card = document.createElement('article');
    card.className = nativeClasses.card;
    card.dataset.pluginId = plugin.id;
    card.dataset.search = `${plugin.name} ${plugin.description} ${plugin.category}`.toLowerCase();
    card.setAttribute(
      'aria-label',
      `${plugin.name}, ${plugin.installed ? 'installed' : 'not installed'}`,
    );

    const row = document.createElement('div');
    row.className = nativeClasses.cardRow;
    const iconOuter = document.createElement('span');
    iconOuter.className = nativeClasses.iconOuter;
    const icon = document.createElement('span');
    icon.className = nativeClasses.icon;
    icon.innerHTML = iconMarkup[plugin.icon] || iconMarkup.daemon;
    iconOuter.append(icon);

    const body = document.createElement('div');
    body.className = nativeClasses.cardBody;
    const copy = document.createElement('div');
    copy.className = nativeClasses.cardCopy;
    const nameRow = document.createElement('div');
    nameRow.className = nativeClasses.nameRow;
    const name = document.createElement('div');
    name.className = nativeClasses.name;
    name.textContent = plugin.name;
    const version = document.createElement('span');
    version.className = nativeClasses.version;
    version.textContent = `v${plugin.version}`;
    nameRow.append(name, version);

    const description = document.createElement('div');
    description.className = nativeClasses.description;
    const descriptionLine = document.createElement('div');
    descriptionLine.className = nativeClasses.descriptionLine;
    descriptionLine.textContent = englishDescriptions[plugin.id] || plugin.description;
    description.append(descriptionLine);
    copy.append(nameRow, description);

    const actionWrap = document.createElement('div');
    actionWrap.className = nativeClasses.actionWrap;
    const action = document.createElement('button');
    action.className = plugin.installed ? nativeClasses.ghostButton : nativeClasses.primaryButton;
    action.type = 'button';
    action.dataset.installed = String(plugin.installed);
    action.disabled = state.busyPluginId === plugin.id;
    action.textContent = action.disabled ? 'Working…' : plugin.installed ? 'Uninstall' : 'Install';
    action.setAttribute('aria-label', `${plugin.installed ? 'Uninstall' : 'Install'} ${plugin.name}`);
    action.addEventListener('click', () => setPluginInstalled(plugin));
    actionWrap.append(action);
    body.append(copy, actionWrap);
    row.append(iconOuter, body);
    card.append(row);
    return card;
  }

  function makeFullDiskAccessGuide() {
    const access = state.status.permissions?.fullDiskAccess;
    const granted = access?.state === 'granted';
    const card = document.createElement('article');
    card.className = 'codeex-access-card flex items-center gap-3 rounded-xl border border-border/40 p-3';
    card.dataset.codeexFullDiskAccess = granted ? 'granted' : 'required';

    const icon = document.createElement('span');
    icon.className = `${nativeClasses.icon} codeex-access-icon`;
    icon.innerHTML = iconMarkup.shield;

    const copy = document.createElement('div');
    copy.className = 'flex min-w-0 flex-1 flex-col gap-0.5';
    const titleRow = document.createElement('div');
    titleRow.className = 'flex items-center gap-2';
    const title = document.createElement('div');
    title.className = 'text-sm font-medium text-default';
    title.textContent = 'Full Disk Access';
    const accessState = document.createElement('span');
    accessState.className = `codeex-access-state text-xs ${granted ? '' : 'text-tertiary'}`;
    accessState.dataset.granted = String(granted);
    accessState.textContent = granted ? 'Enabled' : 'Recommended';
    titleRow.append(title, accessState);
    const detail = document.createElement('div');
    detail.className = nativeClasses.secondaryText;
    detail.textContent = granted
      ? 'Codeex can work across repositories and protected folders.'
      : state.permissionSettingsOpened
        ? 'Enable Codeex in System Settings, then restart Codeex.'
        : 'Avoid separate prompts for Downloads, Documents, Desktop, projects, and attachments.';
    copy.append(titleRow, detail);
    card.append(icon, copy);

    if (!granted) {
      const action = document.createElement('button');
      action.className = nativeClasses.primaryButton.replace('codeex-plugin-action', 'codeex-access-action');
      action.type = 'button';
      action.disabled = state.busyPermission;
      action.textContent = state.busyPermission ? 'Opening…' : 'Open Settings';
      action.setAttribute('aria-label', 'Open Full Disk Access settings');
      action.addEventListener('click', openFullDiskAccessSettings);
      card.append(action);
    }
    return card;
  }

  function renderPanel() {
    const panel = document.querySelector('[data-codeex-tab-panel]');
    if (!panel) return;
    panel.replaceChildren();

    const header = document.createElement('div');
    header.className = nativeClasses.sectionHeader;
    const title = document.createElement('h2');
    title.className = nativeClasses.sectionTitle;
    title.textContent = 'Local plugins';
    header.append(title);
    if (state.status) {
      const runtime = document.createElement('span');
      const runtimeState = state.status.runtime.enhancedCodex.state;
      runtime.className = `codeex-runtime-state ${nativeClasses.secondaryText}`;
      runtime.dataset.state = runtimeState;
      runtime.textContent = runtimeState === 'running' ? 'Running' : runtimeState === 'starting' ? 'Starting' : 'Stopped';
      header.append(runtime);
    }
    panel.append(header);

    if (state.error) {
      const error = document.createElement('div');
      error.className = `codeex-tab-error ${nativeClasses.secondaryText} px-2`;
      error.textContent = state.error;
      panel.append(error);
    }
    if (!state.status) {
      const loading = document.createElement('div');
      loading.className = `${nativeClasses.secondaryText} px-2 py-4`;
      loading.textContent = 'Loading local plugins…';
      panel.append(loading);
      return;
    }

    panel.append(makeFullDiskAccessGuide());

    const gridWrap = document.createElement('div');
    gridWrap.className = nativeClasses.gridWrap;
    const gridContainer = document.createElement('div');
    gridContainer.className = nativeClasses.gridContainer;
    const grid = document.createElement('div');
    grid.className = nativeClasses.grid;
    for (const plugin of state.status.plugins) {
      grid.append(makePluginCard(plugin));
    }
    gridContainer.append(grid);
    gridWrap.append(gridContainer);
    panel.append(gridWrap);
    filterCards();

    for (const [extensionId, renderExtension] of panelExtensions) {
      try {
        const extension = renderExtension({ status: state.status });
        if (!(extension instanceof Element)) continue;
        extension.dataset.codeexPanelExtension = extensionId;
        panel.append(extension);
      } catch (error) {
        console.error(`Codeex panel extension ${extensionId} failed`, error);
      }
    }

    if (state.status.restartRequired) {
      const banner = document.createElement('div');
      banner.className = 'codeex-restart-row flex min-h-[var(--height-token-row)] items-center gap-3 px-2 pt-3';
      const bannerCopy = document.createElement('div');
      bannerCopy.className = 'flex min-w-0 flex-1 flex-col gap-0.5';
      const strong = document.createElement('div');
      strong.className = 'text-sm font-medium text-default';
      strong.textContent = 'Plugin changes are ready';
      const detail = document.createElement('div');
      detail.className = nativeClasses.secondaryText;
      detail.textContent = 'Restart Codeex to apply the new runtime configuration.';
      bannerCopy.append(strong, detail);
      const restart = document.createElement('button');
      restart.className = nativeClasses.primaryButton.replace('codeex-plugin-action', 'codeex-restart-action');
      restart.type = 'button';
      restart.textContent = 'Restart';
      restart.setAttribute('aria-label', 'Restart Codeex');
      restart.addEventListener('click', restartCodeex);
      banner.append(bannerCopy, restart);
      panel.append(banner);
    }
  }

  async function refreshStatus() {
    let shouldRender = state.status == null || state.error != null;
    try {
      const nextStatus = await controlRequest('/api/status');
      shouldRender ||= JSON.stringify(nextStatus) !== JSON.stringify(state.status);
      state.status = nextStatus;
      state.error = null;
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      shouldRender ||= state.error !== nextError;
      state.error = nextError;
    }
    if (shouldRender) renderPanel();
  }

  async function setPluginInstalled(plugin) {
    if (state.busyPluginId) return;
    state.busyPluginId = plugin.id;
    renderPanel();
    try {
      state.status = await controlRequest(
        `/api/plugins/${encodeURIComponent(plugin.id)}/${plugin.installed ? 'uninstall' : 'install'}`,
        { method: 'POST' },
      );
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busyPluginId = null;
      renderPanel();
    }
  }

  async function openFullDiskAccessSettings() {
    if (state.busyPermission) return;
    state.busyPermission = true;
    renderPanel();
    try {
      await controlRequest('/api/permissions/full-disk-access/open-settings', { method: 'POST' });
      state.permissionSettingsOpened = true;
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busyPermission = false;
      renderPanel();
    }
  }

  async function restartCodeex(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Restarting…';
    try {
      await controlRequest('/api/restart', { method: 'POST' });
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      button.disabled = false;
      button.textContent = 'Restart';
      renderPanel();
    }
  }

  function filterCards() {
    const query = state.searchInput?.value.trim().toLowerCase() || '';
    let visible = 0;
    for (const card of document.querySelectorAll('.codeex-plugin-card')) {
      const matches = !query || card.dataset.search.includes(query);
      card.hidden = !matches;
      if (matches) visible += 1;
    }
    const panel = document.querySelector('[data-codeex-tab-panel]');
    const previous = panel?.querySelector('[data-codeex-tab-empty]');
    previous?.remove();
    if (panel && state.status && visible === 0) {
      const empty = document.createElement('div');
      empty.className = `${nativeClasses.secondaryText} px-2 py-4`;
      empty.dataset.codeexTabEmpty = 'true';
      empty.textContent = 'No Codeex plugins match this search.';
      panel.append(empty);
    }
  }

  function attachSearch() {
    const input = document.querySelector('input[placeholder="Search plugins"]');
    if (state.searchInput === input) return;
    if (state.searchInput) {
      state.searchInput.removeEventListener('input', filterCards);
    }
    state.searchInput = input;
    if (input && state.active) {
      input.addEventListener('input', filterCards);
    }
  }

  function restoreOfficialTabs() {
    const group = document.querySelector(groupSelector);
    if (!group) return;
    for (const button of group.querySelectorAll('button:not([data-codeex-tab])')) {
      if (button.hasAttribute('data-codeex-original-class')) {
        button.className = button.getAttribute('data-codeex-original-class');
        button.removeAttribute('data-codeex-original-class');
      }
      if (button.hasAttribute('data-codeex-original-pressed')) {
        const pressed = button.getAttribute('data-codeex-original-pressed');
        if (pressed) button.setAttribute('aria-pressed', pressed);
        else button.removeAttribute('aria-pressed');
        button.removeAttribute('data-codeex-original-pressed');
      }
    }
  }

  function restoreOfficialContent() {
    for (const element of document.querySelectorAll(`[${hiddenAttribute}]`)) {
      const display = element.getAttribute(hiddenAttribute);
      if (display) element.style.display = display;
      else element.style.removeProperty('display');
      element.removeAttribute(hiddenAttribute);
    }
    document.querySelector('[data-codeex-tab-panel]')?.remove();
    restoreOfficialTabs();
    if (state.searchInput) {
      state.searchInput.removeEventListener('input', filterCards);
    }
    state.searchInput = null;
  }

  function activateCodeex(group, tab) {
    if (!isCurrentRuntime()) return;
    state.active = true;
    for (const button of group.querySelectorAll('button:not([data-codeex-tab])')) {
      if (!button.hasAttribute('data-codeex-original-class')) {
        button.setAttribute('data-codeex-original-class', button.className);
        button.setAttribute('data-codeex-original-pressed', button.getAttribute('aria-pressed') || '');
      }
      button.className = tab.dataset.inactiveClass || button.className;
      button.setAttribute('aria-pressed', 'false');
    }
    tab.className = tab.dataset.selectedClass || tab.className;
    tab.setAttribute('aria-pressed', 'true');
    syncMount();
    refreshStatus();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => { if (state.active) refreshStatus(); }, 2500);
  }

  function deactivateCodeex(tab) {
    state.active = false;
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    tab?.setAttribute('aria-pressed', 'false');
    if (tab?.dataset.inactiveClass) tab.className = tab.dataset.inactiveClass;
    restoreOfficialContent();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('DOMContentLoaded', syncMount);
    deactivateCodeex(document.querySelector('[data-codeex-tab]'));
    panelExtensions.clear();
    document.querySelector('[data-codeex-tab]')?.remove();
    style.remove();
    if (window.__CODEEX_TAB_BOOTSTRAP__ === controller) {
      delete window.__CODEEX_TAB_BOOTSTRAP__;
    }
  }

  controller = {
    version: runtimeVersion,
    get active() { return state.active; },
    registerPanelExtension(id, renderer) {
      if (typeof id !== 'string' || !id || typeof renderer !== 'function') {
        throw new Error('Invalid Codeex panel extension.');
      }
      panelExtensions.set(id, renderer);
      if (state.active) renderPanel();
      return () => {
        if (panelExtensions.get(id) !== renderer) return;
        panelExtensions.delete(id);
        if (state.active) renderPanel();
      };
    },
    render: renderPanel,
    request: controlRequest,
    dispose,
  };
  window.__CODEEX_TAB_BOOTSTRAP__ = controller;

  function syncMount() {
    if (!isCurrentRuntime() || state.syncing) return;
    state.syncing = true;
    try {
      const group = document.querySelector(groupSelector);
      if (!group) {
        // The plugin directory is route-scoped. Leaving it must end the
        // Codeex selection as well as restore the official panels; otherwise
        // returning to Plugins revives a stale active tab that hides them.
        deactivateCodeex(null);
        return;
      }
      let tab = group.querySelector('[data-codeex-tab]');
      const officialButtons = [...group.querySelectorAll('button:not([data-codeex-tab])')];
      const selected = officialButtons.find((button) => button.getAttribute('aria-pressed') === 'true');
      const inactive = officialButtons.find((button) => button.getAttribute('aria-pressed') === 'false');
      if (!tab) {
        tab = document.createElement('button');
        tab.type = 'button';
        tab.textContent = 'Codeex';
        tab.dataset.codeexTab = 'true';
        tab.dataset.selectedClass = selected?.className || '';
        tab.dataset.inactiveClass = inactive?.className || selected?.className || '';
        tab.className = state.active ? tab.dataset.selectedClass : tab.dataset.inactiveClass;
        tab.setAttribute('aria-pressed', String(state.active));
        group.append(tab);
      }
      if (group.dataset.codeexHandlerVersion !== runtimeVersion) {
        group.dataset.codeexHandlerVersion = runtimeVersion;
        group.addEventListener('click', (event) => {
          // An upgraded handler lives on the ancestor capture phase. Older
          // injected listeners on the tab itself therefore cannot render a
          // retired panel in the same renderer session.
          if (!isCurrentRuntime() || group.dataset.codeexHandlerVersion !== runtimeVersion) return;
          const currentTab = event.target.closest?.('[data-codeex-tab]');
          if (!currentTab || !group.contains(currentTab)) return;
          event.stopImmediatePropagation();
          activateCodeex(group, currentTab);
        }, true);
      }
      for (const button of group.querySelectorAll('button')) {
        if (button.dataset.codeexKeyboardVersion === runtimeVersion) continue;
        button.dataset.codeexKeyboardVersion = runtimeVersion;
        button.addEventListener('keydown', (event) => {
          if (!isCurrentRuntime() || button.dataset.codeexKeyboardVersion !== runtimeVersion) return;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = [...group.querySelectorAll('button')];
          const current = buttons.indexOf(event.target);
          if (current < 0) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          let next = current;
          if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = buttons.length - 1;
          else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
          else next = (current + 1) % buttons.length;
          buttons[next].focus();
          buttons[next].click();
        }, true);
      }
      for (const button of officialButtons) {
        if (button.getAttribute(handledAttribute) === runtimeVersion) continue;
        button.setAttribute(handledAttribute, runtimeVersion);
        button.addEventListener('click', () => {
          if (!isCurrentRuntime() || button.getAttribute(handledAttribute) !== runtimeVersion) return;
          // Release our presentation before React's delegated click handler
          // commits the newly selected official tab.
          deactivateCodeex(tab);
        });
      }
      if (!state.active) return;

      tab.setAttribute('aria-pressed', 'true');
      tab.className = tab.dataset.selectedClass || tab.className;
      for (const button of officialButtons) {
        if (!button.hasAttribute('data-codeex-original-class')) {
          button.setAttribute('data-codeex-original-class', button.className);
          button.setAttribute('data-codeex-original-pressed', button.getAttribute('aria-pressed') || '');
        }
        button.className = tab.dataset.inactiveClass || button.className;
        button.setAttribute('aria-pressed', 'false');
      }
      const row = group.parentElement;
      const content = row?.parentElement;
      if (!row || !content) return;
      let panel = content.querySelector(':scope > [data-codeex-tab-panel]');
      let panelCreated = false;
      if (!panel) {
        panel = document.createElement('section');
        panel.className = nativeClasses.section;
        panel.dataset.codeexTabPanel = 'true';
        panel.setAttribute('aria-label', 'Codeex plugins');
        row.insertAdjacentElement('afterend', panel);
        panelCreated = true;
      }
      const children = [...content.children];
      const rowIndex = children.indexOf(row);
      for (const [index, child] of children.entries()) {
        // The official Installed section lives above the directory tabs and
        // remains common to Public, Personal, and Codeex. Only replace the
        // tab-specific content following the tab row.
        if (index <= rowIndex || child === panel || child.hasAttribute(hiddenAttribute)) continue;
        child.setAttribute(hiddenAttribute, child.style.display || '');
        child.style.display = 'none';
      }
      attachSearch();
      if (panelCreated) renderPanel();
    } finally {
      state.syncing = false;
    }
  }

  observer = new MutationObserver(syncMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncMount, { once: true });
  else syncMount();
})();
