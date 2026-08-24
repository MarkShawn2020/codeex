// Lovinsp prepends its browser client here. Keeping the matching Vite build
// watcher alive keeps this optional plugin's IDE bridge available.
// The visible plugin directory remains owned by the separately injected Codeex tab.
document.documentElement.dataset.lovinspBridge = 'active';
