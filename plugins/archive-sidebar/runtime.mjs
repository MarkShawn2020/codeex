export const ARCHIVE_SETTINGS_ROUTE = '/settings/data-controls';
export const RUNTIME_MARKER = '__CODEEX_ARCHIVE_SIDEBAR__';

export function installArchiveSidebar(runtimeWindow = globalThis) {
  const marker = '__CODEEX_ARCHIVE_SIDEBAR__';
  const route = '/settings/data-controls';
  const wrapperAttribute = 'data-codeex-archive-sidebar';
  const document = runtimeWindow.document;
  if (!document || runtimeWindow[marker]) return runtimeWindow[marker] ?? null;

  const archiveIcon = [
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"',
    ' xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
    '<path d="M2.25 4.25h11.5v8.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-8.5Z"',
    ' stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>',
    '<path d="M1.75 2.25h12.5v2H1.75v-2Z" stroke="currentColor"',
    ' stroke-width="1.1" stroke-linejoin="round"/>',
    '<path d="M6 7.25h4" stroke="currentColor" stroke-width="1.1"',
    ' stroke-linecap="round"/>',
    '</svg>',
  ].join('');

  function shortcutButtons() {
    return Array.from(document.querySelectorAll('nav button.sidebar-item'));
  }

  function isShortcutGroup(group) {
    const wrappers = Array.from(group?.children ?? []);
    return wrappers.length >= 2 && wrappers.length <= 10 && wrappers.every((wrapper) =>
      wrapper.classList?.contains('contents') &&
      wrapper.children.length === 1 &&
      wrapper.firstElementChild?.matches?.('button.sidebar-item'),
    );
  }

  function findTargetButton() {
    const buttons = shortcutButtons();
    const byLabel = buttons.find((button) =>
      button.querySelector('span.text-fade-truncate')?.textContent?.trim() === 'Plugins',
    );
    if (byLabel) return byLabel;

    const bySourceLocation = buttons.filter((button) =>
      /app-initial-[^:]+\.js:\d+:34209:button$/.test(
        button.getAttribute('data-insp-path') ?? '',
      ),
    );
    if (bySourceLocation.length > 0) return bySourceLocation.at(-1);

    const group = Array.from(document.querySelectorAll('nav div.flex.flex-col.gap-px'))
      .find(isShortcutGroup);
    return group?.lastElementChild?.querySelector?.('button.sidebar-item') ?? null;
  }

  function updateSelected(button) {
    if (runtimeWindow.location?.pathname === route) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  }

  function navigateToArchive() {
    runtimeWindow.postMessage(
      { type: 'navigate-to-route', path: route },
      runtimeWindow.location.origin,
    );
  }

  function mount() {
    const existing = document.querySelector(`[${wrapperAttribute}]`);
    if (existing) {
      const button = existing.querySelector('button');
      if (button) updateSelected(button);
      return existing;
    }

    const targetButton = findTargetButton();
    const targetWrapper = targetButton?.parentElement;
    const targetGroup = targetWrapper?.parentElement;
    if (!targetButton || !targetWrapper || !isShortcutGroup(targetGroup)) return null;

    const wrapper = targetWrapper.cloneNode(true);
    wrapper.setAttribute(wrapperAttribute, 'true');
    for (const element of [wrapper, ...wrapper.querySelectorAll('[data-insp-path]')]) {
      element.removeAttribute('data-insp-path');
    }

    const button = wrapper.querySelector('button.sidebar-item');
    const label = button?.querySelector('span.text-fade-truncate');
    if (!button || !label) return null;
    button.type = 'button';
    button.title = 'Archive';
    button.setAttribute('aria-label', 'Archive');
    button.setAttribute('data-codeex-archive-action', 'open');
    label.textContent = 'Archive';

    const iconSlot = Array.from(button.querySelectorAll('span'))
      .find((span) => span.firstElementChild?.tagName?.toLowerCase() === 'svg');
    if (iconSlot) iconSlot.innerHTML = archiveIcon;

    updateSelected(button);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      updateSelected(button);
      navigateToArchive();
    });
    targetWrapper.insertAdjacentElement('afterend', wrapper);
    return wrapper;
  }

  const observer = new runtimeWindow.MutationObserver(() => mount());
  const state = {
    marker,
    route,
    mount,
    stop() {
      observer.disconnect();
      document.querySelector(`[${wrapperAttribute}]`)?.remove();
      delete runtimeWindow[marker];
    },
  };
  runtimeWindow[marker] = state;
  mount();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return state;
}
