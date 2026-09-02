;(() => {
  const marker = '__CODEEX_SAFE_ARCHIVE_RUNTIME__';
  const runtimeVersion = '0.1.0';
  const previous = globalThis[marker];
  if (previous?.version === runtimeVersion) return;
  previous?.dispose?.();

  const handledErrors = new WeakSet();
  let pollingTimer = null;
  let disposed = false;

  function host() {
    return globalThis.__CODEEX_TAB_BOOTSTRAP__ || null;
  }

  function messageOf(error) {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && typeof error.message === 'string') {
      return error.message;
    }
    return String(error || 'Unknown archive error.');
  }

  function isActiveWriterError(error) {
    return /already has an active writer/i.test(messageOf(error));
  }

  function markHandled(error) {
    if (error && typeof error === 'object') handledErrors.add(error);
  }

  function ensureStyle() {
    let style = document.querySelector('[data-codeex-safe-archive-style]');
    if (style) return style;
    style = document.createElement('style');
    style.dataset.codeexSafeArchiveStyle = 'true';
    style.textContent = `
      .codeex-safe-archive-dialog {
        width: min(460px, calc(100vw - 32px));
        border: 1px solid var(--color-border-subtle, ButtonBorder);
        border-radius: 14px;
        padding: 0;
        color: var(--color-text-primary, CanvasText);
        background: var(--color-background-elevated, Canvas);
        box-shadow: 0 20px 60px color-mix(in srgb, CanvasText 18%, transparent);
      }
      .codeex-safe-archive-dialog::backdrop {
        background: color-mix(in srgb, CanvasText 24%, transparent);
        backdrop-filter: blur(2px);
      }
      .codeex-safe-archive-content { padding: 20px; }
      .codeex-safe-archive-title { margin: 0; font-size: 16px; font-weight: 600; }
      .codeex-safe-archive-copy { margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: var(--color-text-secondary, GrayText); }
      .codeex-safe-archive-meta { margin: 14px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas)); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
      .codeex-safe-archive-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .codeex-safe-archive-button { min-height: 32px; border: 1px solid var(--color-border-default, ButtonBorder); border-radius: 8px; padding: 5px 11px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
      .codeex-safe-archive-button:hover { background: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas)); }
      .codeex-safe-archive-primary { color: var(--color-text-on-accent, HighlightText); background: var(--color-background-accent, Highlight); border-color: transparent; }
      .codeex-safe-archive-primary:hover { background: var(--color-background-accent-hover, Highlight); }
      .codeex-safe-archive-toast { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; max-width: 380px; border: 1px solid var(--color-border-subtle, ButtonBorder); border-radius: 10px; padding: 10px 12px; color: var(--color-text-primary, CanvasText); background: var(--color-background-elevated, Canvas); box-shadow: 0 12px 36px color-mix(in srgb, CanvasText 16%, transparent); font-size: 13px; }
    `;
    document.head.append(style);
    return style;
  }

  function diagnosticText({ threadId, ownership, error }) {
    return [
      `context_id=safe-archive:${threadId}`,
      `thread_id=${threadId}`,
      `owner=${ownership?.owner || 'unknown'}`,
      `originator=${ownership?.originator || 'unknown'}`,
      `active_writer=${Boolean(ownership?.activeWriter)}`,
      `writer_pids=${ownership?.writerPids?.join(',') || 'unknown'}`,
      `rollout=${ownership?.rollout || 'unknown'}`,
      `error=${messageOf(error)}`,
    ].join('\n');
  }

  function button(label, primary = false) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `codeex-safe-archive-button${primary ? ' codeex-safe-archive-primary' : ''}`;
    element.textContent = label;
    return element;
  }

  async function showOwnershipDialog({ threadId, ownership, error }) {
    ensureStyle();
    const dialog = document.createElement('dialog');
    dialog.className = 'codeex-safe-archive-dialog';
    dialog.dataset.codeexSafeArchiveDialog = 'true';
    const content = document.createElement('div');
    content.className = 'codeex-safe-archive-content';
    const title = document.createElement('h2');
    title.className = 'codeex-safe-archive-title';
    title.textContent = 'This chat is active elsewhere';
    const copy = document.createElement('p');
    copy.className = 'codeex-safe-archive-copy';
    copy.textContent = ownership?.activeWriter
      ? `${ownership.owner} is still writing to this chat. Codeex can archive it automatically after the writer releases it.`
      : 'Another Codex client still owns this chat. Codeex can retry the standard archive operation later.';
    const meta = document.createElement('div');
    meta.className = 'codeex-safe-archive-meta';
    meta.textContent = `${ownership?.owner || 'Another Codex client'} · ${threadId}`;
    const actions = document.createElement('div');
    actions.className = 'codeex-safe-archive-actions';
    const copyDiagnostic = button('Copy diagnostic');
    const cancel = button('Cancel');
    const defer = button('Archive later', true);
    actions.append(copyDiagnostic, cancel, defer);
    content.append(title, copy, meta, actions);
    dialog.append(content);
    document.body.append(dialog);
    const diagnostic = diagnosticText({ threadId, ownership, error });
    return await new Promise((resolve) => {
      const finish = (choice) => {
        dialog.close();
        dialog.remove();
        resolve(choice);
      };
      copyDiagnostic.addEventListener('click', async () => {
        await navigator.clipboard.writeText(diagnostic);
        copyDiagnostic.textContent = 'Copied';
      });
      cancel.addEventListener('click', () => finish('cancel'));
      defer.addEventListener('click', () => finish('defer'));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish('cancel');
      });
      dialog.showModal();
      defer.focus();
    });
  }

  function showNotice(message) {
    ensureStyle();
    document.querySelector('[data-codeex-safe-archive-toast]')?.remove();
    const notice = document.createElement('div');
    notice.dataset.codeexSafeArchiveToast = 'true';
    notice.className = 'codeex-safe-archive-toast';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    document.body.append(notice);
    setTimeout(() => notice.remove(), 6_000);
  }

  async function request(path, options) {
    const client = host();
    if (!client?.request) throw new Error('Codeex control bridge is unavailable.');
    return await client.request(path, options);
  }

  function schedulePendingPoll(delay = 1_000) {
    if (disposed || pollingTimer) return;
    pollingTimer = setTimeout(async () => {
      pollingTimer = null;
      try {
        const result = await request('/api/plugins/safe-archive/pending');
        if (result.completed?.length) {
          showNotice(`${result.completed.length} deferred chat${result.completed.length === 1 ? '' : 's'} archived.`);
        }
        if (result.pending?.length) {
          const next = Math.min(...result.pending.map((item) => Number(item.nextAttemptAt || Date.now() + 30_000)));
          schedulePendingPoll(Math.max(5_000, Math.min(30_000, next - Date.now())));
        }
      } catch {
        schedulePendingPoll(30_000);
      }
    }, delay);
  }

  const controller = {
    version: runtimeVersion,
    async archiveThread({ threadId, archive }) {
      try {
        return await archive();
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        let ownership = null;
        try {
          ownership = await request(
            `/api/plugins/safe-archive/ownership?threadId=${encodeURIComponent(threadId)}`,
          );
        } catch {}
        const choice = await showOwnershipDialog({ threadId, ownership, error });
        if (choice !== 'defer') {
          markHandled(error);
          throw error;
        }
        try {
          const deferred = await request('/api/plugins/safe-archive/defer', {
            method: 'POST',
            body: JSON.stringify({ threadId }),
          });
          const archivedNow = deferred.completed?.some((item) => item.threadId === threadId);
          showNotice(archivedNow
            ? 'Chat archived.'
            : 'Archive scheduled. Codeex will retry after the active writer releases this chat.');
          if (deferred.pending?.length) schedulePendingPoll(5_000);
          return { deferred: true, threadId };
        } catch (deferError) {
          markHandled(deferError);
          showNotice(`Archive could not be scheduled. ${messageOf(deferError)}`);
          throw deferError;
        }
      }
    },
    handleFailure(error) {
      return Boolean(error && typeof error === 'object' && handledErrors.has(error));
    },
    snapshot() {
      return {
        version: runtimeVersion,
        dialogOpen: Boolean(document.querySelector('[data-codeex-safe-archive-dialog]')),
        noticeVisible: Boolean(document.querySelector('[data-codeex-safe-archive-toast]')),
        polling: Boolean(pollingTimer),
      };
    },
    dispose() {
      disposed = true;
      if (pollingTimer) clearTimeout(pollingTimer);
      pollingTimer = null;
      document.querySelector('[data-codeex-safe-archive-dialog]')?.remove();
      document.querySelector('[data-codeex-safe-archive-toast]')?.remove();
      document.querySelector('[data-codeex-safe-archive-style]')?.remove();
      if (globalThis[marker] === controller) delete globalThis[marker];
    },
  };
  globalThis[marker] = controller;
  schedulePendingPoll();
})();
