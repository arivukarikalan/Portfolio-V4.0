import { renderShell, bindShell } from '../ui/shell';
import { initCloudSync } from '../services/cloudSync';
import { requireSession } from './guards';
import { lucideIcon } from '../ui/icons';

export function renderPlaceholderView(root: HTMLElement, options: { title: string; active: string; description: string }): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;
    root.innerHTML = renderShell({
      session,
      active: options.active,
      title: options.title,
      subtitle: options.description,
      content: `
        <div class="card shadow-sm border-0">
          <div class="card-body">
            <h2 class="h5 mb-2 section-title">
              <span class="section-icon">${lucideIcon('sparkles')}</span>
              ${options.title}
            </h2>
            <p class="text-muted mb-0">${options.description}</p>
          </div>
        </div>
      `
    });
    bindShell(root, session);
    void initCloudSync(session);
  })();
}

