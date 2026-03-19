export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
};

export function renderConfirmModal(): string {
  return `
    <div class="app-modal" id="confirm-modal" aria-hidden="true">
      <div class="app-modal-backdrop" data-close="modal"></div>
      <div class="app-modal-dialog">
        <div class="card shadow-lg border-0">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h3 class="h6 mb-0" id="confirm-title">Confirm</h3>
              <button class="btn btn-sm btn-outline-secondary" type="button" id="confirm-close">Close</button>
            </div>
            <p class="text-muted mb-3" id="confirm-message"></p>
            <div class="d-flex gap-2 justify-content-end">
              <button class="btn btn-outline-secondary" type="button" id="confirm-cancel">Cancel</button>
              <button class="btn btn-primary" type="button" id="confirm-accept">Confirm</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function bindConfirmModal(root: HTMLElement): (options: ConfirmOptions) => Promise<boolean> {
  const modal = root.querySelector<HTMLDivElement>('#confirm-modal');
  const title = root.querySelector<HTMLElement>('#confirm-title');
  const message = root.querySelector<HTMLElement>('#confirm-message');
  const closeBtn = root.querySelector<HTMLButtonElement>('#confirm-close');
  const cancelBtn = root.querySelector<HTMLButtonElement>('#confirm-cancel');
  const acceptBtn = root.querySelector<HTMLButtonElement>('#confirm-accept');

  if (!modal || !title || !message || !closeBtn || !cancelBtn || !acceptBtn) {
    throw new Error('Confirm modal not found');
  }

  let resolver: ((value: boolean) => void) | null = null;

  const close = (result: boolean) => {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (resolver) {
      resolver(result);
      resolver = null;
    }
  };

  modal.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target?.dataset?.close === 'modal') {
      close(false);
    }
  });

  closeBtn.addEventListener('click', () => close(false));
  cancelBtn.addEventListener('click', () => close(false));
  acceptBtn.addEventListener('click', () => close(true));

  return (options: ConfirmOptions) =>
    new Promise((resolve) => {
      resolver = resolve;
      title.textContent = options.title || 'Confirm';
      message.textContent = options.message;
      acceptBtn.textContent = options.confirmLabel || 'Confirm';
      cancelBtn.textContent = options.cancelLabel || 'Cancel';
      acceptBtn.className = `btn ${options.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    });
}
