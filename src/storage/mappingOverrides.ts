import { normalizeName, normalizeSymbol } from '../utils/symbols';

export type MappingOverride = {
  symbol: string;
  updatedAt: string;
};

export type MappingOverrideMap = Record<string, MappingOverride>;

const OVERRIDE_KEY = 'trade_mapping_overrides_v1';

function overrideKeys(companyName: string, rawSymbol: string, includeSymbol = true): string[] {
  const keys: string[] = [];
  const nameKey = normalizeName(companyName || '');
  const symbolKey = normalizeSymbol(rawSymbol || '');
  if (nameKey) keys.push(`NAME:${nameKey}`);
  if (includeSymbol && symbolKey) keys.push(`SYM:${symbolKey}`);
  return keys;
}

export function loadMappingOverrides(): MappingOverrideMap {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MappingOverrideMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveMappingOverrides(map: MappingOverrideMap): void {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

export function mergeMappingOverrides(incoming?: MappingOverrideMap | null): MappingOverrideMap {
  const local = loadMappingOverrides();
  if (!incoming || typeof incoming !== 'object') return local;
  let changed = false;
  Object.entries(incoming).forEach(([key, value]) => {
    if (!value?.symbol) return;
    const current = local[key];
    if (!current) {
      local[key] = value;
      changed = true;
      return;
    }
    const incomingTime = new Date(value.updatedAt || 0).getTime();
    const currentTime = new Date(current.updatedAt || 0).getTime();
    if (incomingTime > currentTime || current.symbol !== value.symbol) {
      local[key] = value;
      changed = true;
    }
  });
  if (changed) {
    saveMappingOverrides(local);
  }
  return local;
}

export function getOverrideSymbol(companyName: string, rawSymbol: string): string | null {
  const map = loadMappingOverrides();
  const keys = overrideKeys(companyName, rawSymbol, true);
  for (const key of keys) {
    if (map[key]?.symbol) return map[key].symbol;
  }
  return null;
}

export function setOverrideSymbol(
  companyName: string,
  rawSymbol: string,
  symbol: string,
  options?: { includeSymbol?: boolean }
): boolean {
  const map = loadMappingOverrides();
  const entrySymbol = normalizeSymbol(symbol);
  if (!entrySymbol) return false;
  const includeSymbol = options?.includeSymbol ?? true;
  const keys = overrideKeys(companyName, rawSymbol, includeSymbol);
  if (!keys.length) return false;
  const entry: MappingOverride = { symbol: entrySymbol, updatedAt: new Date().toISOString() };
  const changed = keys.some((key) => map[key]?.symbol !== entrySymbol);
  keys.forEach((key) => {
    map[key] = entry;
  });
  if (changed) {
    saveMappingOverrides(map);
  }
  return changed;
}
