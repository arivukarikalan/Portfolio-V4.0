export type FeedbackTone = 'success' | 'danger' | 'warning' | 'info';

const DEFAULT_AUTO_CLOSE_SEC = 7;
const autoCloseTimers = new WeakMap<HTMLElement, number>();

function getAutoCloseSeconds(): number {
  const raw = Number(document.documentElement.dataset.toastAutoCloseSec);
  if (!Number.isFinite(raw)) return DEFAULT_AUTO_CLOSE_SEC;
  return Math.max(0, raw);
}

export function showAlert(target: HTMLElement, tone: FeedbackTone, message: string): void {
  target.className = `alert alert-${tone}`;
  target.textContent = message;
  target.classList.remove('d-none');
  const existing = autoCloseTimers.get(target);
  if (existing) {
    window.clearTimeout(existing);
    autoCloseTimers.delete(target);
  }
  const autoCloseSec = getAutoCloseSeconds();
  if (autoCloseSec > 0) {
    const id = window.setTimeout(() => {
      clearAlert(target);
    }, autoCloseSec * 1000);
    autoCloseTimers.set(target, id);
  }
}

export function clearAlert(target: HTMLElement): void {
  const existing = autoCloseTimers.get(target);
  if (existing) {
    window.clearTimeout(existing);
    autoCloseTimers.delete(target);
  }
  target.classList.add('d-none');
  target.textContent = '';
}

export function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  if (busy) {
    button.disabled = true;
    button.dataset.label = label;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Working';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || label;
  }
}

export function flashInline(target: HTMLElement, message: string, timeout = 2200): void {
  const original = target.dataset.flashOriginal ?? target.innerHTML;
  target.dataset.flashOriginal = original;
  target.dataset.flashToken = String(Date.now());
  const token = target.dataset.flashToken;
  target.classList.add('btn-flash-success');
  target.innerHTML = message;
  window.setTimeout(() => {
    if (target.dataset.flashToken !== token) return;
    target.classList.remove('btn-flash-success');
    target.innerHTML = original;
  }, timeout);
}
