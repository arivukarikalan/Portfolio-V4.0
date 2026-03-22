import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
import { getUserSettings, saveUserSettings } from '../storage/settings';
import { queueSnapshot } from '../services/cloudSync';
import { requireSession } from './guards';
import { lucideIcon } from '../ui/icons';

export function renderSettingsView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading settings...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'settings',
      title: 'Settings',
      subtitle: 'Control allocation, fees, and return expectations used across the app.',
      content: `
        <div id="settings-feedback" class="alert d-none" role="alert"></div>

        <div class="row g-3">
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('sliders')}</span>
                  Allocation
                </h2>
                <div class="mb-3">
                  <label class="form-label">Total Investment Amount (INR)</label>
                  <div class="input-group">
                    <span class="input-group-text">₹</span>
                    <input class="form-control" type="number" min="0" step="0.01" id="settings-total-investment" />
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label">Max Allocation Limit</label>
                  <div class="input-group">
                    <input class="form-control" type="number" min="0" step="0.1" id="settings-max-allocation" />
                    <span class="input-group-text">%</span>
                  </div>
                  <div class="form-text text-muted">Percentage of total investment per trade.</div>
                </div>
                <div class="row g-3">
                  <div class="col-6">
                    <label class="form-label">L1 Zone</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-l1-zone" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-6">
                    <label class="form-label">L2 Zone</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-l2-zone" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('receipt')}</span>
                  Charges
                </h2>
                <div class="row g-3">
                  <div class="col-md-6">
                    <label class="form-label">Buy Brokerage</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-buy-brokerage" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Sell Brokerage</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-sell-brokerage" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">DP Charge</label>
                    <div class="input-group">
                      <span class="input-group-text">₹</span>
                      <input class="form-control" type="number" min="0" step="0.01" id="settings-dp-charge" />
                    </div>
                  </div>
                </div>
                <div class="text-muted small mt-2">Charges are stored for future P&L calculations.</div>
              </div>
            </div>
          </div>
          <div class="col-xl-6">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <h2 class="h6 mb-3 section-title">
                  <span class="section-icon">${lucideIcon('activity')}</span>
                  Return Benchmarks (Annual %)
                </h2>
                <div class="row g-3">
                  <div class="col-md-3">
                    <label class="form-label">Expected Return</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-expected-return" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">Inflation</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-inflation" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">FD Return</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-fd-return" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                  <div class="col-md-3">
                    <label class="form-label">Target Exit Profit</label>
                    <div class="input-group">
                      <input class="form-control" type="number" min="0" step="0.1" id="settings-target-profit" />
                      <span class="input-group-text">%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="d-flex flex-wrap gap-2 mt-4">
          <button class="btn btn-primary" id="settings-save">Save Settings</button>
          <div class="text-muted small align-self-center" id="settings-updated">Last updated: --</div>
        </div>
      `
    });

    bindShell(root, session);

    const feedback = root.querySelector<HTMLDivElement>('#settings-feedback');
    const totalInvestment = root.querySelector<HTMLInputElement>('#settings-total-investment');
    const maxAllocation = root.querySelector<HTMLInputElement>('#settings-max-allocation');
    const l1Zone = root.querySelector<HTMLInputElement>('#settings-l1-zone');
    const l2Zone = root.querySelector<HTMLInputElement>('#settings-l2-zone');
    const buyBrokerage = root.querySelector<HTMLInputElement>('#settings-buy-brokerage');
    const sellBrokerage = root.querySelector<HTMLInputElement>('#settings-sell-brokerage');
    const dpCharge = root.querySelector<HTMLInputElement>('#settings-dp-charge');
    const expectedReturn = root.querySelector<HTMLInputElement>('#settings-expected-return');
    const inflation = root.querySelector<HTMLInputElement>('#settings-inflation');
    const fdReturn = root.querySelector<HTMLInputElement>('#settings-fd-return');
    const targetProfit = root.querySelector<HTMLInputElement>('#settings-target-profit');
    const saveBtn = root.querySelector<HTMLButtonElement>('#settings-save');
    const updatedAt = root.querySelector<HTMLElement>('#settings-updated');

    if (
      !feedback ||
      !totalInvestment ||
      !maxAllocation ||
      !l1Zone ||
      !l2Zone ||
      !buyBrokerage ||
      !sellBrokerage ||
      !dpCharge ||
      !expectedReturn ||
      !inflation ||
      !fdReturn ||
      !targetProfit ||
      !saveBtn ||
      !updatedAt
    ) {
      throw new Error('Settings view failed to initialize');
    }

    const loadSettings = async () => {
      const settings = await getUserSettings(session.userId);
      totalInvestment.value = String(settings.totalInvestment || 0);
      maxAllocation.value = String(settings.maxAllocationPct || 0);
      l1Zone.value = String(settings.l1ZonePct || 0);
      l2Zone.value = String(settings.l2ZonePct || 0);
      buyBrokerage.value = String(settings.buyBrokeragePct || 0);
      sellBrokerage.value = String(settings.sellBrokeragePct || 0);
      dpCharge.value = String(settings.dpCharge || 0);
      expectedReturn.value = String(settings.expectedReturnPct || 0);
      inflation.value = String(settings.inflationPct || 0);
      fdReturn.value = String(settings.fdReturnPct || 0);
      targetProfit.value = String(settings.targetProfitPct || 10);
      updatedAt.textContent = `Last updated: ${new Date(settings.updatedAt).toLocaleString()}`;
    };

    const toNumber = (value: string) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    saveBtn.addEventListener('click', async () => {
      clearAlert(feedback);
      const label = saveBtn.textContent || 'Save Settings';
      setBusy(saveBtn, true, label);
      try {
        const settings = {
          userId: session.userId,
          totalInvestment: toNumber(totalInvestment.value),
          maxAllocationPct: toNumber(maxAllocation.value),
          l1ZonePct: toNumber(l1Zone.value),
          l2ZonePct: toNumber(l2Zone.value),
          buyBrokeragePct: toNumber(buyBrokerage.value),
          sellBrokeragePct: toNumber(sellBrokerage.value),
          dpCharge: toNumber(dpCharge.value),
          expectedReturnPct: toNumber(expectedReturn.value),
          inflationPct: toNumber(inflation.value),
          fdReturnPct: toNumber(fdReturn.value),
          targetProfitPct: toNumber(targetProfit.value),
          updatedAt: new Date().toISOString()
        };
        await saveUserSettings(settings);
        await queueSnapshot(session.userId);
        await loadSettings();
        showAlert(feedback, 'success', 'Settings saved.');
      } catch (error) {
        showAlert(feedback, 'danger', String(error));
      } finally {
        setBusy(saveBtn, false, label);
      }
    });

    await loadSettings();
  })();
}

