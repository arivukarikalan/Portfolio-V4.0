export type UiTheme = 'light' | 'dark' | 'system';
export type UiFontSize = 'sm' | 'md' | 'lg';

export type UiSettings = {
  theme: UiTheme;
  fontSize: UiFontSize;
  compactMode: boolean;
  animations: boolean;
};

const DEFAULT_SETTINGS: UiSettings = {
  theme: 'system',
  fontSize: 'md',
  compactMode: false,
  animations: true
};

const STORAGE_PREFIX = 'finance_app_v4_ui';
let systemMediaQuery: MediaQueryList | null = null;
let systemListener: ((event: MediaQueryListEvent) => void) | null = null;

const isTheme = (value: string): value is UiTheme =>
  value === 'light' || value === 'dark' || value === 'system';
const isFontSize = (value: string): value is UiFontSize =>
  value === 'sm' || value === 'md' || value === 'lg';

const storageKey = (userId: string) => `${STORAGE_PREFIX}:${userId}`;

const resolveSystemTheme = () =>
  window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

const applyResolvedTheme = (theme: 'light' | 'dark') => {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-bs-theme', theme);
};

export function loadUiSettings(userId: string): UiSettings {
  if (!userId) return { ...DEFAULT_SETTINGS };
  const raw = localStorage.getItem(storageKey(userId));
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      theme: parsed.theme && isTheme(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      fontSize:
        parsed.fontSize && isFontSize(parsed.fontSize) ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      compactMode: typeof parsed.compactMode === 'boolean' ? parsed.compactMode : DEFAULT_SETTINGS.compactMode,
      animations: typeof parsed.animations === 'boolean' ? parsed.animations : DEFAULT_SETTINGS.animations
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveUiSettings(userId: string, settings: UiSettings): void {
  if (!userId) return;
  localStorage.setItem(storageKey(userId), JSON.stringify(settings));
}

export function applyUiSettings(settings: UiSettings): void {
  const root = document.documentElement;
  root.setAttribute('data-font-size', settings.fontSize);
  root.setAttribute('data-compact', settings.compactMode ? 'true' : 'false');
  root.setAttribute('data-motion', settings.animations ? 'on' : 'off');

  const resolvedTheme = settings.theme === 'system' ? resolveSystemTheme() : settings.theme;
  applyResolvedTheme(resolvedTheme);

  if (settings.theme === 'system' && window.matchMedia) {
    if (!systemMediaQuery) {
      systemMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
    if (!systemListener) {
      systemListener = (event) => {
        applyResolvedTheme(event.matches ? 'dark' : 'light');
      };
      systemMediaQuery.addEventListener('change', systemListener);
    }
  } else if (systemMediaQuery && systemListener) {
    systemMediaQuery.removeEventListener('change', systemListener);
    systemListener = null;
  }
}

export function resetUiSettings(userId: string): UiSettings {
  const next = { ...DEFAULT_SETTINGS };
  saveUiSettings(userId, next);
  applyUiSettings(next);
  return next;
}
