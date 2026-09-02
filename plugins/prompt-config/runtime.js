(() => {
  const runtimeVersion = '0.2.5';
  const runtimeMarker = '__CODEEX_PROMPT_CONFIG__';
  const previous = window.__CODEEX_PROMPT_CONFIG__;
  const host = window.__CODEEX_TAB_BOOTSTRAP__;
  if (previous?.version === runtimeVersion && previous?.host === host) return;
  previous?.dispose?.();

  if (!host?.registerPanelExtension || !host?.request || !host?.render) {
    console.error('Prompt Config requires the current Codeex panel extension contract.');
    return;
  }

  const storedProjectPathKey = 'codeex.promptConfig.projectPath';
  let interfaceObserver = null;
  let composerPopover = null;
  let activeComposerButton = null;
  const state = {
    scope: 'system',
    projectPath: localStorage.getItem(storedProjectPathKey) || '',
    prompt: '',
    loadedPrompt: '',
    effectivePrompt: '',
    filePath: '',
    version: null,
    inherited: false,
    overridden: false,
    loading: false,
    saving: false,
    error: null,
    notice: null,
    requestToken: 0,
    promptSummary: {
      scopes: {
        system: { available: true, configured: false, characters: 0 },
        user: { available: true, configured: false, characters: 0 },
        project: { available: false, configured: false, characters: 0 },
      },
      totalCharacters: 0,
      projectError: null,
    },
    summaryLoading: false,
    summaryError: null,
    summaryRequestToken: 0,
  };

  const style = document.createElement('style');
  style.dataset.codeexPromptConfigStyles = 'true';
  style.textContent = `
    .codeex-prompt-editor {
      background: color-mix(in srgb, currentColor 2.5%, transparent);
      border: 1px solid var(--border-default, color-mix(in srgb, currentColor 14%, transparent));
      color: var(--text-default, currentColor);
      font: inherit;
      line-height: 1.55;
      min-height: 148px;
      outline: none;
      resize: vertical;
      width: 100%;
    }
    .codeex-prompt-editor:focus,
    .codeex-prompt-project-path:focus {
      border-color: var(--border-focus, color-mix(in srgb, currentColor 34%, transparent));
      box-shadow: 0 0 0 2px var(--ring, color-mix(in srgb, currentColor 11%, transparent));
    }
    .codeex-prompt-project-path {
      background: color-mix(in srgb, currentColor 2.5%, transparent);
      border: 1px solid var(--border-default, color-mix(in srgb, currentColor 14%, transparent));
      color: var(--text-default, currentColor);
      font: inherit;
      min-width: 0;
      outline: none;
      width: 100%;
    }
    .codeex-prompt-scope[data-selected="true"] {
      background: var(--background-primary, color-mix(in srgb, currentColor 9%, transparent));
      color: var(--text-default, currentColor);
    }
    .codeex-prompt-status[data-kind="error"] { color: var(--text-danger, #c44747); }
    .codeex-prompt-status[data-kind="success"] { color: var(--text-success, #3f9b66); }
    .codeex-prompt-composer-popover {
      max-height: min(620px, calc(100vh - 32px));
      position: fixed;
      transform-origin: bottom right;
      width: min(440px, calc(100vw - 24px));
      z-index: 50;
    }
    .codeex-prompt-composer-button[data-open="true"] {
      background: var(--background-primary-ghost-hover, color-mix(in srgb, currentColor 8%, transparent));
      color: var(--text-default, currentColor);
    }
    .codeex-prompt-signal {
      align-items: flex-end;
      display: inline-flex;
      flex: none;
      gap: 1.5px;
      height: 12px;
      justify-content: center;
      width: 12px;
    }
    .codeex-prompt-signal-bar {
      background: var(--text-quaternary, color-mix(in srgb, currentColor 28%, transparent));
      border-radius: 1px;
      display: block;
      transition: background-color 120ms ease, opacity 120ms ease;
      width: 2px;
    }
    .codeex-prompt-signal-bar[data-configured="true"] {
      background: var(--text-default, currentColor);
    }
    .codeex-prompt-signal-bar[data-available="false"] {
      opacity: 0.42;
    }
    .codeex-prompt-chevron {
      flex: none;
      transition: transform 140ms ease;
    }
    .codeex-prompt-composer-button[data-open="true"] .codeex-prompt-chevron {
      transform: rotate(180deg);
    }
  `;
  document.head.append(style);

  const scopeLabels = { system: 'System', user: 'User', project: 'Project' };
  const scopeDescriptions = {
    system: 'Developer instructions applied before user and project guidance.',
    user: 'Global AGENTS guidance applied to every Codex project.',
    project: 'AGENTS guidance applied inside the selected project.',
  };

  function requestPath() {
    const query = new URLSearchParams({ scope: state.scope });
    if (state.scope === 'project') query.set('projectPath', state.projectPath.trim());
    return `/api/plugins/prompt-config/config?${query}`;
  }

  function summaryRequestPath() {
    const query = new URLSearchParams({ summary: '1' });
    if (state.projectPath.trim()) query.set('projectPath', state.projectPath.trim());
    return `/api/plugins/prompt-config/config?${query}`;
  }

  async function loadPromptSummary() {
    const token = ++state.summaryRequestToken;
    state.summaryLoading = true;
    state.summaryError = null;
    syncComposerMounts();
    try {
      const result = await host.request(summaryRequestPath());
      if (token !== state.summaryRequestToken) return;
      state.promptSummary = result;
    } catch (error) {
      if (token !== state.summaryRequestToken) return;
      state.summaryError = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === state.summaryRequestToken) {
        state.summaryLoading = false;
        syncComposerMounts();
      }
    }
  }

  function renderComposerPopover() {
    if (!composerPopover || !activeComposerButton?.isConnected) {
      closeComposerPopover();
      return;
    }
    composerPopover.replaceChildren(makePromptPanel('composer'));
    positionComposerPopover();
  }

  function rerender() {
    host.render();
    syncComposerMounts();
    renderComposerPopover();
  }

  async function loadPrompt() {
    let refreshSummary = false;
    if (state.scope === 'project' && !state.projectPath.trim()) {
      state.prompt = '';
      state.loadedPrompt = '';
      state.effectivePrompt = '';
      state.filePath = '';
      state.version = null;
      state.inherited = false;
      state.overridden = false;
      state.error = null;
      state.notice = 'Enter a project directory to load its prompt.';
      rerender();
      return;
    }
    const token = ++state.requestToken;
    state.loading = true;
    state.error = null;
    state.notice = null;
    rerender();
    try {
      const result = await host.request(requestPath());
      if (token !== state.requestToken) return;
      state.prompt = result.prompt || '';
      state.loadedPrompt = result.prompt || '';
      state.effectivePrompt = result.effectivePrompt || '';
      state.filePath = result.filePath || '';
      state.version = result.version || null;
      state.inherited = Boolean(result.inherited);
      state.overridden = Boolean(result.overridden);
      if (result.projectPath) {
        state.projectPath = result.projectPath;
        localStorage.setItem(storedProjectPathKey, result.projectPath);
        refreshSummary = true;
      }
    } catch (error) {
      if (token !== state.requestToken) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === state.requestToken) {
        state.loading = false;
        rerender();
      }
    }
    if (refreshSummary) await loadPromptSummary();
  }

  async function savePrompt() {
    if (state.saving || state.loading) return;
    const token = ++state.requestToken;
    let refreshSummary = false;
    state.saving = true;
    state.error = null;
    state.notice = null;
    rerender();
    try {
      const result = await host.request('/api/plugins/prompt-config/config', {
        method: 'POST',
        body: JSON.stringify({
          scope: state.scope,
          projectPath: state.scope === 'project' ? state.projectPath.trim() : null,
          prompt: state.prompt,
          expectedVersion: state.version,
          expectedPrompt: state.loadedPrompt,
        }),
      });
      if (token !== state.requestToken) return;
      state.filePath = result.filePath || state.filePath;
      state.version = result.version || null;
      state.loadedPrompt = state.prompt;
      state.effectivePrompt = result.effectivePrompt || state.prompt;
      state.inherited = false;
      state.overridden = Boolean(result.overridden);
      state.notice = result.overridden
        ? 'Saved, but another active instruction file currently takes precedence.'
        : 'Prompt saved. New tasks will use this instruction level.';
      refreshSummary = true;
    } catch (error) {
      if (token !== state.requestToken) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === state.requestToken) {
        state.saving = false;
        rerender();
      }
    }
    if (refreshSummary) await loadPromptSummary();
  }

  function button(label, className) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    return element;
  }

  function makePromptPanel(surface = 'management') {
    const compactSurface = surface === 'composer';
    const section = document.createElement('section');
    section.className = surface === 'composer'
      ? 'codeex-prompt-composer-panel flex flex-col gap-3 p-2.5'
      : 'flex flex-col gap-3 border-t border-subtle pt-4';
    section.dataset.codeexPromptConfig = runtimeMarker;
    section.dataset.promptSurface = surface;

    const headingRow = document.createElement('div');
    headingRow.className = 'flex items-start justify-between gap-3 px-0.5';
    const headingCopy = document.createElement('div');
    headingCopy.className = 'flex min-w-0 flex-col gap-0.5';
    const heading = document.createElement('h3');
    heading.className = 'text-base font-medium text-default';
    heading.textContent = compactSurface ? 'Prompt' : 'Prompt configuration';
    const description = document.createElement('p');
    description.className = 'text-secondary text-sm leading-relaxed text-codex-description';
    description.textContent = scopeDescriptions[state.scope];
    headingCopy.append(heading);
    if (!compactSurface) headingCopy.append(description);

    const scopeGroup = document.createElement('div');
    scopeGroup.className = 'flex shrink-0 items-center rounded-lg bg-text/5 p-0.5';
    scopeGroup.setAttribute('role', 'group');
    scopeGroup.setAttribute('aria-label', 'Prompt scope');
    for (const scope of ['system', 'user', 'project']) {
      const scopeButton = button(
        scopeLabels[scope],
        'codeex-prompt-scope no-drag cursor-interaction rounded-md px-2 py-1 text-sm text-tertiary',
      );
      scopeButton.dataset.promptScope = scope;
      scopeButton.dataset.selected = String(state.scope === scope);
      scopeButton.setAttribute('aria-pressed', String(state.scope === scope));
      scopeButton.addEventListener('click', () => {
        if (state.scope === scope) return;
        state.scope = scope;
        state.prompt = '';
        state.loadedPrompt = '';
        state.effectivePrompt = '';
        state.filePath = '';
        state.version = null;
        state.error = null;
        state.notice = null;
        void loadPrompt();
      });
      scopeGroup.append(scopeButton);
    }
    headingRow.append(headingCopy, scopeGroup);
    section.append(headingRow);

    if (compactSurface) {
      const compactDescription = document.createElement('p');
      compactDescription.className = 'px-0.5 text-xs leading-relaxed text-tertiary';
      compactDescription.textContent = scopeDescriptions[state.scope];
      section.append(compactDescription);
    }

    if (state.scope === 'project') {
      const projectRow = document.createElement('div');
      projectRow.className = 'flex items-center gap-2';
      let load = null;
      const projectInput = document.createElement('input');
      projectInput.className = 'codeex-prompt-project-path rounded-lg px-2.5 py-1.5 text-sm';
      projectInput.dataset.promptProjectPath = 'true';
      projectInput.type = 'text';
      projectInput.placeholder = '/absolute/path/to/project';
      projectInput.value = state.projectPath;
      projectInput.setAttribute('aria-label', 'Project directory');
      projectInput.addEventListener('input', () => {
        state.projectPath = projectInput.value;
        localStorage.setItem(storedProjectPathKey, projectInput.value);
        if (load) load.disabled = state.loading || !state.projectPath.trim();
      });
      projectInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void loadPrompt();
      });
      load = button(
        state.loading ? 'Loading…' : 'Load',
        'no-drag cursor-interaction rounded-lg border border-default px-2.5 py-1.5 text-sm text-default disabled:opacity-40',
      );
      load.dataset.promptLoad = 'true';
      load.disabled = state.loading || !state.projectPath.trim();
      load.addEventListener('click', loadPrompt);
      projectRow.append(projectInput, load);
      section.append(projectRow);
    }

    const editor = document.createElement('textarea');
    editor.className = 'codeex-prompt-editor rounded-xl px-3 py-2.5 text-sm';
    editor.dataset.promptEditor = 'true';
    editor.placeholder = state.scope === 'system'
      ? 'Developer instructions for every new task…'
      : state.scope === 'user'
        ? 'User guidance that should apply to every project…'
        : 'Instructions specific to this project…';
    editor.value = state.prompt;
    editor.disabled = state.loading || (state.scope === 'project' && !state.filePath);
    editor.setAttribute('aria-label', `${scopeLabels[state.scope]} prompt`);
    editor.addEventListener('input', () => {
      state.prompt = editor.value;
      state.notice = null;
    });
    section.append(editor);

    const footer = document.createElement('div');
    footer.className = 'flex min-h-8 items-center gap-3 px-0.5';
    const status = document.createElement('div');
    status.className = 'codeex-prompt-status min-w-0 flex-1 truncate text-xs text-tertiary';
    status.dataset.promptStatus = 'true';
    if (state.error) {
      status.dataset.kind = 'error';
      status.textContent = state.error;
    } else if (state.loading) {
      status.textContent = 'Loading prompt…';
    } else if (state.saving) {
      status.textContent = 'Saving prompt…';
    } else if (state.notice) {
      status.dataset.kind = state.notice.startsWith('Prompt saved') ? 'success' : 'info';
      status.textContent = state.notice;
    } else if (state.inherited) {
      status.textContent = 'No project prompt yet; user guidance is inherited.';
    } else if (state.overridden) {
      status.textContent = 'Saved here, but another active instruction file takes precedence.';
    } else {
      status.title = state.filePath;
      status.textContent = state.filePath || 'Prompt is not loaded.';
    }
    const save = button(
      state.saving ? 'Saving…' : 'Save',
      'no-drag cursor-interaction rounded-lg border border-default bg-primary-soft-alpha px-3 py-1.5 text-sm text-default disabled:opacity-40',
    );
    save.dataset.promptSave = 'true';
    save.disabled = state.loading || state.saving || (state.scope === 'project' && !state.filePath);
    save.addEventListener('click', savePrompt);
    footer.append(status, save);
    section.append(footer);
    return section;
  }

  function composerModelMounts() {
    const mounts = [];
    for (const editor of document.querySelectorAll('[data-codex-composer="true"]')) {
      const composer = editor.closest('[data-composer-layout][role="presentation"]');
      const footer = composer?.querySelector('[data-composer-footer-responsive]');
      if (!footer) continue;
      const modelButton = footer.querySelector('[data-composer-navigation-target="reasoning"]');
      if (!(modelButton instanceof HTMLButtonElement)) continue;
      let mountAfter = modelButton;
      let container = mountAfter.parentElement;
      while (container && container !== footer) {
        const display = getComputedStyle(container).display;
        if (
          display === 'flex' ||
          display === 'inline-flex' ||
          container.classList.contains('flex')
        ) break;
        mountAfter = container;
        container = container.parentElement;
      }
      if (container && !mounts.some((mount) => mount.modelButton === modelButton)) {
        mounts.push({ modelButton, mountAfter });
      }
    }
    return mounts;
  }

  function modelChevron(modelButton) {
    return modelButton.querySelector(':scope > svg:last-of-type')
      || [...modelButton.querySelectorAll('svg')].at(-1)
      || null;
  }

  function makeComposerChevron(modelButton) {
    const nativeChevron = modelChevron(modelButton);
    let chevron;
    if (nativeChevron instanceof SVGElement) {
      chevron = nativeChevron.cloneNode(true);
      chevron.dataset.codeexPromptChevronSource = 'model';
      for (const node of [chevron, ...chevron.querySelectorAll('[data-insp-path]')]) {
        node.removeAttribute('data-insp-path');
      }
    } else {
      chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('width', '16');
      chevron.setAttribute('height', '16');
      chevron.setAttribute('viewBox', '0 0 16 16');
      chevron.setAttribute('fill', 'currentColor');
      chevron.classList.add('me-0.5', 'h-3.5', 'w-3.5', 'shrink-0', 'text-tertiary');
      chevron.dataset.codeexPromptChevronSource = 'fallback';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        'M12.1338 5.94433C12.3919 5.77382 12.7434 5.80202 12.9707 6.02929C13.1979 6.25656 13.2261 6.60807 13.0556 6.8662L12.9707 6.9707L8.47067 11.4707C8.21097 11.7304 7.78896 11.7304 7.52926 11.4707L3.02926 6.9707L2.9443 6.8662C2.77379 6.60807 2.80199 6.25656 3.02926 6.02929C3.25653 5.80202 3.60804 5.77382 3.86617 5.94433L3.97067 6.02929L7.99996 10.0586L12.0293 6.02929L12.1338 5.94433Z',
      );
      chevron.append(path);
    }
    chevron.setAttribute('aria-hidden', 'true');
    chevron.classList.add('codeex-prompt-chevron');
    return chevron;
  }

  function makeComposerButton(modelButton) {
    const promptButton = button(
      '',
      `codeex-prompt-composer-button ${modelButton.className} shrink-0 items-center gap-1`,
    );
    promptButton.dataset.codeexPromptComposerButton = 'true';
    promptButton.dataset.open = 'false';
    promptButton.dataset.state = 'closed';
    promptButton.setAttribute('aria-haspopup', 'dialog');
    promptButton.setAttribute('aria-expanded', 'false');
    promptButton.addEventListener('click', () => toggleComposerPopover(promptButton));
    renderComposerButton(promptButton, modelButton);
    return promptButton;
  }

  function renderComposerButton(promptButton, modelButton) {
    const scopeNames = { system: 'Developer', user: 'User', project: 'Project' };
    const scopeOrder = ['system', 'user', 'project'];
    const summaryKey = JSON.stringify({
      loading: state.summaryLoading,
      error: state.summaryError,
      summary: state.promptSummary,
      modelChevron: modelChevron(modelButton)?.outerHTML || null,
    });
    if (promptButton.dataset.summaryKey === summaryKey) return;
    promptButton.dataset.summaryKey = summaryKey;

    const signal = document.createElement('span');
    signal.className = 'codeex-prompt-signal';
    signal.setAttribute('aria-hidden', 'true');
    const heights = [4, 7, 10];
    for (const [index, scope] of scopeOrder.entries()) {
      const entry = state.promptSummary.scopes?.[scope] || {};
      const bar = document.createElement('span');
      bar.className = 'codeex-prompt-signal-bar';
      bar.dataset.codeexPromptSignalBar = 'true';
      bar.dataset.promptScope = scope;
      bar.dataset.configured = String(Boolean(entry.configured));
      bar.dataset.available = String(entry.available !== false);
      bar.style.height = `${heights[index]}px`;
      signal.append(bar);
    }

    const label = document.createElement('span');
    label.textContent = 'Prompt';
    const chevron = makeComposerChevron(modelButton);
    promptButton.replaceChildren(signal, label, chevron);

    const statuses = scopeOrder.map((scope) => {
      const entry = state.promptSummary.scopes?.[scope] || {};
      if (entry.available === false) return `${scopeNames[scope]}: Choose a project`;
      if (!entry.configured) return `${scopeNames[scope]}: Not configured`;
      return `${scopeNames[scope]}: Configured (${entry.characters || 0} characters)`;
    });
    const total = state.promptSummary.totalCharacters || 0;
    const title = state.summaryLoading
      ? 'Loading prompt status…'
      : state.summaryError
        ? `Prompt status unavailable: ${state.summaryError}`
        : `${statuses.join('\n')}\nTotal: ${total} characters`;
    const ariaStatus = state.summaryLoading
      ? 'Prompt status is loading.'
      : statuses.join('. ');
    promptButton.title = title;
    promptButton.setAttribute(
      'aria-label',
      `Configure prompts. ${ariaStatus}. Total ${total} characters.`,
    );
  }

  function syncComposerMounts() {
    const mounted = new Set();
    for (const { modelButton, mountAfter } of composerModelMounts()) {
      let promptButton = mountAfter.nextElementSibling;
      if (!promptButton?.matches('[data-codeex-prompt-composer-button]')) {
        promptButton = makeComposerButton(modelButton);
        mountAfter.after(promptButton);
      }
      renderComposerButton(promptButton, modelButton);
      mounted.add(promptButton);
    }
    for (const promptButton of document.querySelectorAll(
      '[data-codeex-prompt-composer-button]',
    )) {
      if (mounted.has(promptButton)) continue;
      if (promptButton === activeComposerButton) closeComposerPopover();
      promptButton.remove();
    }
  }

  function positionComposerPopover() {
    if (!composerPopover || !activeComposerButton) return;
    const buttonRect = activeComposerButton.getBoundingClientRect();
    const popoverRect = composerPopover.getBoundingClientRect();
    const left = Math.max(12, Math.min(
      window.innerWidth - popoverRect.width - 12,
      buttonRect.right - popoverRect.width,
    ));
    const above = buttonRect.top - popoverRect.height - 8;
    const top = above >= 12
      ? above
      : Math.min(window.innerHeight - popoverRect.height - 12, buttonRect.bottom + 8);
    composerPopover.style.left = `${left}px`;
    composerPopover.style.top = `${Math.max(12, top)}px`;
  }

  function openComposerPopover(promptButton) {
    closeComposerPopover();
    activeComposerButton = promptButton;
    promptButton.dataset.open = 'true';
    promptButton.dataset.state = 'open';
    promptButton.setAttribute('aria-expanded', 'true');
    composerPopover = document.createElement('div');
    composerPopover.className = [
      'codeex-prompt-composer-popover no-drag m-px flex select-none flex-col',
      'overflow-y-auto bg-surface-elevated-secondary/90 text-default ring-border',
      'rounded-xl ring-[0.5px] shadow-xl-spread backdrop-blur-sm p-1',
    ].join(' ');
    composerPopover.dataset.codeexPromptComposer = 'true';
    composerPopover.dataset.side = 'top';
    composerPopover.dataset.align = 'end';
    composerPopover.dataset.state = 'open';
    composerPopover.setAttribute('role', 'dialog');
    composerPopover.setAttribute('aria-label', 'Prompt configuration');
    document.body.append(composerPopover);
    renderComposerPopover();
  }

  function closeComposerPopover() {
    if (activeComposerButton) {
      activeComposerButton.dataset.open = 'false';
      activeComposerButton.dataset.state = 'closed';
      activeComposerButton.setAttribute('aria-expanded', 'false');
    }
    composerPopover?.remove();
    composerPopover = null;
    activeComposerButton = null;
  }

  function toggleComposerPopover(promptButton) {
    if (activeComposerButton === promptButton && composerPopover) closeComposerPopover();
    else openComposerPopover(promptButton);
  }

  function handleDocumentPointerDown(event) {
    if (!composerPopover) return;
    if (composerPopover.contains(event.target) || activeComposerButton?.contains(event.target)) return;
    closeComposerPopover();
  }

  function handleDocumentKeyDown(event) {
    if (event.key === 'Escape' && composerPopover) closeComposerPopover();
  }

  const unregister = host.registerPanelExtension(
    'prompt-config',
    () => makePromptPanel('management'),
  );
  const controller = {
    version: runtimeVersion,
    marker: runtimeMarker,
    host,
    snapshot() {
      return {
        scope: state.scope,
        projectPath: state.projectPath,
        prompt: state.prompt,
        loadedPrompt: state.loadedPrompt,
        effectivePrompt: state.effectivePrompt,
        filePath: state.filePath,
        version: state.version,
        inherited: state.inherited,
        overridden: state.overridden,
        loading: state.loading,
        saving: state.saving,
        error: state.error,
        notice: state.notice,
        promptSummary: state.promptSummary,
        summaryLoading: state.summaryLoading,
        summaryError: state.summaryError,
        composerMounted: Boolean(document.querySelector('[data-codeex-prompt-composer-button]')),
        composerOpen: Boolean(composerPopover),
      };
    },
    dispose() {
      state.requestToken += 1;
      state.summaryRequestToken += 1;
      interfaceObserver?.disconnect();
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
      window.removeEventListener('resize', positionComposerPopover);
      window.removeEventListener('scroll', positionComposerPopover, true);
      closeComposerPopover();
      unregister();
      style.remove();
      for (const panel of document.querySelectorAll('[data-codeex-prompt-config]')) panel.remove();
      for (const promptButton of document.querySelectorAll('[data-codeex-prompt-composer-button]')) {
        promptButton.remove();
      }
      if (window.__CODEEX_PROMPT_CONFIG__ === controller) {
        delete window.__CODEEX_PROMPT_CONFIG__;
      }
    },
  };
  window.__CODEEX_PROMPT_CONFIG__ = controller;
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeyDown, true);
  window.addEventListener('resize', positionComposerPopover);
  window.addEventListener('scroll', positionComposerPopover, true);
  interfaceObserver = new MutationObserver(() => {
    syncComposerMounts();
  });
  interfaceObserver.observe(document.documentElement, { childList: true, subtree: true });
  syncComposerMounts();
  void loadPrompt();
  void loadPromptSummary();
})();
