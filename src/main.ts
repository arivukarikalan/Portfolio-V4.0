import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import { bootstrapApp, type AppView } from './app/App';

function ensureMeta(name: string, content: string): void {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}

function ensureLink(rel: string, href: string, extra?: { sizes?: string; type?: string }): void {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
  if (extra?.sizes) link.setAttribute('sizes', String(extra.sizes));
  if (extra?.type) link.type = extra.type;
}

function setupPwaHead(): void {
  ensureLink('manifest', new URL('./manifest.webmanifest', window.location.href).toString());
  ensureLink('apple-touch-icon', new URL('./pwa-icons/apple-touch-icon.png', window.location.href).toString(), {
    sizes: '192x192',
    type: 'image/png'
  });
  ensureMeta('theme-color', '#ffffff');
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'default');
  ensureMeta('apple-mobile-web-app-title', 'Ask Finor');
  ensureMeta('mobile-web-app-capable', 'yes');
}

function registerPwaServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker
        .register(new URL('./service-worker.js', window.location.href), {
          scope: new URL('./', window.location.href).pathname
        })
        .catch((error) => {
          console.warn('PWA service worker registration failed', error);
        });
    },
    { once: true }
  );
}

setupPwaHead();
registerPwaServiceWorker();

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('#app root node not found');
}

const page = String(document.body.dataset.page || '').trim().toLowerCase();
const allowed: AppView[] = [
  'login',
  'dashboard',
  'holdings',
  'trades',
  'ask-finor',
  'exit-strategy',
  'insights',
  'target',
  'sell-planner',
  'transactions',
  'finance',
  'pnl',
  'help',
  'settings',
  'admin'
];
const forcedView = allowed.includes(page as AppView) ? (page as AppView) : 'login';

bootstrapApp(root, forcedView);
