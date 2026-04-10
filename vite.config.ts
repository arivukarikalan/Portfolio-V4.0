import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        admin: resolve(__dirname, 'admin.html'),
        holdings: resolve(__dirname, 'holdings.html'),
        trades: resolve(__dirname, 'trades.html'),
        'ask-finor': resolve(__dirname, 'ask-finor.html'),
        'exit-strategy': resolve(__dirname, 'exit-strategy.html'),
        insights: resolve(__dirname, 'insights.html'),
        target: resolve(__dirname, 'target.html'),
        transactions: resolve(__dirname, 'transactions.html'),
        finance: resolve(__dirname, 'finance.html'),
        pnl: resolve(__dirname, 'pnl.html'),
        settings: resolve(__dirname, 'settings.html'),
        help: resolve(__dirname, 'help.html')
      }
    }
  }
});
