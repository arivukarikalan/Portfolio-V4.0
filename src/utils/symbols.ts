export function normalizeSymbol(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0];
  return first.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

export function nameInitials(value: string): string {
  const parts = String(value || '')
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  return parts.map((part) => part[0]).join('');
}

export function stripSeriesSuffix(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  if (trimmed.length <= 3) return trimmed;
  if (trimmed.endsWith('EQ')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('BE')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('BZ')) return trimmed.slice(0, -2);
  if (trimmed.endsWith('BL')) return trimmed.slice(0, -2);
  return trimmed;
}
