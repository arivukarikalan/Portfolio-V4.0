import type { AppView } from './types';
import { renderLoginView } from '../views/login';
import { renderDashboardView } from '../views/dashboard';
import { renderAdminView } from '../views/admin';
import { renderHoldingsView } from '../views/holdings';
import { renderTradesView } from '../views/trades';
import { renderExitStrategyView } from '../views/exitStrategy';
import { renderInsightsView } from '../views/insights';
import { renderTargetView } from '../views/target';
import { renderTransactionsView } from '../views/transactions';
import { renderFinanceView } from '../views/finance';
import { renderPnlView } from '../views/pnl';
import { renderSettingsView } from '../views/settings';
import { renderHelpView } from '../views/help';

export type { AppView } from './types';

export function bootstrapApp(root: HTMLElement, view: AppView): void {
  switch (view) {
    case 'login':
      renderLoginView(root);
      break;
    case 'dashboard':
      renderDashboardView(root);
      break;
    case 'admin':
      renderAdminView(root);
      break;
    case 'holdings':
      renderHoldingsView(root);
      break;
    case 'trades':
      renderTradesView(root);
      break;
    case 'exit-strategy':
      renderExitStrategyView(root);
      break;
    case 'insights':
      renderInsightsView(root);
      break;
    case 'target':
      renderTargetView(root);
      break;
    case 'transactions':
      renderTransactionsView(root);
      break;
    case 'finance':
      renderFinanceView(root);
      break;
    case 'pnl':
      renderPnlView(root);
      break;
    case 'help':
      renderHelpView(root);
      break;
    case 'settings':
      renderSettingsView(root);
      break;
    default:
      renderLoginView(root);
      break;
  }
}
