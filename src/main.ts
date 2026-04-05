import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import { bootstrapApp, type AppView } from './app/App';

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
  'exit-strategy',
  'insights',
  'target',
  'transactions',
  'finance',
  'pnl',
  'help',
  'settings',
  'admin'
];
const forcedView = allowed.includes(page as AppView) ? (page as AppView) : 'login';

bootstrapApp(root, forcedView);
