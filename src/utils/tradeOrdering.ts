import type { TradeRecord } from '../core/types';

function normalizeExecutionAt(value: string | undefined): string {
  return String(value || '').trim();
}

export function compareTradeExecutionAsc(a: TradeRecord, b: TradeRecord): number {
  if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);

  const aExecutionAt = normalizeExecutionAt(a.executionAt);
  const bExecutionAt = normalizeExecutionAt(b.executionAt);
  if (aExecutionAt && bExecutionAt && aExecutionAt !== bExecutionAt) {
    return aExecutionAt.localeCompare(bExecutionAt);
  }
  if (aExecutionAt && !bExecutionAt) return -1;
  if (!aExecutionAt && bExecutionAt) return 1;

  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

export function compareTradeExecutionDesc(a: TradeRecord, b: TradeRecord): number {
  return compareTradeExecutionAsc(b, a);
}
