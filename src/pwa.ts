// Installable app: a service worker that keeps the app shell for fast,
// offline-tolerant starts, and the browser's install prompt when it offers one.

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPrompt | null = null;
let listener: (() => void) | null = null;

export function registerServiceWorker() {
  // Only the built site: in development the worker would cache stale modules.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => console.warn(err));
  });
}

addEventListener('beforeinstallprompt', (e) => {
  // Keep the browser's prompt for our own button.
  e.preventDefault();
  deferred = e as InstallPrompt;
  listener?.();
});

addEventListener('appinstalled', () => {
  deferred = null;
  listener?.();
});

/** Calls back when installing becomes possible or is done. */
export function onInstallChange(fn: () => void) {
  listener = fn;
}

export const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone and iPad Safari have no install prompt; it's Share, then Add to Home Screen. */
export const iosSafari = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function installMode(): 'installed' | 'prompt' | 'ios' | null {
  if (standalone()) return 'installed';
  if (deferred) return 'prompt';
  if (iosSafari()) return 'ios';
  return null;
}

export async function install() {
  if (!deferred) return false;
  const prompt = deferred;
  deferred = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  listener?.();
  return outcome === 'accepted';
}
