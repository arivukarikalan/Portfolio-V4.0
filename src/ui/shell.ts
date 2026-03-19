import { APP_NAME } from '../core/constants';
import { clearSession } from '../storage/db';
import type { UserSession } from '../core/types';
import { initLucide, lucideIcon } from './icons';

type NavItem = {
  id: string;
  label: string;
  icon: string;
  href: string;
  adminOnly?: boolean;
};

type QuickNavItem = {
  id: string;
  label: string;
  href: string;
  adminTab?: string;
  icon?: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', href: 'dashboard.html' },
  { id: 'holdings', label: 'Holdings', icon: 'pie-chart', href: 'holdings.html' },
  { id: 'trades', label: 'Trades', icon: 'repeat', href: 'trades.html' },
  { id: 'insights', label: 'Insights', icon: 'lightbulb', href: 'insights.html' },
  { id: 'target', label: 'Target Planner', icon: 'target', href: 'target.html' },
  { id: 'transactions', label: 'Transactions', icon: 'arrow-right-left', href: 'transactions.html' },
  { id: 'finance', label: 'Finance Dashboard', icon: 'wallet', href: 'finance.html' },
  { id: 'pnl', label: 'Profit / Loss', icon: 'trending-up', href: 'pnl.html' },
  { id: 'admin', label: 'Admin Control', icon: 'shield', href: 'admin.html', adminOnly: true },
  { id: 'settings', label: 'Settings', icon: 'settings', href: 'settings.html' }
];

const QUICK_NAV_IDS = ['dashboard', 'holdings', 'trades', 'insights', 'target'];

