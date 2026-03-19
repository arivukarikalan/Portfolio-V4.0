export type FeedbackTone = 'success' | 'danger' | 'warning' | 'info';

export function showAlert(target: HTMLElement, tone: FeedbackTone, message: string): void {
  target.className = `alert alert-${tone}`;
  target.textContent = message;
  target.classList.remove('d-none');
}

export function clearAlert(target: HTMLElement): void {
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
