const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2
});

export function coerceNumber(value?: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMoney(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '--';
  return currency.format(value);
}

export function formatAmount(quantity: number, price: number): string {
  const total = Number(quantity) * Number(price);
  if (!Number.isFinite(total)) return '--';
  return formatMoney(total);
}

export function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatDate(value: string): string {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN');
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