function initialsFor(name: string): string {
  const clean = String(name || '').trim();
  if (!clean) return 'U';
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function renderShell(options: {
  session: UserSession;
  active: string;
  title: string;
  subtitle?: string;
  quickNav?: QuickNavItem[];
  quickNavActive?: string;
  content: string;
}): string {
  const { session, active, subtitle, content, quickNav, quickNavActive } = options;
  const navItems = NAV_ITEMS.filter((item) => !item.adminOnly || session.role === 'ADMIN');
  const quickItems = navItems.filter((item) => QUICK_NAV_IDS.includes(item.id));
  const initials = initialsFor(session.name);

  const navMarkup = navItems
    .map((item) => {
      const isActive = item.id === active;
      return `
        <a class="nav-link d-flex align-items-center justify-content-center ${isActive ? 'active' : ''}" href="${item.href}" title="${item.label}" aria-label="${item.label}">
          ${lucideIcon(item.icon)} <span class="sidebar-label">${item.label}</span>
        </a>
      `;
    })
    .join('');

  const quickNavItems: QuickNavItem[] =
    quickNav && quickNav.length
      ? quickNav
      : quickItems.map((item) => ({
          id: item.id,
          label: item.label,
          href: item.href,
          icon: item.icon
        }));

  const desktopQuickNavMarkup = quickNavItems
    .map((item) => {
      const isActive = (quickNavActive || active) === item.id;
      const tabAttr = item.adminTab ? `data-admin-tab="${item.adminTab}"` : '';
      const iconName = item.icon || 'circle';
      return `
        <a class="btn btn-sm quick-nav-btn ${isActive ? 'active' : ''}" data-quick-id="${item.id}" ${tabAttr} href="${item.href}">
          <span class="quick-nav-icon">${lucideIcon(iconName)}</span>
          <span class="quick-nav-label">${item.label}</span>
        </a>
      `;
    })
    .join('');

  const mobileQuickNavMarkup = quickNavItems
    .map((item) => {
      const isActive = (quickNavActive || active) === item.id;
      const tabAttr = item.adminTab ? `data-admin-tab="${item.adminTab}"` : '';
      const iconName = item.icon || 'circle';
      return `
        <a class="mobile-nav-item ${isActive ? 'active' : ''}" data-quick-id="${item.id}" ${tabAttr} href="${item.href}">
          <span class="mobile-nav-icon">${lucideIcon(iconName)}</span>
          <span class="mobile-nav-label">${item.label}</span>
        </a>
      `;
    })
    .join('');

  return `
    <div class="app-shell bg-light">
      <nav class="navbar app-topbar navbar-light bg-white border-bottom sticky-top">
        <div class="container-fluid px-3">
          <div class="d-flex align-items-center gap-2 app-topbar-brand">
            <button class="btn nav-icon-btn nav-hamburger d-lg-none" id="sidebar-toggle" type="button" aria-label="Toggle navigation">
              ${lucideIcon('menu')}
            </button>
            <img src="/favicon.svg" alt="${APP_NAME}" width="36" height="36" class="rounded-3 border" />
            <div>
              <div class="fw-semibold">${APP_NAME}</div>
            </div>
          </div>
          <div class="d-none d-md-flex align-items-center gap-2 bg-light rounded-pill px-2 py-1 quick-nav app-topbar-quicknav">
            ${desktopQuickNavMarkup}
          </div>
            <div class="d-flex align-items-center gap-2 app-topbar-actions">
              <div class="sync-indicator" id="sync-indicator" data-status="idle">Synced</div>
              <a class="btn nav-icon-btn" href="settings.html" aria-label="Settings">
                ${lucideIcon('settings')}
              </a>
            <div class="position-relative">
              <button class="btn nav-icon-btn position-relative" id="sync-panel-toggle" type="button" aria-label="Cloud Sync">
                ${lucideIcon('bell')}
                <span class="position-absolute top-0 start-100 translate-middle p-1 bg-danger border border-white rounded-circle">
                  <span class="visually-hidden">Sync status</span>
                </span>
              </button>
            </div>
            <div class="position-relative">
              <button class="btn nav-icon-btn nav-avatar fw-semibold" id="profile-toggle" type="button">
                ${initials}
              </button>
              <div class="dropdown-menu dropdown-menu-end shadow" id="profile-menu">
                <div class="px-3 py-2">
                  <div class="fw-semibold">${session.name}</div>
                  <div class="small text-muted text-uppercase">${session.role}</div>
                </div>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item text-danger" id="profile-logout" type="button">Logout</button>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div class="container-fluid px-0">
        <div class="d-flex">
          <aside class="app-sidebar bg-white border-end">
            <div class="p-3">
              <div class="nav flex-column nav-pills gap-2">
                ${navMarkup}
              </div>
            </div>
          </aside>
          <div class="app-sidebar-backdrop" id="sidebar-backdrop"></div>
          <div class="sync-panel-backdrop" id="sync-panel-backdrop"></div>
          <aside class="sync-panel" id="sync-panel" aria-hidden="true">
            <div class="sync-panel-header">
              <div>
                <div class="fw-semibold d-flex align-items-center gap-2">
                  ${lucideIcon('cloud')}
                  Cloud Sync
                </div>
                <div class="text-muted small">Auto sync and price refresh</div>
              </div>
              <button class="btn btn-sm btn-light sync-panel-close" id="sync-panel-close" type="button" aria-label="Close">
                ${lucideIcon('x')}
              </button>
            </div>
            <div class="sync-panel-section">
              <div class="sync-panel-row">
                <span class="text-muted">Status</span>
                <span class="sync-status-pill" id="sync-panel-status">--</span>
              </div>
              <div class="sync-panel-row">
                <span class="text-muted">Auto Cloud Sync</span>
                <span id="sync-panel-interval">--</span>
              </div>
              <div class="sync-panel-row">
                <span class="text-muted">Auto Live Price</span>
                <span id="sync-panel-price-interval">--</span>
              </div>
            </div>
            <div class="sync-panel-actions">
              <button class="btn btn-primary btn-sm" id="sync-panel-push" type="button">Push Now</button>
              <button class="btn btn-outline-primary btn-sm" id="sync-panel-pull" type="button">Pull Now</button>
            </div>
            <div class="sync-panel-section">
              <div class="sync-panel-row">
                <span class="text-muted">Last Push</span>
                <span id="sync-panel-last-push">--</span>
              </div>
              <div class="sync-panel-row">
                <span class="text-muted">Last Pull</span>
                <span id="sync-panel-last-pull">--</span>
              </div>
              <div class="sync-panel-row">
                <span class="text-muted">Last Price</span>
                <span id="sync-panel-last-price">--</span>
              </div>
              <div class="sync-panel-row">
                <span class="text-muted">Pending Push</span>
                <span id="sync-panel-pending">--</span>
              </div>
            </div>
            <div class="sync-panel-section">
              <div class="fw-semibold small mb-2">Sync Log</div>
              <div class="sync-panel-logs" id="sync-panel-logs"></div>
            </div>
          </aside>

          <main class="flex-grow-1">
            <div class="p-3 p-lg-4">
              ${subtitle ? `<div class="text-muted small mb-2">${subtitle}</div>` : ''}
              ${content}
            </div>
          </main>
        </div>
      </div>

      <nav class="mobile-bottom-nav d-lg-none">
        <div class="mobile-bottom-nav-inner">
          ${mobileQuickNavMarkup}
        </div>
      </nav>
    </div>
  `;
}

export function bindShell(root: HTMLElement): void {
  initLucide();
  const sidebar = root.querySelector<HTMLElement>('.app-sidebar');
  const sidebarBackdrop = root.querySelector<HTMLElement>('#sidebar-backdrop');
  const sidebarToggle = root.querySelector<HTMLButtonElement>('#sidebar-toggle');
  const syncPanelToggle = root.querySelector<HTMLButtonElement>('#sync-panel-toggle');
  const syncPanel = root.querySelector<HTMLElement>('#sync-panel');
  const syncPanelBackdrop = root.querySelector<HTMLElement>('#sync-panel-backdrop');
  const syncPanelClose = root.querySelector<HTMLButtonElement>('#sync-panel-close');
  const profileToggle = root.querySelector<HTMLButtonElement>('#profile-toggle');
  const profileMenu = root.querySelector<HTMLDivElement>('#profile-menu');
  const profileLogout = root.querySelector<HTMLButtonElement>('#profile-logout');
  const mobileQuickNav = root.querySelector<HTMLElement>('.mobile-bottom-nav');

  const closeSidebar = () => {
    sidebar?.classList.remove('show');
    sidebarBackdrop?.classList.remove('show');
  };
  const closeSyncPanel = () => {
    syncPanel?.classList.remove('show');
    syncPanelBackdrop?.classList.remove('show');
    syncPanel?.setAttribute('aria-hidden', 'true');
  };

  sidebarToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('show');
    sidebarBackdrop?.classList.toggle('show');
  });

  sidebarBackdrop?.addEventListener('click', closeSidebar);
  syncPanelToggle?.addEventListener('click', () => {
    syncPanel?.classList.toggle('show');
    syncPanelBackdrop?.classList.toggle('show');
    syncPanel?.setAttribute('aria-hidden', syncPanel?.classList.contains('show') ? 'false' : 'true');
  });
  syncPanelBackdrop?.addEventListener('click', closeSyncPanel);
  syncPanelClose?.addEventListener('click', closeSyncPanel);

  const closeDropdowns = () => {
    profileMenu?.classList.remove('show');
  };

  const clampMenu = (menu: HTMLElement | null) => {
    if (!menu) return;
    menu.style.left = '';
    menu.style.right = '';
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.transform = '';
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.right = '0';
      menu.style.left = 'auto';
    }
    if (rect.left < 0) {
      menu.style.left = '0';
      menu.style.right = 'auto';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
    }
  };

  profileToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    profileMenu?.classList.toggle('show');
    clampMenu(profileMenu);
  });

  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (
      profileMenu &&
      profileToggle &&
      !profileMenu.contains(target) &&
      !profileToggle.contains(target)
    ) {
      closeDropdowns();
    }
  });

  profileLogout?.addEventListener('click', async () => {
    await clearSession();
    window.location.href = 'index.html';
  });

  if (mobileQuickNav) {
    mobileQuickNav.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const link = target.closest<HTMLAnchorElement>('[data-admin-tab]');
      if (!link) return;
      event.preventDefault();
      const tab = link.dataset.adminTab;
      if (tab) {
        window.location.hash = tab;
      }
    });
  }
}
