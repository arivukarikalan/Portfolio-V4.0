import * as XLSX from 'xlsx';
import Chart from 'chart.js/auto';
import type { Chart as ChartJS, ChartConfiguration, ChartDataset, ScriptableLineSegmentContext } from 'chart.js';
import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, setBusy, showAlert, flashInline } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { renderConfirmModal, bindConfirmModal } from '../ui/confirm';
import { addTrade, deleteTrade, listTrades, updateTrade, type TradeInput } from '../storage/trades';
import { getUserSettings } from '../storage/settings';
import type {
  RecoveryLeg,
  RecoveryLossLeg,
  RecoveryPlan,
  ReentryBuyLeg,
  ReentryPlan,
  TradeRecord,
  TradeSide
} from '../core/types';
import { parseCsvText } from '../utils/csv';
import { toErrorMessage } from '../utils/errors';
import {
  listNseMasterForUser,
  listTickerRequests,
  createTickerRequest,
  type NseRow,
  type TickerRequest
} from '../services/tickers';
import { initCloudSync, queueSnapshot, syncNow } from '../services/cloudSync';
import { listLivePrices } from '../storage/prices';
import { fetchPriceHistory, type PriceHistoryPoint } from '../services/priceHistory';
import { addRecoveryPlan, deleteRecoveryPlan, listRecoveryPlans, updateRecoveryPlan } from '../storage/recoveryPlans';
import { addReentryPlan, deleteReentryPlan, listReentryPlans, updateReentryPlan } from '../storage/reentryPlans';
import { requireSession } from './guards';
import { formatAmount, formatDate, formatDateTime, formatMoney, formatPct, coerceNumber } from '../utils/format';
import { nameInitials, normalizeName, normalizeSymbol, stripSeriesSuffix } from '../utils/symbols';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { getOverrideSymbol, setOverrideSymbol } from '../storage/mappingOverrides';
import { mergeImportedTrades, type MergedTrade } from '../utils/mergedTrades';

type TradeFilters = {
  query: string;
  from: string;
  to: string;
};

type ImportTrade = TradeInput & {
  companyName?: string;
  mappedSymbol?: string;
  mappingScore?: number;
  mappingConfidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  mappingMethod?: string;
  importId?: string;
  importKey?: string;
};

type CsvAnalysis = {
  total: number;
  valid: ImportTrade[];
  invalid: Array<{ row: number; reason: string }>;
};

type ImportFailure = {
  symbol: string;
  companyName?: string;
  reason: string;
  count: number;
};

type LowConfidenceMapping = {
  symbol: string;
  companyName?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  count: number;
};

type ImportSymbolResolution = {
  symbol: string;
  mapped: boolean;
  score?: number;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  method?: string;
  reason?: string;
};

type TradeDisplay =
  | { kind: 'single'; trade: MergedTrade }
  | {
      kind: 'group';
      key: string;
      symbol: string;
      side: TradeSide;
      tradeDate: string;
      quantity: number;
      price: number;
      amount: number;
      trades: TradeRecord[];
      merged: MergedTrade;
    };

type TickerSummary = {
  symbol: string;
  tradeCount: number;
  lastTradeDate: string;
  valid: boolean;
  requestStatus?: string;
  livePrice?: number | null;
  changePct?: number | null;
  needsReview?: boolean;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
};

type RecoveryLegSummary = RecoveryLeg & {
  livePrice?: number | null;
  currentValue?: number;
  pnl?: number;
  pnlPct?: number | null;
};

type RecoveryPlanSummary = RecoveryPlan & {
  recoveredAmount: number;
  remainingAmount: number;
  recoveryPct: number | null;
  isRecovered: boolean;
  legs: RecoveryLegSummary[];
};

type ReentryPlanSummary = ReentryPlan & {
  buybackQty: number;
  buybackInvested: number;
  buybackAvg: number | null;
  lossPerShare: number | null;
  allocatedLoss: number;
  reentryGain: number;
  remainingLoss: number;
  breakEvenLtp: number | null;
  targetLtp: number | null;
};

function normalizeHeader(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function headerIndex(headers: Array<unknown>, options: string[]): number {
  const normalized = headers.map(normalizeHeader);
  const wanted = options.map(normalizeHeader);
  return normalized.findIndex((header) => wanted.includes(header));
}

function parseSide(value: unknown): TradeSide | null {
  const clean = String(value || '').trim().toLowerCase();
  if (['buy', 'b', 'long'].includes(clean)) return 'BUY';
  if (['sell', 's', 'short'].includes(clean)) return 'SELL';
  return null;
}

function coerceDate(value: unknown): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const date = new Date(parsed.y, parsed.m - 1, parsed.d);
      return date.toISOString().slice(0, 10);
    }
  }
  const asString = String(value).trim();
  if (!asString) return '';
  const date = new Date(asString);
  return Number.isNaN(date.getTime()) ? asString : date.toISOString().slice(0, 10);
}

function coerceId(value: unknown): string {
  return String(value || '').trim();
}

function buildImportId(...values: Array<string | undefined>): string | undefined {
  const raw = values.find((value) => value && String(value).trim());
  if (!raw) return undefined;
  return `ID:${String(raw).trim()}`;
}

function buildTradeSignature(
  symbol: string,
  side: TradeSide,
  quantity: number,
  price: number,
  tradeDate: string
): string {
  const qty = Number(quantity);
  const pr = Number(price);
  const normalizedSymbol = stripSeriesSuffix(normalizeSymbol(symbol));
  const normalizedDate = coerceDate(tradeDate) || String(tradeDate || '').trim();
  return [
    normalizedSymbol,
    side,
    Number.isFinite(qty) ? qty.toFixed(4) : String(quantity),
    Number.isFinite(pr) ? pr.toFixed(4) : String(price),
    normalizedDate
  ].join('|');
}

function findExistingDuplicates(
  existingTrades: TradeRecord[],
  importRows: ImportTrade[]
): { toDelete: TradeRecord[]; cleanedCount: number } {
  if (!existingTrades.length || !importRows.length) {
    return { toDelete: [], cleanedCount: 0 };
  }
  const importIds = new Set(importRows.map((row) => row.importId).filter(Boolean) as string[]);
  const importSignatures = new Set(
    importRows
      .filter((row) => !row.importId)
      .map((row) => buildTradeSignature(row.symbol, row.side, row.quantity, row.price, row.tradeDate))
  );
  const grouped = new Map<string, TradeRecord[]>();
  existingTrades.forEach((trade) => {
    const signature = buildTradeSignature(trade.symbol, trade.side, trade.quantity, trade.price, trade.tradeDate);
    const importId = trade.importId;
    let key: string | null = null;
    if (importId && importIds.has(importId)) {
      key = `ID:${importId}`;
    } else if (importSignatures.has(signature)) {
      key = `SIG:${signature}`;
    }
    if (!key) return;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(trade);
    } else {
      grouped.set(key, [trade]);
    }
  });
  const toDelete: TradeRecord[] = [];
  grouped.forEach((bucket) => {
    if (bucket.length <= 1) return;
    bucket.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    toDelete.push(...bucket.slice(1));
  });
  return { toDelete, cleanedCount: toDelete.length };
}

function buildDedupeKeys(trades: TradeRecord[]): {
  byImportId: Set<string>;
  bySignatureAll: Set<string>;
  bySignatureNoId: Set<string>;
} {
  const byImportId = new Set<string>();
  const bySignatureAll = new Set<string>();
  const bySignatureNoId = new Set<string>();
  trades.forEach((trade) => {
    if (trade.importId) {
      byImportId.add(trade.importId);
    }
    const signature = buildTradeSignature(trade.symbol, trade.side, trade.quantity, trade.price, trade.tradeDate);
    bySignatureAll.add(signature);
    if (!trade.importId) {
      bySignatureNoId.add(signature);
    }
  });
  return { byImportId, bySignatureAll, bySignatureNoId };
}

const COMPANY_STOPWORDS = new Set([
  'LTD',
  'LIMITED',
  'PVT',
  'PRIVATE',
  'CO',
  'COMPANY',
  'CORP',
  'CORPORATION',
  'INC',
  'INCORPORATED',
  'PLC',
  'LLP',
  'INDIA',
  'IND',
  'INDUSTRIES',
  'INDUSTRY',
  'HOLDINGS',
  'HOLDING',
  'INVESTMENTS',
  'INVESTMENT'
]);

const COMPANY_ABBREVIATIONS: Record<string, string> = {
  DEPO: 'DEPOSITORY',
  DEP: 'DEPOSITORY',
  DEPOT: 'DEPOSITORY',
  DEPOS: 'DEPOSITORY',
  SER: 'SERVICES',
  SERV: 'SERVICES',
  SVCS: 'SERVICES',
  SVC: 'SERVICES',
  IND: 'INDIA',
  TECH: 'TECHNOLOGIES',
  TECHNO: 'TECHNOLOGIES',
  LAB: 'LABORATORIES',
  LABS: 'LABORATORIES',
  SEC: 'SECURITIES',
  SECU: 'SECURITIES',
  SECUR: 'SECURITIES'
};

const IMPORT_CONF_KEY = 'trade_import_confidence_v1';
const IMPORT_AUDIT_KEY = 'trade_import_audit_v1';

type ImportAuditEntry = {
  id: string;
  createdAt: string;
  fileName: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  mappedCount: number;
  failedCount: number;
  lowConfidenceCount: number;
  duplicateCount?: number;
  cleanupCount?: number;
  status: 'imported' | 'failed';
  error?: string;
};

type ImportConfidenceEntry = {
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  method: string;
  updatedAt: string;
  companyName?: string;
};

type ImportConfidenceMap = Record<string, ImportConfidenceEntry>;

function normalizeCompanyTokens(value: string): string[] {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !COMPANY_STOPWORDS.has(token))
    .map((token) => COMPANY_ABBREVIATIONS[token] || token);
}

function companyAcronym(tokens: string[]): string {
  return tokens.map((token) => token[0]).join('');
}

function confidenceFromScore(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 90) return 'HIGH';
  if (score >= 80) return 'MEDIUM';
  return 'LOW';
}

function levenshtein(a: string, b: string): number {
  const s = a || '';
  const t = b || '';
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const dp = new Array(m + 1).fill(0);
  for (let j = 0; j <= m; j += 1) dp[j] = j;
  for (let i = 1; i <= n; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const temp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[m];
}

function loadImportConfidence(): ImportConfidenceMap {
  try {
    const raw = localStorage.getItem(IMPORT_CONF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ImportConfidenceMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveImportConfidence(map: ImportConfidenceMap): void {
  try {
    localStorage.setItem(IMPORT_CONF_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

function loadImportAudit(): ImportAuditEntry[] {
  try {
    const raw = localStorage.getItem(IMPORT_AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ImportAuditEntry[]) : [];
  } catch {
    return [];
  }
}

function appendImportAudit(entry: ImportAuditEntry): void {
  try {
    const list = loadImportAudit();
    list.unshift(entry);
    const trimmed = list.slice(0, 30);
    localStorage.setItem(IMPORT_AUDIT_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage errors.
  }
}

const REVIEW_APPLIED_KEY = 'trade_mapping_review_applied_v1';

type MappingReviewAppliedMap = Record<string, string>;

function loadReviewApplied(): MappingReviewAppliedMap {
  try {
    const raw = localStorage.getItem(REVIEW_APPLIED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MappingReviewAppliedMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveReviewApplied(map: MappingReviewAppliedMap): void {
  try {
    localStorage.setItem(REVIEW_APPLIED_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}


function normalizeRequestSymbol(rawSymbol: string): string {
  const raw = String(rawSymbol || '').trim();
  const reviewMatch = raw.match(/^review[:\s-]+(.+)$/i);
  return normalizeSymbol(reviewMatch ? reviewMatch[1] : raw);
}

function isReviewRequest(rawSymbol: string): boolean {
  return /^review[:\s-]+/i.test(String(rawSymbol || '').trim());
}

function updateImportConfidence(
  map: ImportConfidenceMap,
  symbol: string,
  entry: ImportConfidenceEntry
): void {
  const key = normalizeSymbol(symbol);
  if (!key) return;
  const existing = map[key];
  if (!existing) {
    map[key] = entry;
    return;
  }
  const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  if (rank[entry.confidence] > rank[existing.confidence] || entry.score > existing.score) {
    map[key] = entry;
  }
}

function inferCompanyName(rawScrip: string, companyCell: string): string {
  const companyValue = String(companyCell || '').trim();
  const looksLikeExchange = /NSE|BSE|MCX|NCDEX|CASH|EQ|FUT|OPT/i.test(companyValue);
  if (companyValue && !looksLikeExchange) {
    return companyValue;
  }
  const raw = String(rawScrip || '').trim();
  const derived = raw.replace(/^\d+\s*/, '').trim();
  return derived || companyValue;
}

function parseCsvTrades(text: string, userId: string): CsvAnalysis {
  const parsed = parseCsvText(text);
  if (!parsed.headers.length) return { total: 0, valid: [], invalid: [] };
  const symbolIdx = headerIndex(parsed.headers, ['symbol', 'ticker', 'scrip', 'stock']);
  const companyIdx = headerIndex(parsed.headers, ['company', 'company_name', 'stock_name', 'scrip_name', 'name']);
  const sideIdx = headerIndex(parsed.headers, ['side', 'type', 'trade_type', 'buy_sell']);
  const qtyIdx = headerIndex(parsed.headers, ['qty', 'quantity', 'trade_qty']);
  const priceIdx = headerIndex(parsed.headers, ['price', 'trade_price', 'rate']);
  const dateIdx = headerIndex(parsed.headers, ['date', 'trade_date', 'order_execution_time']);
  const execTimeIdx = headerIndex(parsed.headers, [
    'order_execution_time',
    'trade_time',
    'execution_time',
    'timestamp',
    'order_time',
    'time'
  ]);
  const tradeIdIdx = headerIndex(parsed.headers, ['trade_id', 'trade id', 'tradeid', 'execution_id', 'execution id']);
  const orderIdIdx = headerIndex(parsed.headers, ['order_id', 'order id', 'orderid', 'order_no', 'order no', 'order number']);
  const exchangeIdIdx = headerIndex(parsed.headers, [
    'exchange_order_id',
    'exchange order id',
    'exch_order_id',
    'exchange_order_no'
  ]);
  const notesIdx = headerIndex(parsed.headers, ['notes', 'note', 'remarks']);

  if (symbolIdx < 0 || qtyIdx < 0 || priceIdx < 0) {
    throw new Error('Unsupported CSV format. Please upload a broker tradebook CSV with symbol, qty, and price.');
  }

  const valid: ImportTrade[] = [];
  const invalid: Array<{ row: number; reason: string }> = [];
  parsed.body.forEach((row, index) => {
    const rawSymbol = String(row[symbolIdx] || '');
    const symbol = normalizeSymbol(rawSymbol);
    const companyName = inferCompanyName(rawSymbol, companyIdx >= 0 ? String(row[companyIdx] || '') : '');
    const side = sideIdx >= 0 ? parseSide(row[sideIdx]) : 'BUY';
    const quantity = Number(row[qtyIdx]);
    const price = Number(row[priceIdx]);
    const tradeDate = coerceDate(dateIdx >= 0 ? row[dateIdx] : '');
    const notes = notesIdx >= 0 ? String(row[notesIdx] || '').trim() : '';
    const importId = buildImportId(
      coerceId(tradeIdIdx >= 0 ? row[tradeIdIdx] : ''),
      coerceId(orderIdIdx >= 0 ? row[orderIdIdx] : ''),
      coerceId(exchangeIdIdx >= 0 ? row[exchangeIdIdx] : ''),
      coerceId(execTimeIdx >= 0 ? row[execTimeIdx] : '')
    );

    if (!symbol || !Number.isFinite(quantity) || !Number.isFinite(price)) {
      invalid.push({ row: index + 2, reason: 'Missing symbol/qty/price' });
      return;
    }

    valid.push({
      userId,
      symbol,
      side: side || 'BUY',
      quantity,
      price,
      tradeDate: tradeDate || new Date().toISOString().slice(0, 10),
      notes,
      companyName: companyName || undefined,
      importId
    });
  });

  return { total: parsed.body.length, valid, invalid };
}

function parseExcelTrades(rows: unknown[][], userId: string): CsvAnalysis | null {
  if (!rows.length) return null;
  let headerRowIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === 'scrip'));
  if (headerRowIndex < 0) {
    headerRowIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === 'symbol'));
  }
  if (headerRowIndex < 0) return null;

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const body = rows.slice(headerRowIndex + 1);

  const isTradeBook = headers.includes('scrip') && (headers.includes('b_qty') || headers.includes('s_qty'));
  if (isTradeBook) {
    const scripIdx = headers.indexOf('scrip');
    const companyIdx = headerIndex(headers, ['company', 'company_name', 'scrip_name', 'stock_name', 'name']);
    const dateIdx = headerIndex(headers, ['date']);
    const tradeIdIdx = headerIndex(headers, ['trade_id', 'trade id', 'tradeid', 'execution_id', 'execution id']);
    const orderIdIdx = headerIndex(headers, ['order_id', 'order id', 'orderid', 'order_no', 'order no', 'order number']);
    const exchangeIdIdx = headerIndex(headers, [
      'exchange_order_id',
      'exchange order id',
      'exch_order_id',
      'exchange_order_no'
    ]);
    const narrationIdx = headerIndex(headers, ['narration', 'remarks']);
    const buyQtyIdx = headerIndex(headers, ['b_qty', 'bqty']);
    const buyRateIdx = headerIndex(headers, ['b_n_rate', 'b_gr_rate', 'b_rate']);
    const sellQtyIdx = headerIndex(headers, ['s_qty', 'sqty']);
    const sellRateIdx = headerIndex(headers, ['s_n_rate', 's_gr_rate', 's_rate']);

    const valid: ImportTrade[] = [];
    const invalid: Array<{ row: number; reason: string }> = [];
    body.forEach((row, index) => {
      const narration = narrationIdx >= 0 ? String(row[narrationIdx] || '').toLowerCase() : '';
      if (narration.includes('carry forward')) {
        return;
      }
      const rawScrip = String(row[scripIdx] || '');
      const symbol = normalizeSymbol(rawScrip);
      const companyName = inferCompanyName(rawScrip, companyIdx >= 0 ? String(row[companyIdx] || '') : '');
      const tradeDate = coerceDate(row[dateIdx]);
      const buyQty = buyQtyIdx >= 0 ? Number(row[buyQtyIdx]) : 0;
      const sellQty = sellQtyIdx >= 0 ? Number(row[sellQtyIdx]) : 0;
      const buyRate = buyRateIdx >= 0 ? Number(row[buyRateIdx]) : 0;
      const sellRate = sellRateIdx >= 0 ? Number(row[sellRateIdx]) : 0;
      const baseImportId = buildImportId(
        coerceId(tradeIdIdx >= 0 ? row[tradeIdIdx] : ''),
        coerceId(orderIdIdx >= 0 ? row[orderIdIdx] : ''),
        coerceId(exchangeIdIdx >= 0 ? row[exchangeIdIdx] : '')
      );

      if (!symbol) {
        invalid.push({ row: index + headerRowIndex + 2, reason: 'Missing symbol' });
        return;
      }

      if (Number.isFinite(buyQty) && buyQty > 0 && Number.isFinite(buyRate) && buyRate > 0) {
        valid.push({
          userId,
          symbol,
          side: 'BUY',
          quantity: buyQty,
          price: buyRate,
          tradeDate: tradeDate || new Date().toISOString().slice(0, 10),
          companyName: companyName || undefined,
          importId: baseImportId ? `${baseImportId}|BUY` : undefined
        });
      }

      if (Number.isFinite(sellQty) && sellQty > 0 && Number.isFinite(sellRate) && sellRate > 0) {
        valid.push({
          userId,
          symbol,
          side: 'SELL',
          quantity: sellQty,
          price: sellRate,
          tradeDate: tradeDate || new Date().toISOString().slice(0, 10),
          companyName: companyName || undefined,
          importId: baseImportId ? `${baseImportId}|SELL` : undefined
        });
      }
    });

    return { total: body.length, valid, invalid };
  }

  const symbolIdx = headerIndex(headers, ['symbol', 'ticker', 'scrip']);
  const companyIdx = headerIndex(headers, ['company', 'company_name', 'scrip_name', 'stock_name', 'name']);
  const sideIdx = headerIndex(headers, ['side', 'type', 'trade_type', 'buy_sell']);
  const qtyIdx = headerIndex(headers, ['qty', 'quantity', 'trade_qty']);
  const priceIdx = headerIndex(headers, ['price', 'trade_price', 'rate']);
  const dateIdx = headerIndex(headers, ['date', 'trade_date']);
  const tradeIdIdx = headerIndex(headers, ['trade_id', 'trade id', 'tradeid', 'execution_id', 'execution id']);
  const orderIdIdx = headerIndex(headers, ['order_id', 'order id', 'orderid', 'order_no', 'order no', 'order number']);
  const exchangeIdIdx = headerIndex(headers, [
    'exchange_order_id',
    'exchange order id',
    'exch_order_id',
    'exchange_order_no'
  ]);
  const notesIdx = headerIndex(headers, ['notes', 'note', 'remarks']);

  if (symbolIdx < 0 || qtyIdx < 0 || priceIdx < 0) {
    return null;
  }

  const valid: ImportTrade[] = [];
  const invalid: Array<{ row: number; reason: string }> = [];
  body.forEach((row, index) => {
    const rawSymbol = String(row[symbolIdx] || '');
    const symbol = normalizeSymbol(rawSymbol);
    const companyName = inferCompanyName(rawSymbol, companyIdx >= 0 ? String(row[companyIdx] || '') : '');
    const side = sideIdx >= 0 ? parseSide(row[sideIdx]) : 'BUY';
    const quantity = Number(row[qtyIdx]);
    const price = Number(row[priceIdx]);
    const tradeDate = coerceDate(dateIdx >= 0 ? row[dateIdx] : '');
    const notes = notesIdx >= 0 ? String(row[notesIdx] || '').trim() : '';
    const importId = buildImportId(
      coerceId(tradeIdIdx >= 0 ? row[tradeIdIdx] : ''),
      coerceId(orderIdIdx >= 0 ? row[orderIdIdx] : ''),
      coerceId(exchangeIdIdx >= 0 ? row[exchangeIdIdx] : '')
    );

    if (!symbol || !Number.isFinite(quantity) || !Number.isFinite(price)) {
      invalid.push({ row: index + headerRowIndex + 2, reason: 'Missing symbol/qty/price' });
      return;
    }

    valid.push({
      userId,
      symbol,
      side: side || 'BUY',
      quantity,
      price,
      tradeDate: tradeDate || new Date().toISOString().slice(0, 10),
      notes,
      companyName: companyName || undefined,
      importId
    });
  });

  return { total: body.length, valid, invalid };
}

async function parseTradeFile(file: File, userId: string): Promise<CsvAnalysis> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    const text = await file.text();
    return parseCsvTrades(text, userId);
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  let matchedSheets = 0;
  const combined: CsvAnalysis = { total: 0, valid: [], invalid: [] };
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const analysis = parseExcelTrades(rows, userId);
    if (!analysis) return;
    matchedSheets += 1;
    combined.total += analysis.total;
    combined.valid.push(...analysis.valid);
    combined.invalid.push(...analysis.invalid);
  });
  if (!matchedSheets) {
    throw new Error('Unsupported Excel format. Please upload a broker tradebook file.');
  }
  return combined;
}

function dedupeImportRows(
  rows: ImportTrade[],
  existingTrades: TradeRecord[]
): { rows: ImportTrade[]; duplicateCount: number } {
  const { byImportId, bySignatureAll, bySignatureNoId } = buildDedupeKeys(existingTrades);
  let duplicateCount = 0;
  const next: ImportTrade[] = [];
  rows.forEach((row) => {
    const signature = buildTradeSignature(row.symbol, row.side, row.quantity, row.price, row.tradeDate);
    const importId = row.importId;
    const isDuplicate = importId
      ? byImportId.has(importId) || bySignatureNoId.has(signature)
      : bySignatureAll.has(signature);
    if (isDuplicate) {
      duplicateCount += 1;
      return;
    }
    next.push(row);
    if (importId) {
      byImportId.add(importId);
    } else {
      bySignatureNoId.add(signature);
    }
    bySignatureAll.add(signature);
  });
  return { rows: next, duplicateCount };
}

function renderTableRows(trades: TradeRecord[], _linkedLossTradeIds: Set<string> = new Set()): string {
  if (!trades.length) {
    return `
      <tr>
        <td colspan="7" class="text-center py-4">
          <div class="fw-semibold mb-1">No trades yet.</div>
          <div class="text-muted small mb-2">Import your broker tradebook to get started.</div>
          <a class="btn btn-sm btn-outline-primary" href="trades.html#import">Import trades</a>
        </td>
      </tr>
    `;
  }

  const display = groupTradesForDisplay(trades);
  return display
    .map((row) => {
      if (row.kind === 'single') {
        const trade = row.trade;
        const sideBadge = trade.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
        const fillBadge =
          trade.importBased && trade.fillCount > 1
            ? ` <span class="badge text-bg-light border">Fills ${trade.fillCount}</span>`
            : '';
        return `
          <tr data-trade-id="${trade.trades[0].id}">
            <td>${formatDate(trade.tradeDate)}</td>
            <td class="fw-semibold">${trade.symbol}${fillBadge}</td>
            <td><span class="badge ${sideBadge}">${trade.side}</span></td>
            <td>${trade.quantity}</td>
            <td>${formatMoney(trade.price)}</td>
            <td>${formatAmount(trade.quantity, trade.price)}</td>
            <td class="text-end text-nowrap">
              ${
                trade.trades.length === 1
                  ? '<button class="btn btn-sm btn-outline-primary me-2" data-action="edit">Edit</button><button class="btn btn-sm btn-outline-danger" data-action="delete">Delete</button>'
                  : `<button class="btn btn-sm btn-outline-secondary" data-action="toggle-group" data-group-key="${trade.id}">View Fills</button>`
              }
            </td>
          </tr>
          ${
            trade.trades.length > 1
              ? trade.trades
                  .map(
                    (fill) => `
              <tr class="trade-group-child d-none" data-parent-group="${trade.id}" data-trade-id="${fill.id}">
                <td>${formatDate(fill.tradeDate)}</td>
                <td class="fw-semibold">${fill.symbol}</td>
                <td><span class="badge ${sideBadge}">${fill.side}</span></td>
                <td>${fill.quantity}</td>
                <td>${formatMoney(fill.price)}</td>
                <td>${formatAmount(fill.quantity, fill.price)}</td>
                <td class="text-end text-nowrap">
                  <button class="btn btn-sm btn-outline-primary me-2" data-action="edit">Edit</button>
                  <button class="btn btn-sm btn-outline-danger" data-action="delete">Delete</button>
                </td>
              </tr>
            `
                  )
                  .join('')
              : ''
          }
        `;
      }
      const sideBadge = row.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
      const fillCount = row.trades.length;
      const childRows = row.trades
        .map((trade) => {
          return `
            <tr class="trade-group-child d-none" data-parent-group="${row.key}" data-trade-id="${trade.id}">
              <td>${formatDate(trade.tradeDate)}</td>
              <td class="fw-semibold">${trade.symbol}</td>
              <td><span class="badge ${sideBadge}">${trade.side}</span></td>
              <td>${trade.quantity}</td>
              <td>${formatMoney(trade.price)}</td>
              <td>${formatAmount(trade.quantity, trade.price)}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-primary me-2" data-action="edit">Edit</button>
                <button class="btn btn-sm btn-outline-danger" data-action="delete">Delete</button>
              </td>
            </tr>
          `;
        })
        .join('');
      return `
        <tr class="trade-group-row" data-group-key="${row.key}">
          <td>${formatDate(row.tradeDate)}</td>
          <td class="fw-semibold">${row.symbol} <span class="badge text-bg-light border">Fills ${fillCount}</span></td>
          <td><span class="badge ${sideBadge}">${row.side}</span></td>
          <td>${row.quantity}</td>
          <td>${formatMoney(row.price)}</td>
          <td>${formatMoney(row.amount)}</td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-secondary" data-action="toggle-group" data-group-key="${row.key}">View Fills</button>
          </td>
        </tr>
        ${childRows}
      `;
    })
    .join('');
}

function renderCardRows(trades: TradeRecord[], _linkedLossTradeIds: Set<string> = new Set()): string {
  if (!trades.length) {
    return `
      <div class="text-center py-4">
        <div class="fw-semibold mb-1">No trades yet.</div>
        <div class="text-muted small mb-2">Import your broker tradebook to get started.</div>
        <a class="btn btn-sm btn-outline-primary" href="trades.html#import">Import trades</a>
      </div>
    `;
  }

  const display = groupTradesForDisplay(trades);
  return display
    .map((row) => {
      if (row.kind === 'single') {
        const trade = row.trade;
        const sideBadge = trade.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
        const fillBadge =
          trade.importBased && trade.fillCount > 1
            ? ` <span class="badge text-bg-light border">Fills ${trade.fillCount}</span>`
            : '';
        return `
          <div class="card trade-card shadow-sm border-0" data-trade-id="${trade.trades[0].id}">
            <div class="card-body d-flex flex-column gap-3">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <div class="trade-card-head">
                  <div class="trade-card-symbol fw-semibold">${trade.symbol}${fillBadge}</div>
                  <div class="text-muted small trade-card-date">${formatDate(trade.tradeDate)}</div>
                </div>
                <div class="text-end">
                  <span class="badge ${sideBadge}">${trade.side}</span>
                </div>
              </div>
              <div class="trade-card-metrics">
                <div class="trade-card-metric"><span class="text-muted">Qty</span><strong>${trade.quantity}</strong></div>
                <div class="trade-card-metric"><span class="text-muted">Entry</span><strong>${formatMoney(trade.price)}</strong></div>
                <div class="trade-card-metric trade-card-metric-amount"><span class="text-muted">Amount</span><strong>${formatAmount(trade.quantity, trade.price)}</strong></div>
              </div>
              <div class="d-flex gap-2 trade-card-actions">
                ${
                  trade.trades.length === 1
                    ? '<button class="btn btn-sm btn-outline-primary flex-grow-1" data-action="edit">Edit</button><button class="btn btn-sm btn-outline-danger flex-grow-1" data-action="delete">Delete</button>'
                    : `<button class="btn btn-sm btn-outline-secondary flex-grow-1" data-action="toggle-group" data-group-key="${trade.id}">View Fills</button>`
                }
              </div>
              ${
                trade.trades.length > 1
                  ? `<div class="trade-group-details d-flex flex-column gap-2">
                      ${trade.trades
                        .map(
                          (fill) => `
                        <div class="trade-group-child d-none" data-parent-group="${trade.id}" data-trade-id="${fill.id}">
                          <div class="d-flex justify-content-between align-items-center small">
                            <div class="text-muted">${formatDate(fill.tradeDate)}</div>
                            <div>${fill.quantity} @ ${formatMoney(fill.price)}</div>
                          </div>
                          <div class="d-flex gap-2 mt-2">
                            <button class="btn btn-sm btn-outline-primary flex-grow-1" data-action="edit">Edit</button>
                            <button class="btn btn-sm btn-outline-danger flex-grow-1" data-action="delete">Delete</button>
                          </div>
                        </div>
                      `
                        )
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          </div>
        `;
      }
      const sideBadge = row.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
      const fillCount = row.trades.length;
      const childItems = row.trades
        .map((trade) => {
          return `
            <div class="trade-group-child d-none" data-parent-group="${row.key}" data-trade-id="${trade.id}">
              <div class="d-flex justify-content-between align-items-center small">
                <div class="text-muted">${formatDate(trade.tradeDate)}</div>
                <div>${trade.quantity} @ ${formatMoney(trade.price)}</div>
              </div>
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-outline-primary flex-grow-1" data-action="edit">Edit</button>
                <button class="btn btn-sm btn-outline-danger flex-grow-1" data-action="delete">Delete</button>
              </div>
            </div>
          `;
        })
        .join('');
      return `
        <div class="card trade-card shadow-sm border-0" data-group-key="${row.key}">
          <div class="card-body d-flex flex-column gap-3">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <div class="trade-card-head">
                <div class="trade-card-symbol fw-semibold">${row.symbol} <span class="badge text-bg-light border">Fills ${fillCount}</span></div>
                <div class="text-muted small trade-card-date">${formatDate(row.tradeDate)}</div>
              </div>
              <div class="text-end">
                <span class="badge ${sideBadge}">${row.side}</span>
              </div>
            </div>
            <div class="trade-card-metrics">
              <div class="trade-card-metric"><span class="text-muted">Qty</span><strong>${row.quantity}</strong></div>
              <div class="trade-card-metric"><span class="text-muted">Entry</span><strong>${formatMoney(row.price)}</strong></div>
              <div class="trade-card-metric trade-card-metric-amount"><span class="text-muted">Amount</span><strong>${formatMoney(row.amount)}</strong></div>
            </div>
            <div class="d-flex gap-2 trade-card-actions">
              <button class="btn btn-sm btn-outline-secondary flex-grow-1" data-action="toggle-group" data-group-key="${row.key}">View Fills</button>
            </div>
            <div class="trade-group-details d-flex flex-column gap-2">
              ${childItems}
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function applyFilters(trades: TradeRecord[], filters: TradeFilters): TradeRecord[] {
  return trades.filter((trade) => {
    const query = filters.query.toLowerCase();
    const queryMatch =
      !query ||
      trade.symbol.toLowerCase().includes(query) ||
      (trade.notes || '').toLowerCase().includes(query);
    const fromMatch = !filters.from || trade.tradeDate >= filters.from;
    const toMatch = !filters.to || trade.tradeDate <= filters.to;
    return queryMatch && fromMatch && toMatch;
  });
}

function groupTradesForDisplay(trades: TradeRecord[]): TradeDisplay[] {
  return mergeImportedTrades(trades).map((trade) => {
    if (trade.trades.length === 1) {
      return { kind: 'single', trade };
    }
    return {
      kind: 'group',
      key: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      tradeDate: trade.tradeDate,
      quantity: trade.quantity,
      price: trade.price,
      amount: trade.amount,
      trades: trade.trades,
      merged: trade
    };
  });
}

function buildTickerSummary(
  trades: TradeRecord[],
  nseSet: Set<string>,
  requests: TickerRequest[],
  prices: Map<string, { price?: number | string; changePct?: number | string }>,
  confidenceMap: ImportConfidenceMap
): TickerSummary[] {
  const map = new Map<string, TickerSummary>();
  mergeImportedTrades(trades).forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    if (!symbol) return;
    const existing = map.get(symbol);
    if (!existing) {
      const confidence = confidenceMap[symbol]?.confidence;
      map.set(symbol, {
        symbol,
        tradeCount: 1,
        lastTradeDate: trade.tradeDate,
        valid: nseSet.has(symbol),
        requestStatus: undefined,
        livePrice: null,
        changePct: null,
        needsReview: confidence ? confidence !== 'HIGH' : false,
        confidence
      });
      return;
    }
    existing.tradeCount += 1;
    if (trade.tradeDate > existing.lastTradeDate) {
      existing.lastTradeDate = trade.tradeDate;
    }
    if (!existing.confidence && confidenceMap[symbol]?.confidence) {
      existing.confidence = confidenceMap[symbol].confidence;
      existing.needsReview = existing.confidence !== 'HIGH';
    }
  });

  const reviewSymbols = new Set<string>();
  requests.forEach((req) => {
    const symbol = normalizeRequestSymbol(req.rawSymbol);
    if (isReviewRequest(req.rawSymbol)) {
      reviewSymbols.add(symbol);
    }
    const existing = map.get(symbol);
    if (existing) {
      existing.requestStatus = req.status;
      if (String(req.status || '').toUpperCase() === 'APPROVED') {
        existing.valid = true;
        existing.requestStatus = undefined;
      }
    }
  });

  map.forEach((entry) => {
    if (entry.valid && entry.requestStatus === 'PENDING' && !reviewSymbols.has(entry.symbol)) {
      entry.requestStatus = undefined;
    }
  });

  map.forEach((entry) => {
    const price = prices.get(entry.symbol);
    if (!price) return;
    entry.livePrice = coerceNumber(price.price);
    entry.changePct = coerceNumber(price.changePct);
  });

  return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

 

export function renderTradesView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading trades...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    const urlParams = new URLSearchParams(window.location.search);
    const deepSymbol = normalizeSymbol(urlParams.get('symbol') || '');
    const deepFrom = urlParams.get('from') || '';
    const deepTo = urlParams.get('to') || '';
    const requestedTab = window.location.hash.replace('#', '');
    const initialTab =
      requestedTab === 'recovery' || requestedTab === 'reentry' ? 'history' : requestedTab || (deepSymbol ? 'history' : 'history');
    const quickNav = [
      { id: 'list', label: 'Ticker List', href: 'trades.html#list', icon: 'list' },
      { id: 'request', label: 'Ticker Request', href: 'trades.html#request', icon: 'send' },
      { id: 'history', label: 'Trade History', href: 'trades.html#history', icon: 'history' }
    ];

    root.innerHTML = renderShell({
      session,
      active: 'trades',
      title: 'Trades',
      subtitle: 'Capture buys, sells, and outcomes in one place.',
      quickNav,
      quickNavActive: initialTab,
      content: `
        <div class="trades-page">
          <div id="trade-feedback" class="alert d-none" role="alert"></div>

          <div class="card shadow-sm border-0 trades-hero mb-3">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
                <div>
                  <div class="trades-eyebrow">Trading journal</div>
                  <h1 class="h5 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('repeat')}</span>
                    Trades
                  </h1>
                  <div class="text-muted small">Track buys, sells, grouped fills, and recent activity in one place.</div>
                </div>
                <div class="d-flex flex-wrap gap-2 trades-hero-actions">
                  <a class="btn btn-outline-secondary" href="exit-strategy.html">${lucideIcon('crosshair')} Exit Strategy</a>
                  <button class="btn btn-primary" id="trade-add">${lucideIcon('plus')} Add Trade</button>
                  <label class="btn btn-outline-secondary mb-0" id="trade-import-label">
                    ${lucideIcon('upload')} Import File
                    <input type="file" id="trade-import" accept=".csv,.xlsx,.xls" hidden />
                  </label>
                </div>
              </div>
              <div id="trade-import-report" class="alert alert-warning d-none mt-3 mb-0" role="alert"></div>
            </div>
          </div>

          <div class="row g-3 mb-3 trades-kpi-row">
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100 trades-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon indigo">${lucideIcon('layers')}</span>
                  Total Trades
                </div>
                <div class="h5 mb-0" id="kpi-total">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100 trades-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon teal">${lucideIcon('arrow-up-right')}</span>
                  Buy Trades
                </div>
                <div class="h5 mb-0" id="kpi-open">--</div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100 trades-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon rose">${lucideIcon('arrow-down-right')}</span>
                  Sell Trades
                </div>
                <div class="h5 mb-0" id="kpi-winrate">--</div>
                <div class="small text-muted" id="kpi-winmeta"></div>
              </div>
            </div>
          </div>
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100 trades-kpi-card">
              <div class="card-body">
                <div class="text-muted small kpi-label">
                  <span class="label-icon amber">${lucideIcon('calculator')}</span>
                  Avg Amount
                </div>
                <div class="h5 mb-0" id="kpi-net">--</div>
              </div>
            </div>
          </div>
        </div>

        <section class="trade-tab" data-trade-panel="list">
          <div class="card shadow-sm border-0 mb-3 trades-section-card">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 ticker-header">
                <div>
                  <div class="trades-eyebrow">Symbols</div>
                  <h2 class="h6 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('list')}</span>
                    Ticker List
                  </h2>
                  <div class="text-muted small" id="price-last-refresh">Last refresh: --</div>
                </div>
                <div class="d-flex align-items-center gap-2 ticker-actions">
                  <button class="btn btn-sm btn-outline-secondary" id="price-refresh">
                    ${lucideIcon('refresh-ccw')} Refresh Prices
                  </button>
                  <div class="text-muted small" id="ticker-count">--</div>
                </div>
              </div>
              <div class="table-responsive">
                <table class="table table-sm align-middle trade-table trade-table-soft table-striped table-hover mb-0 mobile-stack mobile-toggle-details">
                  <thead>
                    <tr>
                      <th class="col-ticker">
                        <button class="btn btn-link p-0 text-decoration-none text-reset" data-sort="ticker">
                          Ticker <span class="sort-icon" data-sort-icon="ticker"></span>
                        </button>
                      </th>
                      <th class="col-status">Status</th>
                      <th class="col-ltp text-end">
                        <button class="btn btn-link p-0 text-decoration-none text-reset" data-sort="ltp">
                          LTP <span class="sort-icon" data-sort-icon="ltp"></span>
                        </button>
                      </th>
                      <th class="col-chg text-end">
                        <button class="btn btn-link p-0 text-decoration-none text-reset" data-sort="chg">
                          Chg% <span class="sort-icon" data-sort-icon="chg"></span>
                        </button>
                      </th>
                      <th class="col-trades">Trades</th>
                      <th class="col-last">
                        <button class="btn btn-link p-0 text-decoration-none text-reset" data-sort="last">
                          Last Trade <span class="sort-icon" data-sort-icon="last"></span>
                        </button>
                      </th>
                      <th class="col-action text-end">Action</th>
                    </tr>
                  </thead>
                  <tbody id="ticker-body"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <section class="trade-tab d-none" data-trade-panel="request">
          <div class="row g-3 mb-3">
            <div class="col-lg-4">
              <div class="card shadow-sm border-0 trades-section-card">
                <div class="card-body">
                  <div class="trades-eyebrow">Requests</div>
                  <h2 class="h6 mb-3 section-title">
                    <span class="section-icon">${lucideIcon('send')}</span>
                    Request New Ticker
                  </h2>
                  <div class="mb-3">
                    <label class="form-label">Ticker Symbol</label>
                    <input class="form-control" id="ticker-request-symbol" placeholder="e.g. ABC" />
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Note (optional)</label>
                    <input class="form-control" id="ticker-request-note" placeholder="Any details" />
                  </div>
                  <button class="btn btn-primary w-100" id="ticker-request-submit">Send Request</button>
                </div>
              </div>
            </div>
            <div class="col-lg-8">
              <div class="card shadow-sm border-0 trades-section-card">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3 request-header">
                    <div>
                      <div class="trades-eyebrow">Requests</div>
                      <h2 class="h6 mb-0 section-title">
                        <span class="section-icon">${lucideIcon('clipboard-list')}</span>
                        My Ticker Requests
                      </h2>
                    </div>
                    <div class="text-muted small" id="request-count">--</div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle trade-table trade-table-soft table-striped mb-0 mobile-stack mobile-compact-rows">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Status</th>
                          <th>Requested</th>
                          <th>Resolved</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody id="request-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="trade-tab d-none" data-trade-panel="history">
          <div class="card shadow-sm border-0 mb-3 trades-section-card">
            <div class="card-body">
              <div class="row g-2 align-items-end mb-3 trade-filter-bar trades-filter-bar">
                <div class="col-12 col-md-4">
                  <label class="form-label small text-muted">Search</label>
                  <div class="input-group input-group-sm">
                    <span class="input-group-text bg-white">${lucideIcon('search')}</span>
                    <input class="form-control" id="filter-query" placeholder="Search symbol or notes" />
                  </div>
                </div>
                <div class="col-6 col-md-3">
                  <label class="form-label small text-muted">From</label>
                  <div class="input-group input-group-sm">
                    <span class="input-group-text bg-white">${lucideIcon('calendar')}</span>
                    <input class="form-control" type="date" id="filter-from" />
                  </div>
                </div>
                <div class="col-6 col-md-3">
                  <label class="form-label small text-muted">To</label>
                  <div class="input-group input-group-sm">
                    <span class="input-group-text bg-white">${lucideIcon('calendar')}</span>
                    <input class="form-control" type="date" id="filter-to" />
                  </div>
                </div>
                <div class="col-12 col-md-2 d-grid gap-2">
                  <button class="btn btn-outline-secondary btn-sm" id="filter-30">Last 30 Days</button>
                  <button class="btn btn-outline-secondary btn-sm" id="filter-clear">Clear</button>
                </div>
              </div>
            </div>
          </div>

          <div class="card shadow-sm border-0 mb-3 trades-section-card trades-history-card">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2 recovery-trend-header">
                <h2 class="h6 mb-0 section-title">
                  <span class="section-icon">${lucideIcon('history')}</span>
                  Trade History
                </h2>
                <div class="text-muted small" id="trade-count">--</div>
              </div>
              <div class="table-responsive d-none d-md-block">
                <table class="table table-sm align-middle trade-table trade-table-soft mb-0 trades-history-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Amount</th>
                      <th class="text-end">Action</th>
                    </tr>
                  </thead>
                  <tbody id="trade-table-body"></tbody>
                </table>
              </div>
              <div class="d-md-none d-flex flex-column gap-2 trade-card-list" id="trade-card-list"></div>
            </div>
          </div>
        </section>

        <section class="trade-tab d-none" data-trade-panel="recovery">
          <div class="row g-3 mb-3">
            <div class="col-xl-5">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h2 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('rotate-cw')}</span>
                      Recovery Dashboard
                    </h2>
                    <div class="text-muted small" id="recovery-summary-updated">--</div>
                  </div>
                  <div class="row g-2">
                    <div class="col-6">
                      <div class="kpi-card">
                        <div class="text-muted small">Active Plans</div>
                        <div class="h5 mb-0" id="recovery-active">0</div>
                      </div>
                    </div>
                    <div class="col-6">
                      <div class="kpi-card">
                        <div class="text-muted small">Recovered Plans</div>
                        <div class="h5 mb-0" id="recovery-recovered">0</div>
                      </div>
                    </div>
                    <div class="col-6">
                      <div class="kpi-card">
                        <div class="text-muted small">Recovery Win %</div>
                        <div class="h5 mb-0" id="recovery-win">--</div>
                      </div>
                    </div>
                    <div class="col-6">
                      <div class="kpi-card">
                        <div class="text-muted small">Net Recovery (Live)</div>
                        <div class="h5 mb-0" id="recovery-net">--</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-xl-7">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h3 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('layers')}</span>
                      Recovery Plans
                    </h3>
                    <div class="text-muted small" id="recovery-count">0 plans</div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Plan</th>
                          <th>Loss</th>
                          <th>Recovered</th>
                          <th>Remaining</th>
                          <th>Status</th>
                          <th class="text-end">Action</th>
                        </tr>
                      </thead>
                      <tbody id="recovery-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card shadow-sm border-0 mb-3">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2 recovery-trend-header">
                <div class="recovery-trend-title">
                  <h3 class="h6 mb-0 section-title">
                    <span class="section-icon">${lucideIcon('line-chart')}</span>
                    Recovery Trend
                  </h3>
                </div>
                <div class="d-flex align-items-center gap-2 flex-wrap recovery-controls recovery-trend-controls">
                  <div class="btn-group btn-group-sm recovery-controls-group" role="group">
                    <button class="btn btn-outline-secondary" data-recovery-pen="lossTarget" type="button">
                      Loss Target
                    </button>
                    <button class="btn btn-outline-secondary" data-recovery-pen="recovered" type="button">
                      Recovered
                    </button>
                    <button class="btn btn-outline-secondary" data-recovery-pen="breakEven" type="button">
                      Break-even
                    </button>
                    <button class="btn btn-outline-secondary" data-recovery-pen="tradeALtp" type="button">
                      Trade A Avg LTP
                    </button>
                    <button class="btn btn-outline-secondary" data-recovery-pen="tradeBLtp" type="button">
                      Trade B Avg LTP
                    </button>
                  </div>
                  <div class="text-muted small recovery-meta" id="recovery-trend-loss-date">Loss sold: --</div>
                  <div class="text-muted small recovery-meta" id="recovery-trend-recovery-date">Recovery start: --</div>
                  <div class="btn-group btn-group-sm recovery-controls-group" role="group">
                    <button class="btn btn-outline-secondary" data-recovery-view="index" type="button">Index</button>
                    <button class="btn btn-outline-secondary" data-recovery-view="return" type="button">Return %</button>
                    <button class="btn btn-outline-secondary" data-recovery-view="ltp" type="button">LTP</button>
                  </div>
                  <div class="btn-group btn-group-sm recovery-controls-group" role="group">
                    <button class="btn btn-outline-secondary" data-recovery-range="7d" type="button">1W</button>
                    <button class="btn btn-outline-secondary" data-recovery-range="1m" type="button">1M</button>
                    <button class="btn btn-outline-secondary" data-recovery-range="3m" type="button">3M</button>
                    <button class="btn btn-outline-secondary" data-recovery-range="6m" type="button">6M</button>
                    <button class="btn btn-outline-secondary" data-recovery-range="all" type="button">All</button>
                  </div>
                  <input
                    class="form-control form-control-sm recovery-plan-input"
                    id="recovery-plan-title"
                    placeholder="Plan name"
                  />
                  <button class="btn btn-sm btn-outline-primary recovery-plan-save" id="recovery-plan-title-save" type="button">
                    Save
                  </button>
                </div>
              </div>
              <div class="chart-wrap recovery-trend-chart">
                <canvas id="recovery-trend-chart" height="200"></canvas>
                <div class="chart-empty text-muted small d-none" id="recovery-trend-empty">
                  Select a recovery plan to see the trend.
                </div>
              </div>
            </div>
          </div>

          <div class="row g-3">
            <div class="col-xl-6">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h3 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('trending-down')}</span>
                      Trade A (Loss)
                    </h3>
                    <div class="text-muted small" id="recovery-loss-title">--</div>
                  </div>
                  <div id="recovery-compare-loss" class="text-muted small">Select a plan to see loss details.</div>
                </div>
              </div>
            </div>
            <div class="col-xl-6">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h3 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('trending-up')}</span>
                      Trade B (Recovery)
                    </h3>
                    <div class="text-muted small" id="recovery-recovery-title">--</div>
                  </div>
                  <div id="recovery-compare-recovery" class="text-muted small">
                    Select a plan to see recovery details.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="trade-tab d-none" data-trade-panel="reentry">
          <div class="row g-3 mb-3">
            <div class="col-xl-5">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h3 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('corner-down-right')}</span>
                      Sell Loss Candidates
                    </h3>
                    <div class="text-muted small" id="reentry-candidate-count">0 trades</div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Sell</th>
                          <th>Loss</th>
                          <th class="text-end">Action</th>
                        </tr>
                      </thead>
                      <tbody id="reentry-candidates-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-xl-7">
              <div class="card shadow-sm border-0 h-100">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <h3 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('repeat')}</span>
                      Re-entry Plans
                    </h3>
                    <div class="text-muted small" id="reentry-count">0 plans</div>
                  </div>
                  <div class="table-responsive">
                    <table class="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Plan</th>
                          <th>Loss</th>
                          <th>Buyback Qty</th>
                          <th>Break-even</th>
                          <th class="text-end">Action</th>
                        </tr>
                      </thead>
                      <tbody id="reentry-body"></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card shadow-sm border-0">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <h3 class="h6 mb-0 section-title">
                  <span class="section-icon">${lucideIcon('activity')}</span>
                  Plan Analysis
                </h3>
                <div class="text-muted small" id="reentry-detail-title">Select a plan to see analysis.</div>
              </div>
              <div id="reentry-detail-body" class="text-muted small">Select a plan to see analysis.</div>
            </div>
          </div>
        </section>

        </div>

        <div class="app-modal" id="trade-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="modal"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0" id="trade-modal-title">Add Trade</h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="trade-modal-close">Close</button>
                </div>
                <div class="d-flex align-items-center gap-2 mb-3">
                  <button class="btn btn-sm btn-outline-secondary active" type="button" data-trade-tab="form">
                    Add Trade
                  </button>
                  <button class="btn btn-sm btn-outline-secondary" type="button" data-trade-tab="checklist" id="prebuy-tab-btn">
                    Pre-Buy Checklist
                  </button>
                </div>
                <form id="trade-form" class="d-flex flex-column gap-3" data-trade-tab-panel="form">
                  <input type="hidden" id="trade-id" />
                  <div class="row g-2">
                    <div class="col-md-6">
                      <label class="form-label">Symbol</label>
                      <input class="form-control" id="trade-symbol" list="nse-symbols" placeholder="Select NSE symbol" required />
                      <div class="form-text text-muted" id="trade-symbol-hint">Choose from NSE master list.</div>
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Side</label>
                      <select class="form-select" id="trade-side">
                        <option value="BUY">Buy</option>
                        <option value="SELL">Sell</option>
                      </select>
                    </div>
                  </div>
                  <div class="row g-2">
                    <div class="col-md-6">
                      <label class="form-label">Quantity</label>
                      <input class="form-control" type="number" min="1" step="1" id="trade-qty" required />
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Entry Price</label>
                      <input class="form-control" type="number" min="0" step="0.01" id="trade-price" required />
                    </div>
                  </div>
                  <div class="row g-2">
                    <div class="col-md-6">
                      <label class="form-label">Trade Date</label>
                      <input class="form-control" type="date" id="trade-date" required />
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Notes</label>
                      <input class="form-control" id="trade-notes" />
                    </div>
                  </div>
                  <div class="d-flex gap-2 justify-content-end">
                    <button class="btn btn-outline-secondary" type="button" id="trade-cancel">Cancel</button>
                    <button class="btn btn-primary" type="submit" id="trade-submit">Save Trade</button>
                  </div>
                </form>
                <div class="border rounded-3 p-3 bg-light d-none" id="prebuy-checklist" data-trade-tab-panel="checklist">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <div class="fw-semibold small">Pre-Buy Checklist</div>
                    <span class="badge text-bg-secondary" id="prebuy-badge">Review</span>
                  </div>
                  <div class="small mb-2" id="prebuy-suggestion"></div>
                  <div class="d-flex flex-wrap gap-2 mb-2" id="prebuy-chips"></div>
                  <div class="mb-2" id="prebuy-zone"></div>
                  <div class="mb-2" id="prebuy-allocation"></div>
                  <ul class="small mb-0" id="prebuy-list"></ul>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="app-modal" id="recovery-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="recovery"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0" id="recovery-modal-title">Create Recovery Plan</h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="recovery-modal-close">Close</button>
                </div>
                <div class="mb-3">
                  <label class="form-label">Plan Name</label>
                  <input class="form-control" id="recovery-plan-name" placeholder="e.g. Recovery Plan A" />
                </div>
                <div class="border rounded-3 p-3 mb-3 bg-light">
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <div class="fw-semibold">Loss Trades (A)</div>
                    <span class="badge text-bg-danger" id="recovery-loss-badge">LOSS</span>
                  </div>
                  <div class="small text-muted mb-2" id="recovery-loss-meta">--</div>
                  <div class="d-flex justify-content-between align-items-center small">
                    <div><span class="text-muted">Total Loss:</span> <span id="recovery-loss-amount">--</span></div>
                    <div><span class="text-muted">Trades:</span> <span id="recovery-loss-count">--</span></div>
                  </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mb-2">
                  <select class="form-select form-select-sm w-auto" id="recovery-loss-trade">
                    <option value="">Add from SELL trade...</option>
                  </select>
                  <button class="btn btn-sm btn-outline-primary" type="button" id="recovery-loss-add">Add Loss</button>
                </div>
                <div class="table-responsive mb-3">
                  <table class="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Qty</th>
                        <th>Sell Price</th>
                        <th>Loss</th>
                        <th class="text-end">Action</th>
                      </tr>
                    </thead>
                    <tbody id="recovery-loss-body"></tbody>
                  </table>
                </div>
                <div class="d-flex flex-wrap gap-2 mb-2">
                  <select class="form-select form-select-sm w-auto" id="recovery-leg-trade">
                    <option value="">Add from BUY trade...</option>
                  </select>
                  <button class="btn btn-sm btn-outline-primary" type="button" id="recovery-leg-add">Add Trade</button>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="recovery-leg-add-manual">Add Manual</button>
                </div>
                <div class="table-responsive mb-3">
                  <table class="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Qty</th>
                        <th>Buy Price</th>
                        <th>Invested</th>
                        <th class="text-end">Action</th>
                      </tr>
                    </thead>
                    <tbody id="recovery-legs-body"></tbody>
                  </table>
                </div>
                <div class="mb-3">
                  <label class="form-label">Notes (optional)</label>
                  <input class="form-control" id="recovery-notes" placeholder="Why this recovery plan?" />
                </div>
                <div class="d-flex gap-2 justify-content-end">
                  <button class="btn btn-outline-secondary" type="button" id="recovery-cancel">Cancel</button>
                  <button class="btn btn-primary" type="button" id="recovery-save">Save Plan</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="app-modal" id="reentry-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="reentry"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0" id="reentry-modal-title">Create Re-entry Plan</h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="reentry-modal-close">Close</button>
                </div>
                <div class="mb-3">
                  <label class="form-label">Plan Name</label>
                  <input class="form-control" id="reentry-plan-name" placeholder="e.g. Re-entry Plan A" />
                </div>
                <div class="border rounded-3 p-3 mb-3 bg-light">
                  <div class="fw-semibold mb-1">Sell Trade (Loss)</div>
                  <div class="small text-muted" id="reentry-sell-meta">--</div>
                  <div class="d-flex justify-content-between align-items-center small mt-2">
                    <div><span class="text-muted">Loss:</span> <span id="reentry-loss-amount">--</span></div>
                    <div><span class="text-muted">Qty:</span> <span id="reentry-sell-qty">--</span></div>
                  </div>
                </div>
                <div class="d-flex flex-wrap gap-2 mb-2">
                  <select class="form-select form-select-sm w-auto" id="reentry-buy-trade">
                    <option value="">Add from BUY trade...</option>
                  </select>
                  <button class="btn btn-sm btn-outline-primary" type="button" id="reentry-buy-add">Add Buyback</button>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="reentry-buy-add-manual">Add Manual</button>
                </div>
                <div class="table-responsive mb-3">
                  <table class="table table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Qty</th>
                        <th>Buy Price</th>
                        <th>Trade Date</th>
                        <th class="text-end">Action</th>
                      </tr>
                    </thead>
                    <tbody id="reentry-buys-body"></tbody>
                  </table>
                </div>
                <div class="mb-3">
                  <label class="form-label">Notes</label>
                  <input class="form-control" id="reentry-notes" placeholder="Optional note" />
                </div>
                <div class="d-flex justify-content-end gap-2">
                  <button class="btn btn-outline-secondary" type="button" id="reentry-cancel">Cancel</button>
                  <button class="btn btn-primary" type="button" id="reentry-save">Save Plan</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="app-modal" id="mapping-review-modal" aria-hidden="true">
          <div class="app-modal-backdrop" data-close="mapping-review"></div>
          <div class="app-modal-dialog">
            <div class="card shadow-lg border-0">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-3">
                  <h3 class="h6 mb-0">Mapping Review</h3>
                  <button class="btn btn-sm btn-outline-secondary" type="button" id="mapping-review-close">Close</button>
                </div>
                <div class="text-muted small mb-3">Send the correct NSE ticker so future imports map cleanly.</div>
                <div class="mb-3">
                  <label class="form-label small text-muted">Current Ticker</label>
                  <div class="fw-semibold" id="mapping-review-current">--</div>
                </div>
                <div class="mb-3">
                  <label class="form-label small text-muted">Company Name</label>
                  <div class="text-muted" id="mapping-review-company">--</div>
                </div>
                <div class="mb-3">
                  <label class="form-label">Expected NSE Ticker</label>
                  <input class="form-control" id="mapping-review-expected" placeholder="e.g. GOKULAGRO" />
                </div>
                <div class="mb-3">
                  <label class="form-label">Note (optional)</label>
                  <input class="form-control" id="mapping-review-note" placeholder="Any details" />
                </div>
                <div class="d-flex gap-2 justify-content-end">
                  <button class="btn btn-outline-secondary" type="button" id="mapping-review-cancel">Cancel</button>
                  <button class="btn btn-primary" type="button" id="mapping-review-submit">Send Review</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <datalist id="nse-symbols"></datalist>
        ${renderConfirmModal()}
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#trade-feedback');
    const tradeAdd = root.querySelector<HTMLButtonElement>('#trade-add');
    const tradeImport = root.querySelector<HTMLInputElement>('#trade-import');
    const tradeImportLabel = root.querySelector<HTMLLabelElement>('#trade-import-label');
    const tradeImportReport = root.querySelector<HTMLDivElement>('#trade-import-report');
    const kpiTotal = root.querySelector<HTMLElement>('#kpi-total');
    const kpiOpen = root.querySelector<HTMLElement>('#kpi-open');
    const kpiWinRate = root.querySelector<HTMLElement>('#kpi-winrate');
    const kpiWinMeta = root.querySelector<HTMLElement>('#kpi-winmeta');
    const kpiNet = root.querySelector<HTMLElement>('#kpi-net');
    const tradeCount = root.querySelector<HTMLElement>('#trade-count');
    const tradeTableBody = root.querySelector<HTMLTableSectionElement>('#trade-table-body');
    const tradeCardList = root.querySelector<HTMLDivElement>('#trade-card-list');
    const filterQuery = root.querySelector<HTMLInputElement>('#filter-query');
    const filterFrom = root.querySelector<HTMLInputElement>('#filter-from');
    const filterTo = root.querySelector<HTMLInputElement>('#filter-to');
    const filter30 = root.querySelector<HTMLButtonElement>('#filter-30');
    const filterClear = root.querySelector<HTMLButtonElement>('#filter-clear');
    const modal = root.querySelector<HTMLDivElement>('#trade-modal');
    const modalClose = root.querySelector<HTMLButtonElement>('#trade-modal-close');
    const modalCancel = root.querySelector<HTMLButtonElement>('#trade-cancel');
    const modalTitle = root.querySelector<HTMLElement>('#trade-modal-title');
    const tradeForm = root.querySelector<HTMLFormElement>('#trade-form');
    const tradeId = root.querySelector<HTMLInputElement>('#trade-id');
    const tradeSymbol = root.querySelector<HTMLInputElement>('#trade-symbol');
    const tradeSymbolHint = root.querySelector<HTMLElement>('#trade-symbol-hint');
    const tradeSide = root.querySelector<HTMLSelectElement>('#trade-side');
    const tradeQty = root.querySelector<HTMLInputElement>('#trade-qty');
    const tradePrice = root.querySelector<HTMLInputElement>('#trade-price');
    const tradeDate = root.querySelector<HTMLInputElement>('#trade-date');
    const tradeNotes = root.querySelector<HTMLInputElement>('#trade-notes');
    const tradeSubmit = root.querySelector<HTMLButtonElement>('#trade-submit');
    const prebuyChecklist = root.querySelector<HTMLDivElement>('#prebuy-checklist');
    const prebuyList = root.querySelector<HTMLUListElement>('#prebuy-list');
    const prebuyBadge = root.querySelector<HTMLElement>('#prebuy-badge');
    const prebuySuggestion = root.querySelector<HTMLElement>('#prebuy-suggestion');
    const prebuyChips = root.querySelector<HTMLDivElement>('#prebuy-chips');
    const prebuyZone = root.querySelector<HTMLDivElement>('#prebuy-zone');
    const prebuyAllocation = root.querySelector<HTMLDivElement>('#prebuy-allocation');
    const prebuyTabBtn = root.querySelector<HTMLButtonElement>('#prebuy-tab-btn');
    const modalTabButtons = root.querySelectorAll<HTMLButtonElement>('[data-trade-tab]');
    const modalTabPanels = root.querySelectorAll<HTMLElement>('[data-trade-tab-panel]');
    const nseDatalist = root.querySelector<HTMLDataListElement>('#nse-symbols');
    const tabPanels = root.querySelectorAll<HTMLElement>('[data-trade-panel]');
    const tickerBody = root.querySelector<HTMLTableSectionElement>('#ticker-body');
    const tickerCount = root.querySelector<HTMLElement>('#ticker-count');
    const priceRefresh = root.querySelector<HTMLButtonElement>('#price-refresh');
    const priceLastRefresh = root.querySelector<HTMLElement>('#price-last-refresh');
    const requestBody = root.querySelector<HTMLTableSectionElement>('#request-body');
    const requestCount = root.querySelector<HTMLElement>('#request-count');
    const requestSymbol = root.querySelector<HTMLInputElement>('#ticker-request-symbol');
    const requestNote = root.querySelector<HTMLInputElement>('#ticker-request-note');
    const requestSubmit = root.querySelector<HTMLButtonElement>('#ticker-request-submit');
    const recoverySummaryUpdated = root.querySelector<HTMLElement>('#recovery-summary-updated');
    const recoveryActive = root.querySelector<HTMLElement>('#recovery-active');
    const recoveryRecovered = root.querySelector<HTMLElement>('#recovery-recovered');
    const recoveryWin = root.querySelector<HTMLElement>('#recovery-win');
    const recoveryNet = root.querySelector<HTMLElement>('#recovery-net');
    const recoveryCount = root.querySelector<HTMLElement>('#recovery-count');
    const recoveryBody = root.querySelector<HTMLTableSectionElement>('#recovery-body');
    const recoveryTrendCanvas = root.querySelector<HTMLCanvasElement>('#recovery-trend-chart');
    const recoveryTrendEmpty = root.querySelector<HTMLDivElement>('#recovery-trend-empty');
    const recoveryPlanTitle = root.querySelector<HTMLInputElement>('#recovery-plan-title');
    const recoveryPlanTitleSave = root.querySelector<HTMLButtonElement>('#recovery-plan-title-save');
    const recoveryPenButtons = root.querySelectorAll<HTMLButtonElement>('[data-recovery-pen]');
    const recoveryViewButtons = root.querySelectorAll<HTMLButtonElement>('[data-recovery-view]');
    const recoveryRangeButtons = root.querySelectorAll<HTMLButtonElement>('[data-recovery-range]');
    const recoveryTrendLossDate = root.querySelector<HTMLElement>('#recovery-trend-loss-date');
    const recoveryTrendRecoveryDate = root.querySelector<HTMLElement>('#recovery-trend-recovery-date');
    const recoveryLossTitle = root.querySelector<HTMLElement>('#recovery-loss-title');
    const recoveryRecoveryTitle = root.querySelector<HTMLElement>('#recovery-recovery-title');
    const recoveryCompareLoss = root.querySelector<HTMLDivElement>('#recovery-compare-loss');
    const recoveryCompareRecovery = root.querySelector<HTMLDivElement>('#recovery-compare-recovery');
    const recoveryModal = root.querySelector<HTMLDivElement>('#recovery-modal');
    const recoveryModalTitle = root.querySelector<HTMLElement>('#recovery-modal-title');
    const recoveryModalClose = root.querySelector<HTMLButtonElement>('#recovery-modal-close');
    const recoveryCancel = root.querySelector<HTMLButtonElement>('#recovery-cancel');
    const recoverySave = root.querySelector<HTMLButtonElement>('#recovery-save');
    const recoveryPlanName = root.querySelector<HTMLInputElement>('#recovery-plan-name');
    const recoveryLegTrade = root.querySelector<HTMLSelectElement>('#recovery-leg-trade');
    const recoveryLegAdd = root.querySelector<HTMLButtonElement>('#recovery-leg-add');
    const recoveryLegAddManual = root.querySelector<HTMLButtonElement>('#recovery-leg-add-manual');
    const recoveryLegsBody = root.querySelector<HTMLTableSectionElement>('#recovery-legs-body');
    const recoveryNotes = root.querySelector<HTMLInputElement>('#recovery-notes');
    const recoveryLossMeta = root.querySelector<HTMLElement>('#recovery-loss-meta');
    const recoveryLossCount = root.querySelector<HTMLElement>('#recovery-loss-count');
    const recoveryLossAmount = root.querySelector<HTMLElement>('#recovery-loss-amount');
    const recoveryLossTrade = root.querySelector<HTMLSelectElement>('#recovery-loss-trade');
    const recoveryLossAdd = root.querySelector<HTMLButtonElement>('#recovery-loss-add');
    const recoveryLossBody = root.querySelector<HTMLTableSectionElement>('#recovery-loss-body');
    const reentryCandidateCount = root.querySelector<HTMLElement>('#reentry-candidate-count');
    const reentryCandidatesBody = root.querySelector<HTMLTableSectionElement>('#reentry-candidates-body');
    const reentryCount = root.querySelector<HTMLElement>('#reentry-count');
    const reentryBody = root.querySelector<HTMLTableSectionElement>('#reentry-body');
    const reentryDetailTitle = root.querySelector<HTMLElement>('#reentry-detail-title');
    const reentryDetailBody = root.querySelector<HTMLDivElement>('#reentry-detail-body');
    const reentryModal = root.querySelector<HTMLDivElement>('#reentry-modal');
    const reentryModalTitle = root.querySelector<HTMLElement>('#reentry-modal-title');
    const reentryModalClose = root.querySelector<HTMLButtonElement>('#reentry-modal-close');
    const reentryCancel = root.querySelector<HTMLButtonElement>('#reentry-cancel');
    const reentrySave = root.querySelector<HTMLButtonElement>('#reentry-save');
    const reentryPlanName = root.querySelector<HTMLInputElement>('#reentry-plan-name');
    const reentrySellMeta = root.querySelector<HTMLElement>('#reentry-sell-meta');
    const reentryLossAmount = root.querySelector<HTMLElement>('#reentry-loss-amount');
    const reentrySellQty = root.querySelector<HTMLElement>('#reentry-sell-qty');
    const reentryBuyTrade = root.querySelector<HTMLSelectElement>('#reentry-buy-trade');
    const reentryBuyAdd = root.querySelector<HTMLButtonElement>('#reentry-buy-add');
    const reentryBuyAddManual = root.querySelector<HTMLButtonElement>('#reentry-buy-add-manual');
    const reentryBuysBody = root.querySelector<HTMLTableSectionElement>('#reentry-buys-body');
    const reentryNotes = root.querySelector<HTMLInputElement>('#reentry-notes');
    const mappingReviewModal = root.querySelector<HTMLDivElement>('#mapping-review-modal');
    const mappingReviewClose = root.querySelector<HTMLButtonElement>('#mapping-review-close');
    const mappingReviewCancel = root.querySelector<HTMLButtonElement>('#mapping-review-cancel');
    const mappingReviewSubmit = root.querySelector<HTMLButtonElement>('#mapping-review-submit');
    const mappingReviewCurrent = root.querySelector<HTMLElement>('#mapping-review-current');
    const mappingReviewCompany = root.querySelector<HTMLElement>('#mapping-review-company');
    const mappingReviewExpected = root.querySelector<HTMLInputElement>('#mapping-review-expected');
    const mappingReviewNote = root.querySelector<HTMLInputElement>('#mapping-review-note');
    const confirmAction = bindConfirmModal(root);

    if (
      !feedback ||
      !tradeAdd ||
      !tradeImport ||
      !tradeImportLabel ||
      !tradeImportReport ||
      !kpiTotal ||
      !kpiOpen ||
      !kpiWinRate ||
      !kpiWinMeta ||
      !kpiNet ||
      !tradeCount ||
      !tradeTableBody ||
      !tradeCardList ||
      !filterQuery ||
      !filterFrom ||
      !filterTo ||
      !filter30 ||
      !filterClear ||
      !modal ||
      !modalClose ||
      !modalCancel ||
      !modalTitle ||
      !tradeForm ||
      !tradeId ||
      !tradeSymbol ||
      !tradeSymbolHint ||
      !tradeSide ||
      !tradeQty ||
      !tradePrice ||
      !tradeDate ||
      !tradeNotes ||
      !tradeSubmit ||
      !prebuyChecklist ||
      !prebuyList ||
      !prebuyBadge ||
      !prebuySuggestion ||
      !prebuyChips ||
      !prebuyZone ||
      !prebuyAllocation ||
      !prebuyTabBtn ||
      !nseDatalist ||
      !tickerBody ||
      !tickerCount ||
      !priceRefresh ||
      !priceLastRefresh ||
      !requestBody ||
      !requestCount ||
      !requestSymbol ||
      !requestNote ||
      !requestSubmit ||
      !recoverySummaryUpdated ||
      !recoveryActive ||
      !recoveryRecovered ||
      !recoveryWin ||
      !recoveryNet ||
      !recoveryCount ||
      !recoveryBody ||
      !recoveryTrendCanvas ||
      !recoveryTrendEmpty ||
      !recoveryPlanTitle ||
      !recoveryPlanTitleSave ||
      !recoveryPenButtons.length ||
      !recoveryViewButtons.length ||
      !recoveryRangeButtons.length ||
      !recoveryTrendLossDate ||
      !recoveryTrendRecoveryDate ||
      !recoveryLossTitle ||
      !recoveryRecoveryTitle ||
      !recoveryCompareLoss ||
      !recoveryCompareRecovery ||
      !recoveryModal ||
      !recoveryModalTitle ||
      !recoveryModalClose ||
      !recoveryCancel ||
      !recoverySave ||
      !recoveryPlanName ||
      !recoveryLegTrade ||
      !recoveryLegAdd ||
      !recoveryLegAddManual ||
      !recoveryLegsBody ||
      !recoveryNotes ||
      !recoveryLossMeta ||
      !recoveryLossCount ||
      !recoveryLossAmount ||
      !recoveryLossTrade ||
      !recoveryLossAdd ||
      !recoveryLossBody ||
      !reentryCandidateCount ||
      !reentryCandidatesBody ||
      !reentryCount ||
      !reentryBody ||
      !reentryDetailTitle ||
      !reentryDetailBody ||
      !reentryModal ||
      !reentryModalTitle ||
      !reentryModalClose ||
      !reentryCancel ||
      !reentrySave ||
      !reentryPlanName ||
      !reentrySellMeta ||
      !reentryLossAmount ||
      !reentrySellQty ||
      !reentryBuyTrade ||
      !reentryBuyAdd ||
      !reentryBuyAddManual ||
      !reentryBuysBody ||
      !reentryNotes ||
      !mappingReviewModal ||
      !mappingReviewClose ||
      !mappingReviewCancel ||
      !mappingReviewSubmit ||
      !mappingReviewCurrent ||
      !mappingReviewCompany ||
      !mappingReviewExpected ||
      !mappingReviewNote
    ) {
      throw new Error('Trades view failed to initialize');
    }

    let trades: TradeRecord[] = [];
    let filters: TradeFilters = { query: '', from: '', to: '' };
    let nseSymbols = new Set<string>();
    let nseMasterRows: NseRow[] = [];
    let tickerRequests: TickerRequest[] = [];
    let tickerRows: TickerSummary[] = [];
    let recoveryPlans: RecoveryPlan[] = [];
    let recoveryRows: RecoveryPlanSummary[] = [];
    let linkedLossTradeIds = new Set<string>();
    let reentryPlans: ReentryPlan[] = [];
    let reentryRows: ReentryPlanSummary[] = [];
    let linkedReentrySellIds = new Set<string>();
    let recoveryTrendChart: ChartJS | null = null;
    let recoveryRange: '7d' | '1m' | '3m' | '6m' | 'all' = 'all';
    let recoveryView: 'index' | 'return' | 'ltp' = loadRecoveryViewState();
    let recoveryPenState: Record<'lossTarget' | 'recovered' | 'breakEven' | 'tradeALtp' | 'tradeBLtp', boolean> =
      loadRecoveryPenState();
    let priceHistoryCache = new Map<string, PriceHistoryPoint[]>();
    let trendRequestId = 0;
    let activeRecoveryPlanId: string | null = null;
    let activeReentryPlanId: string | null = null;
    let importConfidence = loadImportConfidence();
    let userSettings = await getUserSettings(session.userId);
    let recoveryDraft: {
      planId?: string;
      lossTrades: RecoveryLossLeg[];
      legs: RecoveryLeg[];
    } = { legs: [], lossTrades: [] };
    let reentryDraft: {
      planId?: string;
      sellTrade?: TradeRecord;
      lossAmount?: number;
      buybacks: ReentryBuyLeg[];
    } = { buybacks: [] };
    let recoveryDraftLossAmount = 0;
    let recoveryDraftHoldDays: number | null = null;
    let tickerSort: { key: 'ticker' | 'ltp' | 'chg' | 'last'; dir: 'asc' | 'desc' } = {
      key: 'ticker',
      dir: 'asc'
    };

    const queueAndSync = async () => {
      await queueSnapshot(session.userId);
    };

    const setTab = (name: string) => {
      tabPanels.forEach((panel) => {
        panel.classList.toggle('d-none', panel.dataset.tradePanel !== name);
      });
    };

    const updateQuickNavActive = (name: string) => {
      root.querySelectorAll<HTMLElement>('[data-quick-id]').forEach((btn) => {
        const quickId = btn.dataset.quickId || '';
        const isMobilePrimary = btn.classList.contains('mobile-primary-nav-item');
        const mobileActive = ['list', 'request', 'history'].includes(name) ? 'trades' : name;
        btn.classList.toggle('active', isMobilePrimary ? quickId === mobileActive : quickId === name);
      });
    };

    const renderSymbolOptions = () => {
      const options = nseMasterRows
        .map((row) => {
          const symbol = normalizeSymbol(row.symbol);
          if (!symbol) return '';
          const label = row.name ? `${symbol} - ${row.name}` : symbol;
          return `<option value="${symbol}">${label}</option>`;
        })
        .join('');
      nseDatalist.innerHTML = options;
    };

    const updateSymbolHint = () => {
      const symbol = normalizeSymbol(tradeSymbol.value);
      if (!symbol) {
        tradeSymbolHint.textContent = 'Choose from NSE master list.';
        return;
      }
      const match = nseMasterRows.find((row) => normalizeSymbol(row.symbol) === symbol);
      tradeSymbolHint.textContent = match?.name ? match.name : 'Symbol not found in NSE master.';
    };

    const updatePreBuyChecklist = () => {
      if (tradeSide.value !== 'BUY') {
        prebuyList.innerHTML = '<li class="text-muted">Pre-buy checklist is available only for BUY trades.</li>';
        prebuyBadge.textContent = 'N/A';
        prebuyBadge.className = 'badge text-bg-secondary';
        prebuySuggestion.textContent = 'Suggestion: Not applicable for SELL trades.';
        prebuySuggestion.className = 'text-muted';
        prebuyChips.innerHTML = '';
        prebuyZone.innerHTML = '';
        prebuyAllocation.innerHTML = '';
        return;
      }

      const symbol = normalizeSymbol(tradeSymbol.value);
      const qty = Number(tradeQty.value);
      const price = Number(tradePrice.value);
      const items: Array<{ text: string; tone: 'ok' | 'warn' | 'muted' }> = [];
      let warnings = 0;
      let allocationExceeded = false;
      let zoneStatus: 'BELOW_L1' | 'L1' | 'OUT' | 'ABOVE' | 'NA' = 'NA';
      let expectedBelowBaseline = false;
      let belowL1 = false;
      let aboveAvg = false;

      if (!symbol) {
        items.push({ text: 'Select a symbol from NSE master.', tone: 'muted' });
      }

      const cycle = symbol ? computeCurrentCycleState(symbol, trades, tradeId.value || undefined) : null;
      const qtyBefore = cycle?.qty ?? 0;
      const avgBefore = cycle?.avg ?? null;
      const costBefore = cycle?.cost ?? 0;
      const startDate = cycle?.startDate ?? null;

      if (qtyBefore <= 0 && symbol) {
        items.push({ text: 'First buy: no open cycle found for this symbol.', tone: 'ok' });
      }

      const buyQty = Number.isFinite(qty) ? qty : 0;
      const buyCost = Number.isFinite(price) ? buyQty * price : 0;
      const newQty = qtyBefore + buyQty;
      const newCost = costBefore + buyCost;
      const newAvg = newQty > 0 ? newCost / newQty : null;

      const amountAfterBuy = Number.isFinite(newCost) ? newCost : null;
      if (userSettings.totalInvestment > 0 && userSettings.maxAllocationPct > 0 && amountAfterBuy !== null) {
        const limit = (userSettings.totalInvestment * userSettings.maxAllocationPct) / 100;
        if (amountAfterBuy > limit) {
          warnings += 1;
          allocationExceeded = true;
          items.push({
            text: `Allocation after buy exceeds limit: ${formatMoney(amountAfterBuy)} > ${formatMoney(limit)}.`,
            tone: 'warn'
          });
        } else {
          items.push({
            text: `Allocation after buy within limit: ${formatMoney(amountAfterBuy)} of ${formatMoney(limit)}.`,
            tone: 'ok'
          });
        }
      } else {
        items.push({ text: 'Set Total Investment and Max Allocation in Settings for allocation checks.', tone: 'muted' });
      }

      if (avgBefore !== null) {
        items.push({ text: `Current cycle avg (before buy): ${formatMoney(avgBefore)}.`, tone: 'ok' });
      }
      if (newAvg !== null && Number.isFinite(newAvg)) {
        items.push({ text: `New avg after buy: ${formatMoney(newAvg)}.`, tone: 'ok' });
      }
      if (newQty > 0) {
        items.push({ text: `Total qty after buy: ${newQty}.`, tone: 'ok' });
      }
      if (Number.isFinite(newCost) && newCost > 0) {
        items.push({ text: `Total invested after buy: ${formatMoney(newCost)}.`, tone: 'ok' });
      }

      if (avgBefore && Number.isFinite(price) && price > 0) {
        const diffPct = ((price - avgBefore) / avgBefore) * 100;
        const dropPct = Math.abs(diffPct);
        const isCheaper = diffPct < 0;
        if (userSettings.l1ZonePct > 0 && userSettings.l2ZonePct > 0) {
          if (isCheaper) {
            if (dropPct < userSettings.l1ZonePct) {
              zoneStatus = 'BELOW_L1';
              belowL1 = true;
              warnings += 1;
              items.push({
                text: `Entry vs avg: ${diffPct.toFixed(2)}% (Below L1 - wait for ≥${userSettings.l1ZonePct}%).`,
                tone: 'warn'
              });
            } else if (dropPct <= userSettings.l2ZonePct) {
              zoneStatus = 'L1';
              items.push({
                text: `Entry vs avg: ${diffPct.toFixed(2)}% (Meets L1 threshold).`,
                tone: 'ok'
              });
            } else {
              zoneStatus = 'OUT';
              items.push({
                text: `Entry vs avg: ${diffPct.toFixed(2)}% (Beyond L2 - deep discount).`,
                tone: 'ok'
              });
            }
          } else {
            zoneStatus = 'ABOVE';
            aboveAvg = true;
            warnings += 1;
            items.push({
              text: `Entry vs avg: ${diffPct.toFixed(2)}% (Above avg).`,
              tone: 'warn'
            });
          }
        } else {
          items.push({
            text: `Entry vs avg: ${diffPct.toFixed(2)}%. Set L1/L2 in Settings for zone checks.`,
            tone: 'muted'
          });
        }

        if (isCheaper) {
          items.push({
            text: `Dropped by ${dropPct.toFixed(2)}% vs avg price.`,
            tone: belowL1 ? 'warn' : 'ok'
          });
        } else {
          items.push({ text: `Price above avg by ${dropPct.toFixed(2)}%.`, tone: 'warn' });
          warnings += 1;
        }
      }

      if (userSettings.expectedReturnPct || userSettings.inflationPct || userSettings.fdReturnPct) {
        const floor = Math.max(userSettings.inflationPct, userSettings.fdReturnPct);
        if (userSettings.expectedReturnPct && floor && userSettings.expectedReturnPct < floor) {
          warnings += 1;
          expectedBelowBaseline = true;
          items.push({
            text: `Expected return ${userSettings.expectedReturnPct}% is below inflation/FD (${floor}%).`,
            tone: 'warn'
          });
        } else if (userSettings.expectedReturnPct) {
          items.push({
            text: `Expected return ${userSettings.expectedReturnPct}% above inflation/FD baseline.`,
            tone: 'ok'
          });
        }
      }

      const effectiveStart = startDate || tradeDate.value || new Date().toISOString().slice(0, 10);
      if (effectiveStart) {
        const start = new Date(effectiveStart);
        const end = new Date(tradeDate.value || new Date().toISOString().slice(0, 10));
        const diff = Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
        items.push({ text: `Hold days (current cycle): ${diff} days.`, tone: 'ok' });
      }

      prebuyList.innerHTML = items
        .map((item) => {
          const color =
            item.tone === 'ok' ? 'text-success' : item.tone === 'warn' ? 'text-warning' : 'text-muted';
          return `<li class="${color}">${item.text}</li>`;
        })
        .join('');
      prebuyBadge.textContent = warnings ? 'Review' : 'OK';
      prebuyBadge.className = `badge ${warnings ? 'text-bg-warning' : 'text-bg-success'}`;

      let suggestion = 'Suggestion: Looks good.';
      let suggestionClass = 'text-success';
      if (!symbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
        suggestion = 'Suggestion: Complete the trade details to evaluate.';
        suggestionClass = 'text-muted';
      } else if (allocationExceeded) {
        suggestion = 'Suggestion: Not a good buy — exceeds allocation limit after this buy.';
        suggestionClass = 'text-danger';
      } else if (expectedBelowBaseline) {
        suggestion = 'Suggestion: Caution — review allocation, zone position, and expected return.';
        suggestionClass = 'text-warning';
      } else if (aboveAvg) {
        suggestion = 'Suggestion: Caution — price is above your current avg.';
        suggestionClass = 'text-warning';
      } else if (belowL1) {
        suggestion = `Suggestion: Wait — drop is below L1. Aim for ≥${userSettings.l1ZonePct}% below avg.`;
        suggestionClass = 'text-warning';
      } else if (zoneStatus === 'L1') {
        suggestion = 'Suggestion: Good entry — meets L1 drop threshold.';
        suggestionClass = 'text-success';
      } else if (zoneStatus === 'OUT') {
        suggestion = 'Suggestion: Strong entry — deep discount beyond L2.';
        suggestionClass = 'text-success';
      } else if (zoneStatus === 'NA') {
        suggestion = 'Suggestion: Set L1/L2 zones in Settings for zone guidance.';
        suggestionClass = 'text-muted';
      }
      prebuySuggestion.textContent = suggestion;
      prebuySuggestion.className = suggestionClass;

      const chipItems: string[] = [];
      if (avgBefore !== null) {
        chipItems.push(`<span class="badge rounded-pill text-bg-light border">Avg (before): ${formatMoney(avgBefore)}</span>`);
      }
      if (newAvg !== null && Number.isFinite(newAvg)) {
        chipItems.push(`<span class="badge rounded-pill text-bg-light border">Avg (after): ${formatMoney(newAvg)}</span>`);
      }
      if (newQty > 0) {
        chipItems.push(`<span class="badge rounded-pill text-bg-light border">Qty after: ${newQty}</span>`);
      }
      if (Number.isFinite(newCost) && newCost > 0) {
        chipItems.push(`<span class="badge rounded-pill text-bg-light border">Invested: ${formatMoney(newCost)}</span>`);
      }
      if (qtyBefore <= 0 && symbol) {
        chipItems.push(`<span class="badge rounded-pill text-bg-success">First Buy</span>`);
      }
      prebuyChips.innerHTML = chipItems.join('');

      if (avgBefore && Number.isFinite(price) && price > 0 && userSettings.l1ZonePct > 0 && userSettings.l2ZonePct > 0) {
        const diffPct = ((price - avgBefore) / avgBefore) * 100;
        const absDiff = Math.abs(diffPct);
        const maxPct = Math.max(userSettings.l2ZonePct * 1.5, absDiff * 1.2, 1);
        const dotPct = Math.min(100, Math.max(0, (absDiff / maxPct) * 100));
        const l1Pos = Math.min(100, (userSettings.l1ZonePct / maxPct) * 100);
        const l2Pos = Math.min(100, (userSettings.l2ZonePct / maxPct) * 100);
        const dotColor =
          zoneStatus === 'L1' || zoneStatus === 'OUT'
            ? 'bg-success'
            : zoneStatus === 'BELOW_L1'
              ? 'bg-warning'
              : zoneStatus === 'ABOVE'
                ? 'bg-danger'
                : 'bg-info';
        prebuyZone.innerHTML = `
          <div class="small text-muted mb-1">L1/L2 Zone</div>
          <div class="prebuy-zone-bar">
            <span class="prebuy-zone-marker" style="left:${l1Pos}%"></span>
            <span class="prebuy-zone-marker" style="left:${l2Pos}%"></span>
            <span class="prebuy-zone-dot ${dotColor}" style="left:${dotPct}%"></span>
          </div>
        `;
      } else {
        prebuyZone.innerHTML = '';
      }

      if (userSettings.totalInvestment > 0 && userSettings.maxAllocationPct > 0 && amountAfterBuy !== null) {
        const limit = (userSettings.totalInvestment * userSettings.maxAllocationPct) / 100;
        const pctUsedRaw = limit > 0 ? (amountAfterBuy / limit) * 100 : 0;
        const pctUsed = Math.min(100, Math.max(0, pctUsedRaw));
        const barClass = allocationExceeded ? 'bg-danger' : 'bg-success';
        const label = allocationExceeded ? `Over by ${(pctUsedRaw - 100).toFixed(1)}%` : `${pctUsedRaw.toFixed(1)}% used`;
        prebuyAllocation.innerHTML = `
          <div class="small text-muted mb-1">Allocation Used (after buy)</div>
          <div class="progress" style="height: 8px;">
            <div class="progress-bar ${barClass}" role="progressbar" style="width:${pctUsed}%"></div>
          </div>
          <div class="small ${allocationExceeded ? 'text-danger' : 'text-muted'} mt-1">${label}</div>
        `;
      } else {
        prebuyAllocation.innerHTML = '';
      }
    };

    const computeLossSnapshot = (trade: TradeRecord) => {
      if (trade.side !== 'SELL') return { lossAmount: 0, avgCost: null, holdDays: null };
      const symbol = normalizeSymbol(trade.symbol);
      if (!symbol) return { lossAmount: 0, avgCost: null, holdDays: null };
      const relevant = trades
        .filter((item) => normalizeSymbol(item.symbol) === symbol)
        .sort((a, b) => {
          if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
          return a.createdAt.localeCompare(b.createdAt);
        });

      const lots: Array<{ qty: number; price: number; date: string | null }> = [];
      const consumeLots = (remaining: number) => {
        for (let i = 0; i < lots.length && remaining > 0; i += 1) {
          const lot = lots[i];
          if (lot.qty > remaining) {
            lot.qty -= remaining;
            remaining = 0;
          } else {
            remaining -= lot.qty;
            lots.splice(i, 1);
            i -= 1;
          }
        }
      };

      for (const item of relevant) {
        if (item.id === trade.id) {
          const totalQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
          const totalCost = lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
          const avgCost = totalQty > 0 ? totalCost / totalQty : null;
          const lossAmount =
            avgCost !== null ? Math.max(0, (avgCost - Number(trade.price)) * Number(trade.quantity)) : 0;
          let holdDays: number | null = null;
          if (lots.length && trade.tradeDate) {
            const start = lots[0].date ? new Date(lots[0].date) : null;
            const end = trade.tradeDate ? new Date(trade.tradeDate) : null;
            if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
              holdDays = Math.max(0, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
            }
          }
          return { lossAmount, avgCost, holdDays };
        }

        if (item.side === 'BUY') {
          lots.push({ qty: item.quantity, price: item.price, date: item.tradeDate || null });
        } else if (item.side === 'SELL') {
          consumeLots(item.quantity);
        }
      }
      return { lossAmount: 0, avgCost: null, holdDays: null };
    };

    const getLossTradeForPlan = (plan: RecoveryPlan): TradeRecord => {
      const lossTrades = normalizeLossTrades(plan);
      const primary = lossTrades[0];
      const tradeId = primary?.tradeId || plan.lossTradeId;
      const existing = tradeId ? trades.find((trade) => trade.id === tradeId) : undefined;
      if (existing) return existing;
      return {
        id: tradeId || crypto.randomUUID(),
        userId: session.userId,
        symbol: primary?.symbol || plan.lossSymbol,
        side: 'SELL',
        quantity: primary?.quantity || plan.lossQuantity,
        price: primary?.sellPrice || plan.lossSellPrice,
        tradeDate: primary?.tradeDate || plan.lossTradeDate,
        notes: '',
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt
      };
    };

    const normalizeLossTrades = (plan: RecoveryPlan): RecoveryLossLeg[] => {
      if (plan.lossTrades && plan.lossTrades.length) {
        return plan.lossTrades.map((leg) => ({ ...leg }));
      }
      return [
        {
          id: plan.lossTradeId || crypto.randomUUID(),
          tradeId: plan.lossTradeId,
          symbol: plan.lossSymbol,
          quantity: plan.lossQuantity,
          sellPrice: plan.lossSellPrice,
          lossAmount: plan.lossAmount,
          tradeDate: plan.lossTradeDate,
          holdDays: plan.lossHoldDays ?? null,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt
        }
      ];
    };

    const buildLinkedLossTradeIds = (plans: RecoveryPlan[]): Set<string> => {
      const ids = new Set<string>();
      plans.forEach((plan) => {
        const lossTrades = normalizeLossTrades(plan);
        lossTrades.forEach((leg) => {
          if (leg.tradeId) {
            ids.add(leg.tradeId);
          }
        });
      });
      return ids;
    };

    const buildRecoverySummaries = (
      plans: RecoveryPlan[],
      priceMap: Map<string, { price?: number | string }>
    ): RecoveryPlanSummary[] =>
      plans.map((plan) => {
        const lossTrades = normalizeLossTrades(plan);
        const totalLoss = lossTrades.reduce((sum, leg) => sum + (leg.lossAmount || 0), 0);
        const legs = plan.recoveryTrades.map((leg) => {
          const live = priceMap.get(normalizeSymbol(leg.symbol))?.price;
          const livePrice = coerceNumber(live);
          const invested = leg.investedAmount || leg.quantity * leg.buyPrice;
          const currentValue = livePrice !== null ? livePrice * leg.quantity : 0;
          const pnl = currentValue - invested;
          const pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
          return {
            ...leg,
            livePrice,
            currentValue,
            pnl,
            pnlPct
          };
        });
        const recoveredAmount = legs.reduce((sum, leg) => sum + (leg.pnl || 0), 0);
        const remainingAmount = totalLoss - recoveredAmount;
        const recoveryPct = totalLoss > 0 ? (recoveredAmount / totalLoss) * 100 : null;
        const isRecovered = totalLoss > 0 ? recoveredAmount >= totalLoss : false;
        return {
          ...plan,
          lossTrades,
          lossAmount: totalLoss,
          legs,
          recoveredAmount,
          remainingAmount,
          recoveryPct,
          isRecovered
        };
      });

    const getRecoveryPlanLabel = (plan: RecoveryPlan, lossTrades: RecoveryLossLeg[]): string => {
      const trimmed = plan.name ? plan.name.trim() : '';
      if (trimmed) return trimmed;
      if (lossTrades.length) {
        return lossTrades.length === 1
          ? lossTrades[0].symbol
          : `${lossTrades[0].symbol} +${lossTrades.length - 1}`;
      }
      return plan.lossSymbol || 'Recovery plan';
    };

    const buildLinkedReentrySellIds = (plans: ReentryPlan[]): Set<string> => {
      const ids = new Set<string>();
      plans.forEach((plan) => {
        if (plan.sellTradeId) {
          ids.add(plan.sellTradeId);
        }
      });
      return ids;
    };

    const buildReentrySummaries = (plans: ReentryPlan[], targetPct: number): ReentryPlanSummary[] =>
      plans.map((plan) => {
        const buybackQty = plan.buybackTrades.reduce((sum, leg) => sum + leg.quantity, 0);
        const buybackInvested = plan.buybackTrades.reduce(
          (sum, leg) => sum + (leg.investedAmount || leg.quantity * leg.buyPrice),
          0
        );
        const buybackAvg = buybackQty > 0 ? buybackInvested / buybackQty : null;
        const lossPerShare = plan.sellQuantity > 0 ? plan.lossAmount / plan.sellQuantity : null;
        const allocatedLoss = lossPerShare !== null ? lossPerShare * buybackQty : 0;
        const reentryGain = buybackAvg !== null ? (plan.sellPrice - buybackAvg) * buybackQty : 0;
        const remainingLoss = Math.max(0, allocatedLoss - reentryGain);
        const breakEvenLtp = buybackAvg !== null && lossPerShare !== null ? buybackAvg + lossPerShare : null;
        const targetLtp =
          buybackAvg !== null && lossPerShare !== null
            ? buybackAvg + lossPerShare + (plan.sellPrice * (targetPct || 0)) / 100
            : null;
        return {
          ...plan,
          buybackQty,
          buybackInvested,
          buybackAvg,
          lossPerShare,
          allocatedLoss,
          reentryGain,
          remainingLoss,
          breakEvenLtp,
          targetLtp
        };
      });

    const getReentryPlanLabel = (plan: ReentryPlan): string => {
      const trimmed = plan.name ? plan.name.trim() : '';
      if (trimmed) return trimmed;
      return plan.symbol ? `${plan.symbol} Re-entry` : 'Re-entry plan';
    };

    const recoveryRangeOptions: Record<string, { label: string; days: number | null }> = {
      '7d': { label: '1W', days: 7 },
      '1m': { label: '1M', days: 30 },
      '3m': { label: '3M', days: 90 },
      '6m': { label: '6M', days: 180 },
      all: { label: 'All', days: null }
    };

    const RECOVERY_PEN_KEY = 'recovery_trend_pens_v1';
    const RECOVERY_VIEW_KEY = 'recovery_trend_view_v1';

    function loadRecoveryPenState(): Record<'lossTarget' | 'recovered' | 'breakEven' | 'tradeALtp' | 'tradeBLtp', boolean> {
      try {
        const raw = localStorage.getItem(RECOVERY_PEN_KEY);
        const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
        return {
          lossTarget: parsed?.lossTarget !== false,
          recovered: parsed?.recovered !== false,
          breakEven: parsed?.breakEven !== false,
          tradeALtp: parsed?.tradeALtp !== false,
          tradeBLtp: parsed?.tradeBLtp !== false
        };
      } catch {
        return {
          lossTarget: true,
          recovered: true,
          breakEven: true,
          tradeALtp: true,
          tradeBLtp: true
        };
      }
    }

    function saveRecoveryPenState(state: typeof recoveryPenState): void {
      try {
        localStorage.setItem(RECOVERY_PEN_KEY, JSON.stringify(state));
      } catch {
        return;
      }
    }

    function loadRecoveryViewState(): 'index' | 'return' | 'ltp' {
      try {
        const raw = localStorage.getItem(RECOVERY_VIEW_KEY);
        if (raw === 'return' || raw === 'ltp' || raw === 'index') return raw;
        return 'index';
      } catch {
        return 'index';
      }
    }

    function saveRecoveryViewState(value: typeof recoveryView): void {
      try {
        localStorage.setItem(RECOVERY_VIEW_KEY, value);
      } catch {
        return;
      }
    }

    const resolveImportedSymbol = (rawSymbol: string, companyName?: string): ImportSymbolResolution => {
      const normalized = normalizeSymbol(rawSymbol);
      const isNumeric = normalized ? /^\d+$/.test(normalized) : false;
      const nameHint =
        companyName?.trim() || (String(rawSymbol || '').includes(' ') ? String(rawSymbol || '').trim() : '');
      if (!normalized && !nameHint) return { symbol: '', mapped: false, reason: 'Missing symbol' };
      const overrideSymbol = getOverrideSymbol(nameHint || '', normalized);
      if (overrideSymbol) {
        return {
          symbol: overrideSymbol,
          mapped: true,
          score: 100,
          confidence: 'HIGH',
          method: 'override'
        };
      }
      if (!isNumeric && normalized && nseSymbols.has(normalized)) {
        return { symbol: normalized, mapped: false, score: 100, confidence: 'HIGH', method: 'symbol' };
      }
      if (!isNumeric && normalized) {
        const stripped = stripSeriesSuffix(normalized);
        if (stripped !== normalized && nseSymbols.has(stripped)) {
          return { symbol: stripped, mapped: true, score: 95, confidence: 'HIGH', method: 'stripSeries' };
        }
      }

      const candidates: Array<{
        symbol: string;
        initials: string;
        normName: string;
        tokens: string[];
        tokenAcronym: string;
      }> = nseMasterRows.map((row) => {
        const tokens = normalizeCompanyTokens(row.name || '');
        return {
          symbol: normalizeSymbol(row.symbol),
          initials: nameInitials(row.name || ''),
          normName: normalizeName(row.name || ''),
          tokens,
          tokenAcronym: companyAcronym(tokens)
        };
      });

      const scoreCandidate = (nameValue: string, candidate: (typeof candidates)[number]) => {
        const normalizedName = normalizeName(nameValue);
        if (!normalizedName) return { score: 0, coverage: 0, fullMatch: false };
        if (candidate.normName === normalizedName) return { score: 100, coverage: 1, fullMatch: true };
        let score = 0;
        if (candidate.normName.startsWith(normalizedName) || normalizedName.startsWith(candidate.normName)) {
          score = Math.max(score, 90);
        }
        const tokens = normalizeCompanyTokens(nameValue);
        const tokenMatches = tokens.filter((token) => candidate.tokens.includes(token));
        const ratio = tokens.length ? tokenMatches.length / tokens.length : 0;
        const fullMatch = tokens.length > 0 && tokenMatches.length === tokens.length;
        if (tokens.length) {
          if (ratio >= 0.95) score = Math.max(score, 95);
          else if (ratio >= 0.8) score = Math.max(score, 88);
          else if (ratio >= 0.6) score = Math.max(score, 78);
          else if (ratio >= 0.4) score = Math.max(score, 68);
        }
        const acronym = companyAcronym(tokens);
        if (acronym && candidate.symbol === acronym) score = Math.max(score, 96);
        if (candidate.tokenAcronym && candidate.symbol === candidate.tokenAcronym) score = Math.max(score, 92);
        if (normalizedName.length >= 5 && candidate.normName.includes(normalizedName)) score = Math.max(score, 82);
        if (tokens.some((token) => token === candidate.symbol)) score = Math.max(score, 98);
        if (tokens.length) {
          const joined = tokens.join('');
          const twoTokens = tokens.slice(0, 2).join('');
          if (candidate.symbol === tokens[0]) score = Math.max(score, 94);
          if (tokens.length >= 2 && candidate.symbol === twoTokens) score = Math.max(score, 96);
          if (joined.startsWith(candidate.symbol) || candidate.symbol.startsWith(joined)) {
            score = Math.max(score, 90);
          }
          if (joined.endsWith(candidate.symbol)) {
            score = Math.max(score, 92);
          }
          const numericTokens = tokens.filter((token) => /^\d+$/.test(token));
          const digitSuffix = numericTokens.join('');
          const letterAcronym = companyAcronym(tokens.filter((token) => !/^\d+$/.test(token)));
          if (digitSuffix && candidate.symbol.endsWith(digitSuffix)) {
            score = Math.max(score, 90);
            if (letterAcronym && candidate.symbol.startsWith(letterAcronym)) {
              score = Math.max(score, 94);
            }
          }
          if (tokens.length >= 2) {
            const tokenPrefixes = tokens.slice(1).map((token) => token.slice(0, 3)).filter(Boolean);
            if (tokens[0] && tokenPrefixes.length) {
              const hit = tokenPrefixes.some((prefix) => candidate.symbol.includes(prefix));
              if (hit && candidate.symbol.startsWith(tokens[0])) {
                score = Math.max(score, 90);
              }
            }
          }
          if (tokens.length >= 2) {
            const altSymbol = `${tokens[0].slice(0, 4)}${tokens[1].slice(0, 4)}`;
            if (altSymbol && candidate.symbol === altSymbol) {
              score = Math.max(score, 95);
            }
          }
          if (tokens.length) {
            const symbolDistance = levenshtein(candidate.symbol, joined.slice(0, candidate.symbol.length + 2));
            if (symbolDistance <= 2) {
              score = Math.max(score, 86);
            }
          }
        }
        if (tokens.length >= 2 && ratio < 0.6) {
          score = Math.min(score, 74);
        }
        if (fullMatch) {
          score = Math.max(score, 92);
        }
        return { score, coverage: ratio, fullMatch };
      };

      if (nameHint) {
        const scored = candidates
          .map((candidate) => {
            const scoredCandidate = scoreCandidate(nameHint, candidate);
            return {
              symbol: candidate.symbol,
              score: scoredCandidate.score,
              coverage: scoredCandidate.coverage,
              fullMatch: scoredCandidate.fullMatch,
              tokens: candidate.tokens,
              symbolLength: candidate.symbol.length
            };
          })
          .filter((entry) => entry.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              Number(b.fullMatch) - Number(a.fullMatch) ||
              b.coverage - a.coverage ||
              b.symbolLength - a.symbolLength ||
              b.tokens.length - a.tokens.length
          );
        if (scored.length) {
          const best = scored[0];
          if (best.score >= 60) {
            return {
              symbol: best.symbol,
              mapped: true,
              score: best.score,
              confidence: confidenceFromScore(best.score),
              method: 'companyName'
            };
          }
          return {
            symbol: normalized,
            mapped: false,
            reason: `Low confidence match (${best.score}%)`
          };
        }
      }

      if (!isNumeric && normalized) {
        const symbolMatches = candidates.filter((row) => row.symbol.startsWith(normalized));
        if (symbolMatches.length === 1) {
          return { symbol: symbolMatches[0].symbol, mapped: true, score: 85, confidence: 'MEDIUM', method: 'symbolPrefix' };
        }
      }

      if (isNumeric && !nameHint) {
        return { symbol: normalized, mapped: false, reason: 'Numeric scrip code without company name' };
      }
      if (nameHint) {
        return { symbol: normalized, mapped: false, reason: 'Company name not found in NSE master' };
      }
      if (!normalized) {
        return { symbol: '', mapped: false, reason: 'Missing symbol' };
      }
      if (normalized.length < 3) {
        return { symbol: normalized, mapped: false, reason: 'Symbol too short' };
      }
      return { symbol: normalized, mapped: false, reason: 'Symbol not found in NSE master' };
    };

    const renderImportReport = (failures: ImportFailure[], lowConfidence: LowConfidenceMapping[]) => {
      if (!failures.length && !lowConfidence.length) {
        tradeImportReport.classList.add('d-none');
        tradeImportReport.textContent = '';
        return;
      }
      const failureRows = failures
        .sort((a, b) => b.count - a.count)
        .slice(0, 12)
        .map((item) => {
          const label = item.companyName ? `${item.symbol} (${item.companyName})` : item.symbol;
          return `<div class="d-flex justify-content-between gap-3">
            <div class="fw-semibold">${label}</div>
            <div class="text-muted">${item.reason}</div>
            <div class="text-muted">x${item.count}</div>
          </div>`;
        })
        .join('');
      const confidenceRows = lowConfidence
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((item) => {
          const label = item.companyName ? `${item.symbol} (${item.companyName})` : item.symbol;
          const badge =
            item.confidence === 'HIGH' ? 'text-bg-success' : item.confidence === 'MEDIUM' ? 'text-bg-warning' : 'text-bg-danger';
          return `<div class="d-flex justify-content-between gap-3">
            <div class="fw-semibold">${label}</div>
            <div class="text-muted">Confidence: <span class="badge ${badge}">${item.confidence}</span> (${item.score}%)</div>
            <div class="text-muted">x${item.count}</div>
          </div>`;
        })
        .join('');
      tradeImportReport.innerHTML = `
        ${
          failureRows
            ? `<div class="fw-semibold mb-2">Unmapped tickers (top ${Math.min(12, failures.length)})</div>
               <div class="d-flex flex-column gap-1 small mb-3">${failureRows}</div>`
            : ''
        }
        ${
          confidenceRows
            ? `<div class="fw-semibold mb-2">Low confidence mappings (top ${Math.min(12, lowConfidence.length)})</div>
               <div class="d-flex flex-column gap-1 small">${confidenceRows}</div>`
            : ''
        }
      `;
      tradeImportReport.classList.remove('d-none');
    };

    const applyTickerSort = (rows: TickerSummary[]) => {
      const sorted = [...rows];
      const dir = tickerSort.dir === 'asc' ? 1 : -1;
      sorted.sort((a, b) => {
        switch (tickerSort.key) {
          case 'ltp': {
            const av = a.livePrice ?? Number.NEGATIVE_INFINITY;
            const bv = b.livePrice ?? Number.NEGATIVE_INFINITY;
            return (av - bv) * dir;
          }
          case 'chg': {
            const av = a.changePct ?? Number.NEGATIVE_INFINITY;
            const bv = b.changePct ?? Number.NEGATIVE_INFINITY;
            return (av - bv) * dir;
          }
          case 'last': {
            const av = a.lastTradeDate || '';
            const bv = b.lastTradeDate || '';
            return av.localeCompare(bv) * dir;
          }
          case 'ticker':
          default:
            return a.symbol.localeCompare(b.symbol) * dir;
        }
      });
      return sorted;
    };

    const updateSortIcons = () => {
      root.querySelectorAll<HTMLElement>('[data-sort-icon]').forEach((icon) => {
        const key = icon.dataset.sortIcon as typeof tickerSort.key;
        if (key === tickerSort.key) {
          icon.textContent = tickerSort.dir === 'asc' ? '▲' : '▼';
          icon.classList.add('active');
        } else {
          icon.textContent = '↕';
          icon.classList.remove('active');
        }
      });
    };

    const resetForm = () => {
      tradeId.value = '';
      tradeSymbol.value = '';
      tradeSide.value = 'BUY';
      tradeQty.value = '';
      tradePrice.value = '';
      tradeDate.value = new Date().toISOString().slice(0, 10);
      tradeNotes.value = '';
      updateSymbolHint();
      updatePreBuyChecklist();
    };

    const setModalTab = (tab: 'form' | 'checklist') => {
      modalTabButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tradeTab === tab);
      });
      modalTabPanels.forEach((panel) => {
        panel.classList.toggle('d-none', panel.dataset.tradeTabPanel !== tab);
      });
    };

    const openModal = (trade?: TradeRecord) => {
      clearAlert(feedback);
      if (trade) {
        modalTitle.textContent = 'Edit Trade';
        tradeId.value = trade.id;
        tradeSymbol.value = trade.symbol;
        tradeSide.value = trade.side;
        tradeQty.value = String(trade.quantity);
        tradePrice.value = String(trade.price);
        tradeDate.value = trade.tradeDate || new Date().toISOString().slice(0, 10);
        tradeNotes.value = trade.notes || '';
      } else {
        modalTitle.textContent = 'Add Trade';
        resetForm();
      }
      prebuyTabBtn.disabled = tradeSide.value !== 'BUY';
      updateSymbolHint();
      updatePreBuyChecklist();
      setModalTab('form');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    };

    const closeModal = () => {
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
    };

    const refreshKpis = () => {
      const mergedTrades = mergeImportedTrades(trades);
      const total = mergedTrades.length;
      const buys = mergedTrades.filter((trade) => trade.side === 'BUY').length;
      const sells = mergedTrades.filter((trade) => trade.side === 'SELL').length;
      const amounts = mergedTrades
        .map((trade) => Number(trade.quantity) * Number(trade.price))
        .filter((value) => Number.isFinite(value));
      const avgAmount = amounts.length ? amounts.reduce((sum, value) => sum + value, 0) / amounts.length : null;

      kpiTotal.textContent = String(total);
      kpiOpen.textContent = String(buys);
      kpiWinRate.textContent = String(sells);
      kpiWinMeta.textContent = total ? `${buys} buys / ${sells} sells` : 'No trades yet';
      kpiNet.textContent = avgAmount === null ? '--' : formatMoney(avgAmount);
      kpiNet.classList.remove('text-success', 'text-danger');
    };

    const renderTickerRows = (rows: TickerSummary[]) => {
      if (!rows.length) {
        tickerBody.innerHTML = '<tr><td colspan="7" class="text-muted text-center py-3">No tickers yet.</td></tr>';
        tickerCount.textContent = '0 tickers';
        return;
      }
      tickerBody.innerHTML = rows
        .map((row) => {
          const statusBadge = row.valid ? 'text-bg-success' : 'text-bg-danger';
          const statusLabel = row.valid ? 'VALID' : 'NOT VALID';
          const confidenceBadge = row.confidence
            ? `<span class="badge ms-2 ${
                row.confidence === 'HIGH'
                  ? 'text-bg-success'
                  : row.confidence === 'MEDIUM'
                    ? 'text-bg-warning'
                    : 'text-bg-danger'
              }">${row.confidence}</span>`
            : '';
          const changeClass =
            row.changePct === null || row.changePct === undefined
              ? 'text-muted'
              : row.changePct >= 0
                ? 'text-success'
                : 'text-danger';
          const action =
            row.requestStatus === 'PENDING'
              ? '<span class="badge text-bg-warning">Requested</span>'
              : `<button class="btn btn-sm btn-outline-primary" data-action="request" data-symbol="${row.symbol}">${
                  row.valid ? 'Request Review' : 'Request'
                }</button>`;
          const detailsToggle = `
            <button class="btn btn-link p-0 text-decoration-none mobile-details-toggle d-md-none" data-action="toggle-details" type="button">
              Details
            </button>
          `;
          return `
            <tr>
              <td class="col-ticker fw-semibold" data-label="Ticker" data-role="summary" data-summary="ticker">${row.symbol}${confidenceBadge}</td>
              <td class="col-status" data-label="Status" data-role="summary" data-summary="status"><span class="badge ${statusBadge}">${statusLabel}</span></td>
              <td class="col-ltp text-end" data-label="LTP" data-role="summary" data-summary="ltp">${formatMoney(row.livePrice ?? null)}</td>
              <td class="col-chg text-end ${changeClass}" data-label="Chg%" data-role="summary" data-summary="chg">${formatPct(row.changePct ?? null)}</td>
              <td class="col-trades" data-label="Trades" data-role="detail">${row.tradeCount}</td>
              <td class="col-last" data-label="Last Trade" data-role="detail">${formatDate(row.lastTradeDate)}</td>
              <td class="col-action text-end" data-label="Action" data-role="action">
                <div class="d-flex flex-column align-items-end gap-1">
                  ${action}
                  ${detailsToggle}
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
      tickerCount.textContent = `${rows.length} tickers`;
    };

    const renderRequestRows = (rows: TickerRequest[]) => {
      if (!rows.length) {
        requestBody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No requests yet.</td></tr>';
        requestCount.textContent = '0 requests';
        return;
      }
      requestBody.innerHTML = rows
        .map((row) => {
          const badge =
            row.status === 'APPROVED'
              ? 'text-bg-success'
              : row.status === 'REJECTED'
                ? 'text-bg-danger'
                : 'text-bg-warning';
          const review = isReviewRequest(row.rawSymbol);
          const symbolLabel = normalizeRequestSymbol(row.rawSymbol);
          const reviewBadge = review ? '<span class="badge text-bg-info ms-2">Review</span>' : '';
          return `
            <tr>
              <td class="fw-semibold" data-label="Symbol" data-role="summary" data-summary="ticker">${symbolLabel}${reviewBadge}</td>
              <td data-label="Status" data-role="summary" data-summary="status"><span class="badge ${badge}">${row.status}</span></td>
              <td data-label="Requested" data-role="detail">${formatDate(row.requestedAt)}</td>
              <td data-label="Resolved" data-role="detail">${row.resolvedAt ? formatDate(row.resolvedAt) : '--'}</td>
              <td data-label="Note" data-role="detail">${row.note || '--'}</td>
            </tr>
          `;
        })
        .join('');
      requestCount.textContent = `${rows.length} requests`;
    };

    const renderRecoveryRows = (rows: RecoveryPlanSummary[]) => {
      if (!rows.length) {
        recoveryBody.innerHTML = '<tr><td colspan="6" class="text-muted text-center py-3">No recovery plans yet.</td></tr>';
        recoveryCount.textContent = '0 plans';
        return;
      }
      recoveryBody.innerHTML = rows
        .map((plan) => {
          const lossTrades = plan.lossTrades && plan.lossTrades.length ? plan.lossTrades : normalizeLossTrades(plan);
          const lossLabel = getRecoveryPlanLabel(plan, lossTrades);
          const statusLabel =
            plan.status === 'CLOSED' ? 'CLOSED' : plan.isRecovered ? 'RECOVERED' : 'ACTIVE';
          const statusBadge =
            plan.status === 'CLOSED'
              ? 'text-bg-secondary'
              : plan.isRecovered
                ? 'text-bg-success'
                : 'text-bg-warning';
          const recoveredLabel =
            plan.recoveredAmount >= 0 ? formatMoney(plan.recoveredAmount) : `-${formatMoney(Math.abs(plan.recoveredAmount))}`;
          return `
            <tr data-plan-id="${plan.id}">
              <td class="fw-semibold">${lossLabel}</td>
              <td>${formatMoney(plan.lossAmount)}</td>
              <td>${recoveredLabel}</td>
              <td>${formatMoney(Math.max(0, plan.remainingAmount))}</td>
              <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-secondary me-2" data-action="view-plan">View</button>
                <button class="btn btn-sm btn-outline-primary me-2" data-action="edit-plan">Edit</button>
                ${
                  plan.status === 'ACTIVE'
                    ? '<button class="btn btn-sm btn-outline-success me-2" data-action="close-plan">Close</button>'
                    : ''
                }
                <button class="btn btn-sm btn-outline-danger" data-action="delete-plan">Delete</button>
              </td>
            </tr>
          `;
        })
        .join('');
      recoveryCount.textContent = `${rows.length} plans`;
    };

    const renderReentryCandidates = (rows: Array<{ trade: TradeRecord; lossAmount: number }>) => {
      if (!rows.length) {
        reentryCandidatesBody.innerHTML =
          '<tr><td colspan="4" class="text-muted text-center py-3">No sell losses available.</td></tr>';
        reentryCandidateCount.textContent = '0 trades';
        return;
      }
      reentryCandidatesBody.innerHTML = rows
        .map(({ trade, lossAmount }) => {
          return `
            <tr data-sell-id="${trade.id}">
              <td class="fw-semibold">${trade.symbol}</td>
              <td>${trade.quantity} @ ${formatMoney(trade.price)}</td>
              <td class="text-danger">${formatMoney(lossAmount)}</td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-primary" data-action="create-reentry">Create</button>
              </td>
            </tr>
          `;
        })
        .join('');
      reentryCandidateCount.textContent = `${rows.length} trades`;
    };

    const renderReentryRows = (rows: ReentryPlanSummary[]) => {
      if (!rows.length) {
        reentryBody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No re-entry plans yet.</td></tr>';
        reentryCount.textContent = '0 plans';
        return;
      }
      reentryBody.innerHTML = rows
        .map((plan) => {
          const breakEven = plan.breakEvenLtp !== null ? formatMoney(plan.breakEvenLtp) : '--';
          return `
            <tr data-plan-id="${plan.id}">
              <td class="fw-semibold">${getReentryPlanLabel(plan)}</td>
              <td>${formatMoney(plan.lossAmount)}</td>
              <td>${plan.buybackQty}</td>
              <td>${breakEven}</td>
              <td class="text-end text-nowrap">
                <button class="btn btn-sm btn-outline-secondary me-2" data-action="view-reentry">View</button>
                <button class="btn btn-sm btn-outline-primary me-2" data-action="edit-reentry">Edit</button>
                ${
                  plan.status === 'ACTIVE'
                    ? '<button class="btn btn-sm btn-outline-success me-2" data-action="close-reentry">Close</button>'
                    : ''
                }
                <button class="btn btn-sm btn-outline-danger" data-action="delete-reentry">Delete</button>
              </td>
            </tr>
          `;
        })
        .join('');
      reentryCount.textContent = `${rows.length} plans`;
    };

    const renderReentryDetail = (plan: ReentryPlanSummary | null) => {
      if (!plan) {
        reentryDetailTitle.textContent = 'Select a plan to see analysis.';
        reentryDetailBody.innerHTML = 'Select a plan to see analysis.';
        return;
      }
      const buybackAvg = plan.buybackAvg !== null ? formatMoney(plan.buybackAvg) : '--';
      const breakEven = plan.breakEvenLtp !== null ? formatMoney(plan.breakEvenLtp) : '--';
      const targetPct = userSettings.targetProfitPct || 0;
      const targetLtp = plan.targetLtp !== null ? formatMoney(plan.targetLtp) : '--';
      const gainLabel = plan.reentryGain >= 0 ? formatMoney(plan.reentryGain) : `-${formatMoney(Math.abs(plan.reentryGain))}`;
      const remainingLabel =
        plan.remainingLoss > 0 ? `-${formatMoney(Math.abs(plan.remainingLoss))}` : formatMoney(0);

      reentryDetailTitle.textContent = `${getReentryPlanLabel(plan)} • ${plan.symbol}`;
      reentryDetailBody.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Loss Amount</div>
            <div class="h6 mb-0 text-danger">${formatMoney(plan.lossAmount)}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Buyback Qty</div>
            <div class="h6 mb-0">${plan.buybackQty}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Avg Buy Price</div>
            <div class="h6 mb-0">${buybackAvg}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Re-entry Gain</div>
            <div class="h6 mb-0">${gainLabel}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Remaining Loss</div>
            <div class="h6 mb-0 text-danger">${remainingLabel}</div>
          </div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Break-even LTP</div>
            <div class="h6 mb-0">${breakEven}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Target LTP (+${targetPct.toFixed(1)}%)</div>
            <div class="h6 mb-0">${targetLtp}</div>
          </div>
        </div>
        <div class="fw-semibold mb-2">Buyback Legs</div>
        <div class="d-flex flex-column">
          ${
            plan.buybackTrades.length
              ? plan.buybackTrades
                  .map((leg) => {
                    return `
                    <div class="d-flex justify-content-between align-items-center border-bottom py-2">
                      <div>
                        <div class="fw-semibold">${leg.quantity} @ ${formatMoney(leg.buyPrice)}</div>
                        <div class="text-muted small">${formatDate(leg.tradeDate)}</div>
                      </div>
                      <div class="text-muted small">Invested ${formatMoney(leg.investedAmount || leg.quantity * leg.buyPrice)}</div>
                    </div>
                  `;
                  })
                  .join('')
              : '<div class="text-muted small">No buyback trades linked.</div>'
          }
        </div>
      `;
    };

    const buildDateSeries = (start: Date, end: Date): string[] => {
      const dates: string[] = [];
      const cursor = new Date(start.getTime());
      cursor.setHours(0, 0, 0, 0);
      const endDate = new Date(end.getTime());
      endDate.setHours(0, 0, 0, 0);
      while (cursor.getTime() <= endDate.getTime()) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }
      return dates;
    };

    const getPlanDateBounds = (plan: RecoveryPlanSummary, lossTrades?: RecoveryLossLeg[]) => {
      const lossStart = (lossTrades || [])
        .map((leg) => new Date(leg.tradeDate))
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const start = lossStart || (plan.createdAt ? new Date(plan.createdAt) : new Date());
      const end = plan.closedAt ? new Date(plan.closedAt) : new Date();
      if (end.getTime() < start.getTime()) return { start: end, end: start };
      return { start, end };
    };

    const getRangeBounds = (plan: RecoveryPlanSummary, lossTrades: RecoveryLossLeg[]) => {
      const { start, end } = getPlanDateBounds(plan, lossTrades);
      const rangeDays = recoveryRangeOptions[recoveryRange]?.days ?? null;
      if (!rangeDays) return { start, end };
      const rangeStart = new Date(end.getTime());
      rangeStart.setDate(rangeStart.getDate() - (rangeDays - 1));
      return { start: rangeStart > start ? rangeStart : start, end };
    };

    const updateRangeButtons = (plan: RecoveryPlanSummary | null, lossTrades: RecoveryLossLeg[] = []) => {
      if (!recoveryRangeButtons.length) return;
      recoveryRangeButtons.forEach((button) => {
        const key = button.dataset.recoveryRange || 'all';
        const rangeDays = recoveryRangeOptions[key]?.days ?? null;
        if (!plan) {
          button.setAttribute('disabled', 'true');
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
          return;
        }
        const { start, end } = getPlanDateBounds(plan, lossTrades);
        const planDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1);
        const disabled = rangeDays !== null && planDays < rangeDays;
        if (disabled) {
          button.setAttribute('disabled', 'true');
          if (recoveryRange === key) {
            recoveryRange = 'all';
          }
        } else {
          button.removeAttribute('disabled');
        }
        if (recoveryRange === key) {
          button.classList.add('btn-primary');
          button.classList.remove('btn-outline-secondary');
        } else {
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
        }
      });
    };

    const updatePenButtons = (plan: RecoveryPlanSummary | null) => {
      const tradeALabel =
        recoveryView === 'ltp' ? 'Trade A Avg LTP' : recoveryView === 'return' ? 'Trade A Return %' : 'Trade A Index';
      const tradeBLabel =
        recoveryView === 'ltp' ? 'Trade B Avg LTP' : recoveryView === 'return' ? 'Trade B Return %' : 'Trade B Index';
      recoveryPenButtons.forEach((button) => {
        const key = button.dataset.recoveryPen as keyof typeof recoveryPenState | undefined;
        if (!key) return;
        if (key === 'tradeALtp') button.textContent = tradeALabel;
        if (key === 'tradeBLtp') button.textContent = tradeBLabel;
        if (!plan) {
          button.setAttribute('disabled', 'true');
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
          return;
        }
        button.removeAttribute('disabled');
        if (recoveryPenState[key]) {
          button.classList.add('btn-primary');
          button.classList.remove('btn-outline-secondary');
        } else {
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
        }
      });
    };

    const updateViewButtons = (plan: RecoveryPlanSummary | null) => {
      recoveryViewButtons.forEach((button) => {
        const key = button.dataset.recoveryView as typeof recoveryView | undefined;
        if (!key) return;
        if (!plan) {
          button.setAttribute('disabled', 'true');
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
          return;
        }
        button.removeAttribute('disabled');
        if (recoveryView === key) {
          button.classList.add('btn-primary');
          button.classList.remove('btn-outline-secondary');
        } else {
          button.classList.remove('btn-primary');
          button.classList.add('btn-outline-secondary');
        }
      });
    };

    const fetchHistoryWithCache = async (symbol: string, from: string, to: string) => {
      const key = `${symbol}|${from}|${to}`;
      if (priceHistoryCache.has(key)) return priceHistoryCache.get(key) || [];
      const data = await fetchPriceHistory({ ticker: symbol, from, to });
      priceHistoryCache.set(key, data.points || []);
      return data.points || [];
    };

    const renderRecoveryTrend = async (plan: RecoveryPlanSummary | null) => {
      if (recoveryTrendChart) {
        recoveryTrendChart.destroy();
        recoveryTrendChart = null;
      }

      if (!plan) {
        recoveryTrendCanvas.classList.add('d-none');
        recoveryTrendEmpty.classList.remove('d-none');
        return;
      }

      const lossTrades = plan.lossTrades && plan.lossTrades.length ? plan.lossTrades : normalizeLossTrades(plan);
      updateRangeButtons(plan, lossTrades);
      updatePenButtons(plan);
      updateViewButtons(plan);
      const { start, end } = getRangeBounds(plan, lossTrades);
      const labels = buildDateSeries(start, end);

      const sortedLegs = plan.legs
        .map((leg) => {
          const trade = leg.tradeId ? trades.find((item) => item.id === leg.tradeId) : undefined;
          const tradeDate = trade?.tradeDate || leg.createdAt || plan.createdAt;
          return { ...leg, tradeDate };
        })
        .sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
      const recoveryStartDate = sortedLegs.length ? new Date(sortedLegs[0].tradeDate) : null;
      const recoveryStartIndex = recoveryStartDate
        ? labels.findIndex((label) => new Date(label).getTime() >= recoveryStartDate.getTime())
        : -1;

      const recoveredSeries: number[] = [];
      const lossSeries: number[] = [];
      const breakEvenSeries: number[] = [];

      let cumulative = 0;
      let legIndex = 0;
      labels.forEach((label) => {
        const labelDate = new Date(label).getTime();
        while (legIndex < sortedLegs.length) {
          const legDate = new Date(sortedLegs[legIndex].tradeDate).getTime();
          if (legDate <= labelDate) {
            cumulative += sortedLegs[legIndex].pnl || 0;
            legIndex += 1;
          } else {
            break;
          }
        }
        recoveredSeries.push(cumulative);
        lossSeries.push(plan.lossAmount);
        breakEvenSeries.push(0);
      });

      const requestId = (trendRequestId += 1);
      recoveryTrendEmpty.textContent = 'Loading trend...';
      recoveryTrendCanvas.classList.add('d-none');
      recoveryTrendEmpty.classList.remove('d-none');

      const lossBuckets = recoveryPenState.tradeALtp
        ? lossTrades.reduce<Record<string, number>>((map, leg) => {
            map[leg.symbol] = (map[leg.symbol] || 0) + leg.quantity;
            return map;
          }, {})
        : {};
      const lossSymbols = Object.keys(lossBuckets);

      const recoveryBuckets = recoveryPenState.tradeBLtp
        ? plan.legs.reduce<Record<string, number>>((map, leg) => {
            map[leg.symbol] = (map[leg.symbol] || 0) + leg.quantity;
            return map;
          }, {})
        : {};
      const recoverySymbols = Object.keys(recoveryBuckets);

      const lossHistorySeries = new Map<string, { sum: number; weight: number }>();
      const recoveryHistorySeries = new Map<string, { sum: number; weight: number }>();
      if (lossSymbols.length || recoverySymbols.length) {
        const from = labels[0];
        const to = labels[labels.length - 1];
        await Promise.all([
          ...lossSymbols.map(async (symbol) => {
            try {
              const points = await fetchHistoryWithCache(symbol, from, to);
              points.forEach((point) => {
                const entry = lossHistorySeries.get(point.date) || { sum: 0, weight: 0 };
                const weight = lossBuckets[symbol] || 1;
                entry.sum += point.close * weight;
                entry.weight += weight;
                lossHistorySeries.set(point.date, entry);
              });
            } catch (error) {
              return;
            }
          }),
          ...recoverySymbols.map(async (symbol) => {
            try {
              const points = await fetchHistoryWithCache(symbol, from, to);
              points.forEach((point) => {
                const entry = recoveryHistorySeries.get(point.date) || { sum: 0, weight: 0 };
                const weight = recoveryBuckets[symbol] || 1;
                entry.sum += point.close * weight;
                entry.weight += weight;
                recoveryHistorySeries.set(point.date, entry);
              });
            } catch (error) {
              return;
            }
          })
        ]);
      }

      if (requestId !== trendRequestId) return;

      const lossValueSeries: Array<number | null> = labels.map((date) => {
        const entry = lossHistorySeries.get(date);
        if (!entry || !(entry.weight > 0)) return null;
        return entry.sum;
      });

      const recoveryValueSeries: Array<number | null> = labels.map((date) => {
        const entry = recoveryHistorySeries.get(date);
        if (!entry || !(entry.weight > 0)) return null;
        return entry.sum;
      });

      const avgLtpSeries: Array<number | null> = labels.map((date) => {
        const entry = lossHistorySeries.get(date);
        if (!entry || !(entry.weight > 0)) return null;
        return entry.sum / entry.weight;
      });

      const avgRecoveryLtpSeries: Array<number | null> = labels.map((date) => {
        const entry = recoveryHistorySeries.get(date);
        if (!entry || !(entry.weight > 0)) return null;
        return entry.sum / entry.weight;
      });

      const lossInvested = lossTrades.reduce((sum, leg) => sum + leg.sellPrice * leg.quantity, 0);
      const recoveryInvested = plan.legs.reduce(
        (sum, leg) => sum + (leg.investedAmount || leg.quantity * leg.buyPrice),
        0
      );

      const tradeAIndexSeries: Array<number | null> = lossValueSeries.map((value) => {
        if (value === null || !(lossInvested > 0)) return null;
        return (value / lossInvested) * 100;
      });

      const tradeBIndexSeries: Array<number | null> = recoveryValueSeries.map((value) => {
        if (value === null || !(recoveryInvested > 0)) return null;
        return (value / recoveryInvested) * 100;
      });

      const tradeAReturnSeries: Array<number | null> = lossValueSeries.map((value) => {
        if (value === null || !(lossInvested > 0)) return null;
        return ((value - lossInvested) / lossInvested) * 100;
      });

      const tradeBReturnSeries: Array<number | null> = recoveryValueSeries.map((value) => {
        if (value === null || !(recoveryInvested > 0)) return null;
        return ((value - recoveryInvested) / recoveryInvested) * 100;
      });

      const tradeALine =
        recoveryView === 'ltp' ? avgLtpSeries : recoveryView === 'return' ? tradeAReturnSeries : tradeAIndexSeries;
      const tradeBLine =
        recoveryView === 'ltp'
          ? avgRecoveryLtpSeries
          : recoveryView === 'return'
            ? tradeBReturnSeries
            : tradeBIndexSeries;

      const tradeALabel =
        recoveryView === 'ltp' ? 'Trade A Avg LTP' : recoveryView === 'return' ? 'Trade A Return %' : 'Trade A Index';
      const tradeBLabel =
        recoveryView === 'ltp' ? 'Trade B Avg LTP' : recoveryView === 'return' ? 'Trade B Return %' : 'Trade B Index';

      recoveryTrendCanvas.classList.remove('d-none');
      recoveryTrendEmpty.classList.add('d-none');

      const datasets: ChartDataset<'line', (number | null)[]>[] = [];
      if (recoveryPenState.lossTarget) {
        datasets.push({
          label: 'Loss Target',
          data: lossSeries,
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.08)',
          borderWidth: 2,
          tension: 0.25,
          fill: false,
          pointRadius: 0
        });
      }
      if (recoveryPenState.recovered) {
        datasets.push({
          label: 'Recovered',
          data: recoveredSeries,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34, 197, 94, 0.15)',
          borderWidth: 2,
          tension: 0.25,
          fill: false,
          pointRadius: 0,
          stepped: true,
          segment: {
            borderColor: (ctx: ScriptableLineSegmentContext) => {
              if (recoveryStartIndex === -1) return '#22c55e';
              return ctx.p0DataIndex < recoveryStartIndex ? '#94a3b8' : '#22c55e';
            },
            borderDash: (ctx: ScriptableLineSegmentContext) => {
              if (recoveryStartIndex === -1) return [];
              return ctx.p0DataIndex < recoveryStartIndex ? [4, 4] : [];
            }
          }
        });
      }
      if (recoveryPenState.breakEven) {
        datasets.push({
          label: 'Break-even',
          data: breakEvenSeries,
          borderColor: '#94a3b8',
          borderDash: [6, 6],
          borderWidth: 1,
          tension: 0,
          fill: false,
          pointRadius: 0
        });
      }
      if (recoveryPenState.tradeALtp) {
        datasets.push({
          label: tradeALabel,
          data: tradeALine,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.08)',
          borderWidth: 2,
          tension: 0.3,
          fill: false,
          pointRadius: 0,
          spanGaps: true,
          yAxisID: 'y1'
        });
      }
      if (recoveryPenState.tradeBLtp) {
        datasets.push({
          label: tradeBLabel,
          data: tradeBLine,
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.08)',
          borderWidth: 2,
          tension: 0.3,
          fill: false,
          pointRadius: 0,
          spanGaps: true,
          yAxisID: 'y1'
        });
      }

      const config: ChartConfiguration<'line', (number | null)[], string> = {
        type: 'line',
        data: {
          labels,
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          plugins: {
            legend: {
              position: 'bottom'
            },
            tooltip: {
              callbacks: {
                label: (context) => {
                  const value = Number(context.parsed.y || 0);
                  if (context.dataset.yAxisID === 'y1') {
                    if (recoveryView === 'ltp') {
                      return `${context.dataset.label}: ${formatMoney(value)}`;
                    }
                    if (recoveryView === 'return') {
                      return `${context.dataset.label}: ${formatPct(value)}`;
                    }
                    return `${context.dataset.label}: ${value.toFixed(1)}`;
                  }
                  return `${context.dataset.label}: ${formatMoney(value)}`;
                }
              }
            }
          },
          scales: {
            y: {
              ticks: {
                callback: (value) => formatMoney(Number(value))
              }
            },
            y1: {
              position: 'right',
              grid: {
                drawOnChartArea: false
              },
              ticks: {
                callback: (value) => {
                  const numeric = Number(value);
                  if (recoveryView === 'ltp') return formatMoney(numeric);
                  if (recoveryView === 'return') return formatPct(numeric);
                  return numeric.toFixed(1);
                }
              }
            }
          }
        }
      };

      recoveryTrendChart = new Chart(recoveryTrendCanvas, config);
    };

    const renderRecoveryDetail = (plan: RecoveryPlanSummary | null) => {
      if (!plan) {
        recoveryPlanTitle.value = '';
        recoveryPlanTitle.setAttribute('disabled', 'true');
        recoveryPlanTitleSave.setAttribute('disabled', 'true');
        recoveryTrendLossDate.textContent = 'Loss sold: --';
        recoveryTrendRecoveryDate.textContent = 'Recovery start: --';
        recoveryLossTitle.textContent = '--';
        recoveryRecoveryTitle.textContent = '--';
        recoveryCompareLoss.innerHTML = 'Select a plan to see loss details.';
        recoveryCompareRecovery.innerHTML = 'Select a plan to see recovery details.';
        updateRangeButtons(null);
        updatePenButtons(null);
        updateViewButtons(null);
        void renderRecoveryTrend(null);
        return;
      }

      const lossTrades = plan.lossTrades && plan.lossTrades.length ? plan.lossTrades : normalizeLossTrades(plan);
      const planLabel = getRecoveryPlanLabel(plan, lossTrades);
      const avgHold =
        lossTrades.length && lossTrades.some((leg) => (leg.holdDays ?? null) !== null)
          ? lossTrades.reduce((sum, leg) => sum + (leg.holdDays || 0), 0) / lossTrades.length
          : null;
      const lossStartDate = lossTrades
        .map((leg) => new Date(leg.tradeDate))
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const recoveryStart = plan.legs
        .map((leg) => {
          const trade = leg.tradeId ? trades.find((item) => item.id === leg.tradeId) : undefined;
          return new Date(trade?.tradeDate || leg.createdAt || plan.createdAt);
        })
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((a, b) => a.getTime() - b.getTime())[0];

      recoveryPlanTitle.value = planLabel;
      recoveryPlanTitle.removeAttribute('disabled');
      recoveryPlanTitleSave.removeAttribute('disabled');
      recoveryTrendLossDate.textContent = `Loss sold: ${lossStartDate ? formatDate(lossStartDate.toISOString()) : '--'}`;
      recoveryTrendRecoveryDate.textContent = `Recovery start: ${
        recoveryStart ? formatDate(recoveryStart.toISOString()) : '--'
      }`;
      updatePenButtons(plan);
      updateViewButtons(plan);
      recoveryLossTitle.textContent = `${lossTrades.length} trades`;
      recoveryRecoveryTitle.textContent = `${plan.legs.length} trades`;

      const recoveredLabel =
        plan.recoveredAmount >= 0 ? formatMoney(plan.recoveredAmount) : `-${formatMoney(Math.abs(plan.recoveredAmount))}`;
      const remainingLabel = formatMoney(Math.max(0, plan.remainingAmount));
      const recoveryPctLabel = plan.recoveryPct !== null ? `${plan.recoveryPct.toFixed(1)}%` : '--';

      const lossItems = lossTrades
        .map((leg) => {
          return `
            <div class="d-flex justify-content-between align-items-center border-bottom py-2">
              <div>
                <div class="fw-semibold">${leg.symbol}</div>
                <div class="text-muted small">Sold ${leg.quantity} @ ${formatMoney(leg.sellPrice)}</div>
              </div>
              <div class="text-end">
                <div class="small text-muted">${formatDate(leg.tradeDate)}</div>
                <div class="fw-semibold text-danger">${formatMoney(leg.lossAmount)}</div>
              </div>
            </div>
          `;
        })
        .join('');

      recoveryCompareLoss.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Total Loss</div>
            <div class="h6 mb-0 text-danger">${formatMoney(plan.lossAmount)}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Avg Hold Days</div>
            <div class="h6 mb-0">${avgHold !== null ? avgHold.toFixed(0) : '--'}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Loss Trades</div>
            <div class="h6 mb-0">${lossTrades.length}</div>
          </div>
        </div>
        <div class="d-flex flex-column">${lossItems || '<div class="text-muted small">No loss trades linked.</div>'}</div>
      `;

      const recoveryItems = plan.legs
        .map((leg) => {
          const livePrice = leg.livePrice ?? null;
          const pnl = leg.pnl ?? 0;
          const pnlClass = pnl >= 0 ? 'text-success' : 'text-danger';
          return `
            <div class="d-flex justify-content-between align-items-center border-bottom py-2">
              <div>
                <div class="fw-semibold">${leg.symbol}</div>
                <div class="text-muted small">${leg.quantity} @ ${formatMoney(leg.buyPrice)}</div>
              </div>
              <div class="text-end">
                <div class="small text-muted">LTP ${formatMoney(livePrice)}</div>
                <div class="fw-semibold ${pnlClass}">${formatMoney(pnl)}</div>
              </div>
            </div>
          `;
        })
        .join('');

      recoveryCompareRecovery.innerHTML = `
        <div class="d-flex flex-wrap gap-2 mb-3">
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Recovered</div>
            <div class="h6 mb-0">${recoveredLabel}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Remaining</div>
            <div class="h6 mb-0">${remainingLabel}</div>
          </div>
          <div class="kpi-card flex-grow-1">
            <div class="text-muted small">Recovery %</div>
            <div class="h6 mb-0">${recoveryPctLabel}</div>
          </div>
        </div>
        <div class="d-flex flex-column">${recoveryItems || '<div class="text-muted small">No recovery trades added.</div>'}</div>
      `;

      void renderRecoveryTrend(plan);
    };

    const updateRecoveryKpis = (rows: RecoveryPlanSummary[]) => {
      const active = rows.filter((plan) => plan.status === 'ACTIVE').length;
      const recovered = rows.filter((plan) => plan.isRecovered).length;
      const totalLoss = rows.reduce((sum, plan) => sum + plan.lossAmount, 0);
      const totalRecovered = rows.reduce((sum, plan) => sum + plan.recoveredAmount, 0);
      const netRecovery = totalRecovered - totalLoss;
      const winPct = rows.length ? (recovered / rows.length) * 100 : null;
      recoveryActive.textContent = String(active);
      recoveryRecovered.textContent = String(recovered);
      recoveryWin.textContent = winPct === null ? '--' : `${winPct.toFixed(0)}%`;
      recoveryNet.textContent = netRecovery >= 0 ? formatMoney(netRecovery) : `-${formatMoney(Math.abs(netRecovery))}`;
      recoverySummaryUpdated.textContent = `Updated: ${formatDateTime(new Date().toISOString())}`;
    };

    const renderRecoveryLegs = () => {
      if (!recoveryDraft.legs.length) {
        recoveryLegsBody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No recovery trades yet.</td></tr>';
        return;
      }
      recoveryLegsBody.innerHTML = recoveryDraft.legs
        .map((leg) => {
          return `
            <tr data-leg-id="${leg.id}">
              <td><input class="form-control form-control-sm" data-field="symbol" value="${leg.symbol || ''}" /></td>
              <td><input class="form-control form-control-sm" data-field="quantity" type="number" min="1" step="1" value="${leg.quantity || ''}" /></td>
              <td><input class="form-control form-control-sm" data-field="buyPrice" type="number" min="0" step="0.01" value="${leg.buyPrice || ''}" /></td>
              <td class="text-muted">${formatMoney(leg.investedAmount || leg.quantity * leg.buyPrice)}</td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-danger" data-action="remove-leg">Remove</button>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const renderRecoveryLosses = () => {
      if (!recoveryDraft.lossTrades.length) {
        recoveryLossBody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No loss trades added.</td></tr>';
      } else {
        recoveryLossBody.innerHTML = recoveryDraft.lossTrades
          .map((leg) => {
            return `
              <tr data-loss-id="${leg.id}">
                <td class="fw-semibold">${leg.symbol}</td>
                <td>${leg.quantity}</td>
                <td>${formatMoney(leg.sellPrice)}</td>
                <td class="text-danger">${formatMoney(leg.lossAmount)}</td>
                <td class="text-end">
                  <button class="btn btn-sm btn-outline-danger" data-action="remove-loss">Remove</button>
                </td>
              </tr>
            `;
          })
          .join('');
      }
      const totalLoss = recoveryDraft.lossTrades.reduce((sum, leg) => sum + (leg.lossAmount || 0), 0);
      recoveryLossAmount.textContent = formatMoney(totalLoss);
      recoveryLossCount.textContent = String(recoveryDraft.lossTrades.length);
      if (recoveryDraft.lossTrades.length === 1) {
        const loss = recoveryDraft.lossTrades[0];
        recoveryLossMeta.textContent = `Sold at ${formatMoney(loss.sellPrice)} on ${formatDate(loss.tradeDate)}`;
      } else {
        recoveryLossMeta.textContent = `Linked loss trades: ${recoveryDraft.lossTrades.length}`;
      }
      recoveryDraftLossAmount = totalLoss;
      recoveryDraftHoldDays = recoveryDraft.lossTrades.length
        ? recoveryDraft.lossTrades.reduce((sum, leg) => sum + (leg.holdDays || 0), 0) / recoveryDraft.lossTrades.length
        : null;
    };

    const refreshLossTradeOptions = () => {
      const sellTrades = trades.filter((trade) => trade.side === 'SELL');
      const usedLossIds = new Set(recoveryDraft.lossTrades.map((leg) => leg.tradeId).filter(Boolean));
      const blockedLossIds = new Set(linkedLossTradeIds);
      if (recoveryDraft.planId) {
        const currentPlan = recoveryPlans.find((plan) => plan.id === recoveryDraft.planId);
        if (currentPlan) {
          normalizeLossTrades(currentPlan).forEach((leg) => {
            if (leg.tradeId) {
              blockedLossIds.delete(leg.tradeId);
            }
          });
        }
      }
      usedLossIds.forEach((id) => {
        if (id) {
          blockedLossIds.delete(id);
        }
      });
      const options = sellTrades
        .map((trade) => ({
          trade,
          snapshot: computeLossSnapshot(trade)
        }))
        .filter(
          ({ trade, snapshot }) =>
            snapshot.lossAmount > 0 && !usedLossIds.has(trade.id) && !blockedLossIds.has(trade.id)
        )
        .map(({ trade }) => {
          return `<option value="${trade.id}">${trade.symbol} - ${trade.quantity} @ ${formatMoney(trade.price)} (${formatDate(trade.tradeDate)})</option>`;
        })
        .join('');
      recoveryLossTrade.innerHTML = '<option value="">Add from SELL trade...</option>' + options;
    };

    const openRecoveryModal = (lossTrade: TradeRecord | null, plan?: RecoveryPlan) => {
      const normalizedLossTrades = plan ? normalizeLossTrades(plan) : [];
      if (!plan) {
        if (!lossTrade) {
          showAlert(feedback, 'warning', 'Select a loss trade first.');
          return;
        }
        const snapshot = computeLossSnapshot(lossTrade);
        normalizedLossTrades.push({
          id: crypto.randomUUID(),
          tradeId: lossTrade.id,
          symbol: lossTrade.symbol,
          quantity: lossTrade.quantity,
          sellPrice: lossTrade.price,
          lossAmount: snapshot.lossAmount,
          tradeDate: lossTrade.tradeDate,
          holdDays: snapshot.holdDays,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      recoveryDraft = {
        planId: plan?.id,
        lossTrades: normalizedLossTrades,
        legs: plan?.recoveryTrades ? plan.recoveryTrades.map((leg) => ({ ...leg })) : []
      };

      recoveryModalTitle.textContent = plan ? 'Edit Recovery Plan' : 'Create Recovery Plan';
      if (plan) {
        recoveryLossMeta.textContent = `Linked loss trades: ${normalizedLossTrades.length}`;
      } else if (lossTrade) {
        recoveryLossMeta.textContent = `Sold at ${formatMoney(lossTrade.price)} on ${formatDate(lossTrade.tradeDate)}`;
      } else {
        recoveryLossMeta.textContent = 'Select a loss trade first.';
      }
      recoveryNotes.value = plan?.notes ?? '';
      const defaultPlanName = normalizedLossTrades.length
        ? normalizedLossTrades.length === 1
          ? normalizedLossTrades[0].symbol
          : `${normalizedLossTrades[0].symbol} +${normalizedLossTrades.length - 1}`
        : 'Recovery plan';
      recoveryPlanName.value = plan?.name ?? defaultPlanName;

      refreshLossTradeOptions();

      const buyTrades = trades.filter((trade) => trade.side === 'BUY');
      recoveryLegTrade.innerHTML =
        '<option value="">Add from BUY trade...</option>' +
        buyTrades
          .map((trade) => {
            return `<option value="${trade.id}">${trade.symbol} • ${trade.quantity} @ ${formatMoney(trade.price)} (${formatDate(trade.tradeDate)})</option>`;
          })
          .join('');

      renderRecoveryLosses();
      renderRecoveryLegs();
      recoveryModal.classList.add('show');
      recoveryModal.setAttribute('aria-hidden', 'false');
    };

    const closeRecoveryModal = () => {
      recoveryModal.classList.remove('show');
      recoveryModal.setAttribute('aria-hidden', 'true');
      recoveryDraft = { legs: [], lossTrades: [] };
      recoveryPlanName.value = '';
    };

    const getSellTradeForReentryPlan = (plan: ReentryPlan): TradeRecord => {
      const existing = plan.sellTradeId ? trades.find((trade) => trade.id === plan.sellTradeId) : undefined;
      if (existing) return existing;
      return {
        id: plan.sellTradeId || crypto.randomUUID(),
        userId: session.userId,
        symbol: plan.symbol,
        side: 'SELL',
        quantity: plan.sellQuantity,
        price: plan.sellPrice,
        tradeDate: plan.sellTradeDate,
        notes: '',
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt
      };
    };

    const renderReentryBuys = () => {
      if (!reentryDraft.buybacks.length) {
        reentryBuysBody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3">No buyback trades added.</td></tr>';
        return;
      }
      reentryBuysBody.innerHTML = reentryDraft.buybacks
        .map((leg) => {
          return `
            <tr data-leg-id="${leg.id}">
              <td><input class="form-control form-control-sm" data-field="quantity" type="number" min="1" step="1" value="${leg.quantity || ''}" /></td>
              <td><input class="form-control form-control-sm" data-field="buyPrice" type="number" min="0" step="0.01" value="${leg.buyPrice || ''}" /></td>
              <td><input class="form-control form-control-sm" data-field="tradeDate" type="date" value="${leg.tradeDate || ''}" /></td>
              <td class="text-end">
                <button class="btn btn-sm btn-outline-danger" data-action="remove-buy">Remove</button>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const refreshReentryBuyOptions = () => {
      if (!reentryDraft.sellTrade) {
        reentryBuyTrade.innerHTML = '<option value="">Add from BUY trade...</option>';
        return;
      }
      const sellTrade = reentryDraft.sellTrade;
      const usedIds = new Set(reentryDraft.buybacks.map((leg) => leg.tradeId).filter(Boolean));
      const buyTrades = trades
        .filter(
          (trade) =>
            trade.side === 'BUY' &&
            normalizeSymbol(trade.symbol) === normalizeSymbol(sellTrade.symbol) &&
            trade.tradeDate >= sellTrade.tradeDate
        )
        .filter((trade) => !usedIds.has(trade.id));
      reentryBuyTrade.innerHTML =
        '<option value="">Add from BUY trade...</option>' +
        buyTrades
          .map((trade) => {
            return `<option value="${trade.id}">${trade.symbol} • ${trade.quantity} @ ${formatMoney(trade.price)} (${formatDate(trade.tradeDate)})</option>`;
          })
          .join('');
    };

    const openReentryModal = (sellTrade: TradeRecord | null, plan?: ReentryPlan) => {
      if (!plan && !sellTrade) {
        showAlert(feedback, 'warning', 'Select a loss trade first.');
        return;
      }
      const selectedTrade = plan ? getSellTradeForReentryPlan(plan) : sellTrade!;
      const snapshot = plan ? { lossAmount: plan.lossAmount } : computeLossSnapshot(selectedTrade);
      if (!plan && snapshot.lossAmount <= 0) {
        showAlert(feedback, 'warning', 'This sell trade does not have a loss to analyze.');
        return;
      }
      const defaultName = `${selectedTrade.symbol} Re-entry`;
      reentryDraft = {
        planId: plan?.id,
        sellTrade: selectedTrade,
        lossAmount: plan?.lossAmount ?? snapshot.lossAmount,
        buybacks: plan?.buybackTrades ? plan.buybackTrades.map((leg) => ({ ...leg })) : []
      };
      reentryModalTitle.textContent = plan ? 'Edit Re-entry Plan' : 'Create Re-entry Plan';
      reentryPlanName.value = plan?.name ?? defaultName;
      reentryNotes.value = plan?.notes ?? '';
      reentrySellMeta.textContent = `${selectedTrade.symbol} • Sold ${selectedTrade.quantity} @ ${formatMoney(
        selectedTrade.price
      )} on ${formatDate(selectedTrade.tradeDate)}`;
      reentryLossAmount.textContent = formatMoney(reentryDraft.lossAmount || 0);
      reentrySellQty.textContent = String(selectedTrade.quantity || 0);

      refreshReentryBuyOptions();
      renderReentryBuys();
      reentryModal.classList.add('show');
      reentryModal.setAttribute('aria-hidden', 'false');
    };

    const closeReentryModal = () => {
      reentryModal.classList.remove('show');
      reentryModal.setAttribute('aria-hidden', 'true');
      reentryDraft = { buybacks: [] };
      reentryPlanName.value = '';
      reentryNotes.value = '';
    };

    let mappingReviewResolver: ((value: { expected: string; note: string } | null) => void) | null = null;

    const closeMappingReview = (result: { expected: string; note: string } | null) => {
      mappingReviewModal.classList.remove('show');
      mappingReviewModal.setAttribute('aria-hidden', 'true');
      if (mappingReviewResolver) {
        mappingReviewResolver(result);
        mappingReviewResolver = null;
      }
    };

    mappingReviewModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'mapping-review') {
        closeMappingReview(null);
      }
    });

    mappingReviewClose.addEventListener('click', () => closeMappingReview(null));
    mappingReviewCancel.addEventListener('click', () => closeMappingReview(null));
    mappingReviewSubmit.addEventListener('click', () =>
      closeMappingReview({ expected: mappingReviewExpected.value, note: mappingReviewNote.value })
    );

    const openMappingReviewModal = (options: { symbol: string; companyName?: string }) =>
      new Promise<{ expected: string; note: string } | null>((resolve) => {
        mappingReviewResolver = resolve;
        mappingReviewCurrent.textContent = options.symbol;
        mappingReviewCompany.textContent = options.companyName || '--';
        mappingReviewExpected.value = options.symbol;
        mappingReviewNote.value = '';
        mappingReviewModal.classList.add('show');
        mappingReviewModal.setAttribute('aria-hidden', 'false');
        mappingReviewExpected.focus();
      });

    recoveryModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'recovery') {
        closeRecoveryModal();
      }
    });
    recoveryModalClose.addEventListener('click', closeRecoveryModal);
    recoveryCancel.addEventListener('click', closeRecoveryModal);

    recoveryLossAdd.addEventListener('click', () => {
      const tradeId = recoveryLossTrade.value;
      if (!tradeId) return;
      const trade = trades.find((item) => item.id === tradeId);
      if (!trade) return;
      const snapshot = computeLossSnapshot(trade);
      if (snapshot.lossAmount <= 0) {
        showAlert(feedback, 'warning', 'This sell trade does not have a loss to recover.');
        return;
      }
      const now = new Date().toISOString();
      recoveryDraft.lossTrades.push({
        id: crypto.randomUUID(),
        tradeId: trade.id,
        symbol: trade.symbol,
        quantity: trade.quantity,
        sellPrice: trade.price,
        lossAmount: snapshot.lossAmount,
        tradeDate: trade.tradeDate,
        holdDays: snapshot.holdDays,
        createdAt: now,
        updatedAt: now
      });
      renderRecoveryLosses();
      refreshLossTradeOptions();
      recoveryLossTrade.value = '';
    });

    recoveryLossBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.dataset.action !== 'remove-loss') return;
      const row = target.closest<HTMLTableRowElement>('tr');
      if (!row) return;
      const lossId = row.dataset.lossId || '';
      recoveryDraft.lossTrades = recoveryDraft.lossTrades.filter((leg) => leg.id !== lossId);
      renderRecoveryLosses();
      refreshLossTradeOptions();
    });

    recoveryLegAdd.addEventListener('click', () => {
      const tradeId = recoveryLegTrade.value;
      if (!tradeId) return;
      const trade = trades.find((item) => item.id === tradeId);
      if (!trade) return;
      const now = new Date().toISOString();
      recoveryDraft.legs.push({
        id: crypto.randomUUID(),
        tradeId: trade.id,
        symbol: trade.symbol,
        quantity: trade.quantity,
        buyPrice: trade.price,
        investedAmount: trade.quantity * trade.price,
        createdAt: now,
        updatedAt: now
      });
      renderRecoveryLegs();
      recoveryLegTrade.value = '';
    });

    recoveryLegAddManual.addEventListener('click', () => {
      const now = new Date().toISOString();
      recoveryDraft.legs.push({
        id: crypto.randomUUID(),
        symbol: '',
        quantity: 1,
        buyPrice: 0,
        investedAmount: 0,
        createdAt: now,
        updatedAt: now
      });
      renderRecoveryLegs();
    });

    recoveryLegsBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLButtonElement>('[data-action="remove-leg"]');
      if (!button) return;
      const row = button.closest<HTMLTableRowElement>('tr[data-leg-id]');
      if (!row) return;
      const legId = row.dataset.legId || '';
      recoveryDraft.legs = recoveryDraft.legs.filter((leg) => leg.id !== legId);
      renderRecoveryLegs();
    });

    recoveryLegsBody.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-leg-id]');
      if (!row) return;
      const legId = row.dataset.legId || '';
      const field = target.dataset.field as 'symbol' | 'quantity' | 'buyPrice' | undefined;
      if (!field) return;
      const leg = recoveryDraft.legs.find((item) => item.id === legId);
      if (!leg) return;
      if (field === 'symbol') {
        leg.symbol = normalizeSymbol(target.value);
      } else if (field === 'quantity') {
        leg.quantity = Number(target.value || 0);
      } else if (field === 'buyPrice') {
        leg.buyPrice = Number(target.value || 0);
      }
      leg.investedAmount = (leg.quantity || 0) * (leg.buyPrice || 0);
      leg.updatedAt = new Date().toISOString();
      renderRecoveryLegs();
    });

    recoverySave.addEventListener('click', async () => {
      if (!recoveryDraft.lossTrades.length) {
        showAlert(feedback, 'warning', 'Select at least one loss trade first.');
        return;
      }
      if (!recoveryDraft.legs.length) {
        showAlert(feedback, 'warning', 'Add at least one recovery trade.');
        return;
      }
      const invalidLeg = recoveryDraft.legs.find((leg) => !leg.symbol || !(leg.quantity > 0) || !(leg.buyPrice > 0));
      if (invalidLeg) {
        showAlert(feedback, 'warning', 'Each recovery trade needs symbol, qty, and buy price.');
        return;
      }
      const now = new Date().toISOString();
      const normalizedLossTrades = recoveryDraft.lossTrades.map((leg) => ({
        ...leg,
        createdAt: leg.createdAt || now,
        updatedAt: now
      }));
      const primaryLoss = normalizedLossTrades[0];
      const planName = recoveryPlanName.value.trim();
      const plan: RecoveryPlan = {
        id: recoveryDraft.planId || crypto.randomUUID(),
        userId: session.userId,
        status: recoveryDraft.planId
          ? recoveryPlans.find((item) => item.id === recoveryDraft.planId)?.status || 'ACTIVE'
          : 'ACTIVE',
        name: planName || undefined,
        lossTradeId: primaryLoss.tradeId,
        lossSymbol: primaryLoss.symbol,
        lossQuantity: primaryLoss.quantity,
        lossSellPrice: primaryLoss.sellPrice,
        lossAmount: recoveryDraftLossAmount,
        lossTradeDate: primaryLoss.tradeDate,
        lossHoldDays: recoveryDraftHoldDays,
        lossTrades: normalizedLossTrades,
        recoveryTrades: recoveryDraft.legs.map((leg) => ({
          ...leg,
          investedAmount: leg.investedAmount || leg.quantity * leg.buyPrice,
          createdAt: leg.createdAt || now,
          updatedAt: now
        })),
        notes: recoveryNotes.value.trim() || undefined,
        createdAt: recoveryDraft.planId
          ? recoveryPlans.find((item) => item.id === recoveryDraft.planId)?.createdAt || now
          : now,
        updatedAt: now,
        closedAt: recoveryDraft.planId
          ? recoveryPlans.find((item) => item.id === recoveryDraft.planId)?.closedAt || null
          : null
      };
      try {
        if (recoveryDraft.planId) {
          const updates: Partial<Omit<RecoveryPlan, 'id' | 'userId' | 'createdAt'>> = {
            status: plan.status,
            name: plan.name,
            lossTradeId: plan.lossTradeId,
            lossSymbol: plan.lossSymbol,
            lossQuantity: plan.lossQuantity,
            lossSellPrice: plan.lossSellPrice,
            lossAmount: plan.lossAmount,
            lossTradeDate: plan.lossTradeDate,
            lossHoldDays: plan.lossHoldDays,
            lossTrades: plan.lossTrades,
            recoveryTrades: plan.recoveryTrades,
            notes: plan.notes,
            updatedAt: plan.updatedAt,
            closedAt: plan.closedAt
          };
          await updateRecoveryPlan(plan.id, session.userId, updates);
          showAlert(feedback, 'success', 'Recovery plan updated.');
        } else {
          await addRecoveryPlan(plan);
          showAlert(feedback, 'success', 'Recovery plan created.');
        }
        closeRecoveryModal();
        await refreshData();
        await queueAndSync();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    reentryModal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'reentry') {
        closeReentryModal();
      }
    });
    reentryModalClose.addEventListener('click', closeReentryModal);
    reentryCancel.addEventListener('click', closeReentryModal);

    reentryBuyAdd.addEventListener('click', () => {
      const tradeId = reentryBuyTrade.value;
      if (!tradeId) return;
      const trade = trades.find((item) => item.id === tradeId);
      if (!trade) return;
      const now = new Date().toISOString();
      reentryDraft.buybacks.push({
        id: crypto.randomUUID(),
        tradeId: trade.id,
        symbol: trade.symbol,
        quantity: trade.quantity,
        buyPrice: trade.price,
        tradeDate: trade.tradeDate,
        investedAmount: trade.quantity * trade.price,
        createdAt: now,
        updatedAt: now
      });
      renderReentryBuys();
      refreshReentryBuyOptions();
      reentryBuyTrade.value = '';
    });

    reentryBuyAddManual.addEventListener('click', () => {
      const now = new Date().toISOString();
      reentryDraft.buybacks.push({
        id: crypto.randomUUID(),
        symbol: reentryDraft.sellTrade?.symbol || '',
        quantity: 1,
        buyPrice: 0,
        tradeDate: new Date().toISOString().slice(0, 10),
        investedAmount: 0,
        createdAt: now,
        updatedAt: now
      });
      renderReentryBuys();
    });

    reentryBuysBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const button = target.closest<HTMLButtonElement>('[data-action="remove-buy"]');
      if (!button) return;
      const row = button.closest<HTMLTableRowElement>('tr[data-leg-id]');
      if (!row) return;
      const legId = row.dataset.legId || '';
      reentryDraft.buybacks = reentryDraft.buybacks.filter((leg) => leg.id !== legId);
      renderReentryBuys();
      refreshReentryBuyOptions();
    });

    reentryBuysBody.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target) return;
      const row = target.closest<HTMLTableRowElement>('tr[data-leg-id]');
      if (!row) return;
      const legId = row.dataset.legId || '';
      const field = target.dataset.field as 'quantity' | 'buyPrice' | 'tradeDate' | undefined;
      if (!field) return;
      const leg = reentryDraft.buybacks.find((item) => item.id === legId);
      if (!leg) return;
      if (field === 'quantity') {
        leg.quantity = Number(target.value || 0);
      } else if (field === 'buyPrice') {
        leg.buyPrice = Number(target.value || 0);
      } else if (field === 'tradeDate') {
        leg.tradeDate = target.value;
      }
      leg.investedAmount = (leg.quantity || 0) * (leg.buyPrice || 0);
      leg.updatedAt = new Date().toISOString();
    });

    reentrySave.addEventListener('click', async () => {
      const sellTrade = reentryDraft.sellTrade;
      if (!sellTrade) {
        showAlert(feedback, 'warning', 'Select a sell trade first.');
        return;
      }
      if (!reentryDraft.buybacks.length) {
        showAlert(feedback, 'warning', 'Add at least one buyback trade.');
        return;
      }
      const invalidLeg = reentryDraft.buybacks.find(
        (leg) => !(leg.quantity > 0) || !(leg.buyPrice > 0) || !leg.tradeDate
      );
      if (invalidLeg) {
        showAlert(feedback, 'warning', 'Each buyback needs qty, price, and date.');
        return;
      }
      const lossAmount = reentryDraft.lossAmount ?? computeLossSnapshot(sellTrade).lossAmount;
      if (!(lossAmount > 0)) {
        showAlert(feedback, 'warning', 'This sell trade does not have a loss to analyze.');
        return;
      }
      const now = new Date().toISOString();
      const planName = reentryPlanName.value.trim();
      const buybacks = reentryDraft.buybacks.map((leg) => ({
        ...leg,
        symbol: normalizeSymbol(leg.symbol || sellTrade.symbol),
        investedAmount: leg.investedAmount || leg.quantity * leg.buyPrice,
        updatedAt: now
      }));
      const plan: ReentryPlan = {
        id: reentryDraft.planId || crypto.randomUUID(),
        userId: session.userId,
        status: reentryDraft.planId
          ? reentryPlans.find((item) => item.id === reentryDraft.planId)?.status || 'ACTIVE'
          : 'ACTIVE',
        name: planName || undefined,
        symbol: normalizeSymbol(sellTrade.symbol),
        sellTradeId: sellTrade.id,
        sellQuantity: sellTrade.quantity,
        sellPrice: sellTrade.price,
        sellAmount: sellTrade.quantity * sellTrade.price,
        lossAmount: lossAmount,
        sellTradeDate: sellTrade.tradeDate,
        buybackTrades: buybacks,
        notes: reentryNotes.value.trim() || undefined,
        createdAt: reentryDraft.planId
          ? reentryPlans.find((item) => item.id === reentryDraft.planId)?.createdAt || now
          : now,
        updatedAt: now,
        closedAt: reentryDraft.planId
          ? reentryPlans.find((item) => item.id === reentryDraft.planId)?.closedAt || null
          : null
      };
      try {
        if (reentryDraft.planId) {
          await updateReentryPlan(plan.id, session.userId, {
            name: plan.name,
            status: plan.status,
            symbol: plan.symbol,
            sellTradeId: plan.sellTradeId,
            sellQuantity: plan.sellQuantity,
            sellPrice: plan.sellPrice,
            sellAmount: plan.sellAmount,
            lossAmount: plan.lossAmount,
            sellTradeDate: plan.sellTradeDate,
            buybackTrades: plan.buybackTrades,
            notes: plan.notes,
            updatedAt: plan.updatedAt,
            closedAt: plan.closedAt
          });
          showAlert(feedback, 'success', 'Re-entry plan updated.');
        } else {
          await addReentryPlan(plan);
          showAlert(feedback, 'success', 'Re-entry plan created.');
        }
        closeReentryModal();
        await refreshData();
        await queueAndSync();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    recoveryPlanTitleSave.addEventListener('click', async () => {
      if (!activeRecoveryPlanId) {
        showAlert(feedback, 'warning', 'Select a recovery plan first.');
        return;
      }
      const name = recoveryPlanTitle.value.trim();
      try {
        await updateRecoveryPlan(activeRecoveryPlanId, session.userId, {
          name: name || undefined
        });
        showAlert(feedback, 'success', 'Plan name updated.');
        await refreshData();
        await queueAndSync();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      }
    });

    recoveryRangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const range = button.dataset.recoveryRange || 'all';
        if (range === recoveryRange) return;
        recoveryRange = range as typeof recoveryRange;
        const plan =
          (activeRecoveryPlanId && recoveryRows.find((item) => item.id === activeRecoveryPlanId)) || null;
        updateRangeButtons(plan, plan?.lossTrades || []);
        if (plan) {
          void renderRecoveryTrend(plan);
        }
      });
    });

    recoveryPenButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.recoveryPen as keyof typeof recoveryPenState | undefined;
        if (!key) return;
        recoveryPenState = { ...recoveryPenState, [key]: !recoveryPenState[key] };
        saveRecoveryPenState(recoveryPenState);
        const plan =
          (activeRecoveryPlanId && recoveryRows.find((item) => item.id === activeRecoveryPlanId)) || null;
        updatePenButtons(plan);
        if (plan) {
          void renderRecoveryTrend(plan);
        }
      });
    });

    recoveryViewButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.recoveryView as typeof recoveryView | undefined;
        if (!key || key === recoveryView) return;
        recoveryView = key;
        saveRecoveryViewState(recoveryView);
        const plan =
          (activeRecoveryPlanId && recoveryRows.find((item) => item.id === activeRecoveryPlanId)) || null;
        updateViewButtons(plan);
        updatePenButtons(plan);
        if (plan) {
          void renderRecoveryTrend(plan);
        }
      });
    });

    const requestMappingReview = async (symbol: string): Promise<boolean> => {
      const companyName = importConfidence[symbol]?.companyName || '';
      const result = await openMappingReviewModal({ symbol, companyName });
      if (!result) return false;
      const expected = normalizeSymbol(result.expected);
      if (!expected) {
        showAlert(feedback, 'warning', 'Enter a valid expected ticker symbol.');
        return false;
      }
      if (expected === symbol) {
        showAlert(feedback, 'warning', 'Expected symbol matches the current ticker.');
      }
      const noteParts = ['Mapping review', `Current: ${symbol}`, `Expected: ${expected}`];
      if (companyName) noteParts.push(`Company: ${companyName}`);
      if (result.note.trim()) noteParts.push(`Note: ${result.note.trim()}`);
      await createTickerRequest({
        userId: session.userId,
        userName: session.name,
        rawSymbol: `REVIEW:${symbol}`,
        note: noteParts.join(' | ')
      });
      const overrideChanged = setOverrideSymbol(companyName, symbol, expected, { includeSymbol: !companyName });
      if (overrideChanged) {
        await queueSnapshot(session.userId);
      }
      return true;
    };

    const refreshList = () => {
      const filtered = applyFilters(trades, filters);
      const mergedFiltered = mergeImportedTrades(filtered);
      const mergedAll = mergeImportedTrades(trades);
      tradeTableBody.innerHTML = renderTableRows(filtered, linkedLossTradeIds);
      tradeCardList.innerHTML = renderCardRows(filtered, linkedLossTradeIds);
      tradeCount.textContent = `${mergedFiltered.length} of ${mergedAll.length} trades`;
    };

    const refreshTickerPanels = async () => {
      const priceRows = await listLivePrices();
      const priceMap = new Map(
        priceRows
          .map((row) => {
            const symbol = normalizeSymbol(row.ticker);
            return symbol ? [symbol, row] : null;
          })
          .filter((row): row is [string, typeof priceRows[number]] => Boolean(row))
      );
      const latestPriceAt = priceRows.reduce<string | null>((latest, row) => {
        if (!row?.fetchedAt) return latest;
        if (!latest) return row.fetchedAt;
        return row.fetchedAt > latest ? row.fetchedAt : latest;
      }, null);
      if (priceLastRefresh) {
        priceLastRefresh.textContent = `Last refresh: ${formatDateTime(latestPriceAt)}`;
      }
      tickerRows = buildTickerSummary(trades, nseSymbols, tickerRequests, priceMap, importConfidence);
      const sorted = applyTickerSort(tickerRows);
      renderTickerRows(sorted);
      updateSortIcons();
      renderRequestRows(tickerRequests);

      recoveryRows = buildRecoverySummaries(recoveryPlans, priceMap);
      updateRecoveryKpis(recoveryRows);
      renderRecoveryRows(recoveryRows);
      const selected =
        (activeRecoveryPlanId && recoveryRows.find((plan) => plan.id === activeRecoveryPlanId)) || recoveryRows[0] || null;
      if (selected) {
        activeRecoveryPlanId = selected.id;
      }
      renderRecoveryDetail(selected || null);
    };

    const refreshReentryPanels = () => {
      reentryRows = buildReentrySummaries(reentryPlans, userSettings.targetProfitPct || 0);
      renderReentryRows(reentryRows);
      const selected =
        (activeReentryPlanId && reentryRows.find((plan) => plan.id === activeReentryPlanId)) || reentryRows[0] || null;
      if (selected) {
        activeReentryPlanId = selected.id;
      }
      renderReentryDetail(selected || null);

      const candidates = trades
        .filter((trade) => trade.side === 'SELL')
        .map((trade) => ({ trade, snapshot: computeLossSnapshot(trade) }))
        .filter(
          (entry) =>
            entry.snapshot.lossAmount > 0 && (!entry.trade.id || !linkedReentrySellIds.has(entry.trade.id))
        )
        .sort((a, b) => {
          if (a.trade.tradeDate !== b.trade.tradeDate) return b.trade.tradeDate.localeCompare(a.trade.tradeDate);
          return b.trade.createdAt.localeCompare(a.trade.createdAt);
        })
        .map((entry) => ({ trade: entry.trade, lossAmount: entry.snapshot.lossAmount }));
      renderReentryCandidates(candidates);
    };

    const applyReviewApprovals = async (list: TradeRecord[], requests: TickerRequest[]) => {
      const applied = loadReviewApplied();
      const updates: Array<Promise<TradeRecord | null>> = [];
      let changed = false;
      let appliedChanged = false;
      requests.forEach((req) => {
        if (String(req.status || '').toUpperCase() !== 'APPROVED') return;
        if (!isReviewRequest(req.rawSymbol)) return;
        const current = normalizeRequestSymbol(req.rawSymbol);
        const resolved = normalizeSymbol(req.resolvedTicker || '');
        if (!current || !resolved || current === resolved) return;
        if (applied[req.requestId] === resolved) return;
        const overrideChanged = setOverrideSymbol('', current, resolved, { includeSymbol: true });
        if (overrideChanged) {
          changed = true;
        }
        list.forEach((trade) => {
          if (normalizeSymbol(trade.symbol) === current) {
            trade.symbol = resolved;
            updates.push(updateTrade(trade.id, trade.userId, { symbol: resolved }));
            changed = true;
          }
        });
        applied[req.requestId] = resolved;
        appliedChanged = true;
      });
      if (updates.length) {
        await Promise.all(updates);
      }
      if (changed || appliedChanged) {
        saveReviewApplied(applied);
      }
      return changed || appliedChanged;
    };

    const refreshData = async () => {
      const [list, masterRows, requests, settings, recoveryList, reentryList] = await Promise.all([
        listTrades(session.userId),
        listNseMasterForUser(session.userId),
        listTickerRequests(session.userId),
        getUserSettings(session.userId),
        listRecoveryPlans(session.userId),
        listReentryPlans(session.userId)
      ]);
      trades = list;
      nseMasterRows = masterRows;
      nseSymbols = new Set(masterRows.map((row) => normalizeSymbol(row.symbol)));
      tickerRequests = requests;
      userSettings = settings;
      recoveryPlans = recoveryList;
      linkedLossTradeIds = buildLinkedLossTradeIds(recoveryPlans);
      reentryPlans = reentryList;
      linkedReentrySellIds = buildLinkedReentrySellIds(reentryPlans);
      const reviewChanged = await applyReviewApprovals(trades, tickerRequests);
      importConfidence = loadImportConfidence();
      tickerRequests
        .filter((row) => String(row.status || '').toUpperCase() === 'APPROVED' && row.resolvedTicker)
        .forEach((row) => {
          const resolved = normalizeSymbol(row.resolvedTicker || '');
          if (!resolved) return;
          if (!nseSymbols.has(resolved)) {
            nseSymbols.add(resolved);
            nseMasterRows.push({ symbol: resolved, name: row.resolvedTicker || resolved, isin: '' });
          }
        });
      refreshKpis();
      refreshList();
      await refreshTickerPanels();
      refreshReentryPanels();
      renderSymbolOptions();
      if (reviewChanged) {
        await queueSnapshot(session.userId);
      }
    };

    tradeAdd.addEventListener('click', () => openModal());
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target?.dataset?.close === 'modal') {
        closeModal();
      }
    });

    tradeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearAlert(feedback);
      const symbol = normalizeSymbol(tradeSymbol.value);
      const side = tradeSide.value as TradeSide;
      const quantity = Number(tradeQty.value);
      const price = Number(tradePrice.value);
      const date = tradeDate.value;
      const notes = tradeNotes.value.trim();

      if (!symbol || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !date) {
        showAlert(feedback, 'warning', 'Please fill symbol, quantity, entry price, and date.');
        return;
      }

      const label = tradeSubmit.textContent || 'Save Trade';
      setBusy(tradeSubmit, true, label);
      try {
        if (tradeId.value) {
          await updateTrade(tradeId.value, session.userId, {
            symbol,
            side,
            quantity,
            price,
            tradeDate: date,
            notes
          });
          showAlert(feedback, 'success', 'Trade updated.');
        } else {
          await addTrade({
            userId: session.userId,
            symbol,
            side,
            quantity,
            price,
            tradeDate: date,
            notes
          });
          showAlert(feedback, 'success', 'Trade added.');
        }
        closeModal();
        await refreshData();
        await queueAndSync();
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(tradeSubmit, false, label);
      }
    });

    tradeTableBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'toggle-group') {
        const groupKey = actionButton.dataset.groupKey || '';
        if (!groupKey) return;
        const children = tradeTableBody.querySelectorAll<HTMLTableRowElement>(`tr[data-parent-group="${groupKey}"]`);
        const isOpen = actionButton.textContent?.includes('Hide');
        children.forEach((row) => row.classList.toggle('d-none', isOpen));
        actionButton.textContent = isOpen ? 'View Fills' : 'Hide Fills';
        return;
      }
      const row = actionButton.closest<HTMLTableRowElement>('tr[data-trade-id]');
      if (!row) return;
      const tradeIdValue = row.dataset.tradeId || '';
      const trade = trades.find((item) => item.id === tradeIdValue);
      if (!trade) return;

      if (action === 'edit') {
        openModal(trade);
        return;
      }
      if (action === 'recover') {
        if (trade.side !== 'SELL') {
          showAlert(feedback, 'warning', 'Recovery plans can be created from SELL trades only.');
          return;
        }
        if (linkedLossTradeIds.has(trade.id)) {
          showAlert(feedback, 'warning', 'This sell trade is already linked to a recovery plan.');
          return;
        }
        const lossSnapshot = computeLossSnapshot(trade);
        if (lossSnapshot.lossAmount <= 0) {
          showAlert(feedback, 'warning', 'This sell trade does not have a loss to recover.');
          return;
        }
        openRecoveryModal(trade);
        return;
      }
      if (action === 'delete') {
        const ok = await confirmAction({
          title: 'Delete Trade',
          message: 'Delete this trade? This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger'
        });
        if (!ok) return;
        await deleteTrade(trade.id, session.userId);
        await refreshData();
        await queueAndSync();
      }
    });

    tradeCardList.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'toggle-group') {
        const groupKey = actionButton.dataset.groupKey || '';
        if (!groupKey) return;
        const details = tradeCardList.querySelectorAll<HTMLDivElement>(`[data-parent-group="${groupKey}"]`);
        const isOpen = actionButton.textContent?.includes('Hide');
        details.forEach((row) => row.classList.toggle('d-none', isOpen));
        actionButton.textContent = isOpen ? 'View Fills' : 'Hide Fills';
        return;
      }
      const card = actionButton.closest<HTMLDivElement>('div[data-trade-id]');
      if (!card) return;
      const tradeIdValue = card.dataset.tradeId || '';
      const trade = trades.find((item) => item.id === tradeIdValue);
      if (!trade) return;

      if (action === 'edit') {
        openModal(trade);
        return;
      }
      if (action === 'recover') {
        if (trade.side !== 'SELL') {
          showAlert(feedback, 'warning', 'Recovery plans can be created from SELL trades only.');
          return;
        }
        if (linkedLossTradeIds.has(trade.id)) {
          showAlert(feedback, 'warning', 'This sell trade is already linked to a recovery plan.');
          return;
        }
        const lossSnapshot = computeLossSnapshot(trade);
        if (lossSnapshot.lossAmount <= 0) {
          showAlert(feedback, 'warning', 'This sell trade does not have a loss to recover.');
          return;
        }
        openRecoveryModal(trade);
        return;
      }
      if (action === 'delete') {
        const ok = await confirmAction({
          title: 'Delete Trade',
          message: 'Delete this trade? This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger'
        });
        if (!ok) return;
        await deleteTrade(trade.id, session.userId);
        await refreshData();
        await queueAndSync();
      }
    });

    recoveryBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      const row = actionButton.closest<HTMLTableRowElement>('tr[data-plan-id]');
      if (!row) return;
      const planId = row.dataset.planId || '';
      if (!planId) return;
      const plan = recoveryPlans.find((item) => item.id === planId);
      if (!plan) return;

      if (action === 'view-plan') {
        activeRecoveryPlanId = plan.id;
        const detailPlan = recoveryRows.find((item) => item.id === plan.id) || null;
        renderRecoveryDetail(detailPlan);
        return;
      }
      if (action === 'edit-plan') {
        const lossTrade = getLossTradeForPlan(plan);
        openRecoveryModal(lossTrade, plan);
        return;
      }
      if (action === 'close-plan') {
        const ok = await confirmAction({
          title: 'Close Recovery Plan',
          message: 'Close this recovery plan? You can still view it later.',
          confirmLabel: 'Close'
        });
        if (!ok) return;
        await updateRecoveryPlan(plan.id, session.userId, {
          status: 'CLOSED',
          closedAt: new Date().toISOString()
        });
        await refreshData();
        await queueAndSync();
        return;
      }
      if (action === 'delete-plan') {
        const ok = await confirmAction({
          title: 'Delete Recovery Plan',
          message: 'Delete this recovery plan? This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger'
        });
        if (!ok) return;
        await deleteRecoveryPlan(plan.id, session.userId);
        await refreshData();
        await queueAndSync();
      }
    });

    reentryCandidatesBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action="create-reentry"]');
      if (!actionButton) return;
      const row = actionButton.closest<HTMLTableRowElement>('tr[data-sell-id]');
      if (!row) return;
      const tradeId = row.dataset.sellId || '';
      const trade = trades.find((item) => item.id === tradeId) || null;
      openReentryModal(trade);
    });

    reentryBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      const row = actionButton.closest<HTMLTableRowElement>('tr[data-plan-id]');
      if (!row) return;
      const planId = row.dataset.planId || '';
      if (!planId) return;
      const plan = reentryPlans.find((item) => item.id === planId);
      if (!plan) return;

      if (action === 'view-reentry') {
        activeReentryPlanId = plan.id;
        refreshReentryPanels();
        return;
      }
      if (action === 'edit-reentry') {
        openReentryModal(null, plan);
        return;
      }
      if (action === 'close-reentry') {
        const ok = await confirmAction({
          title: 'Close Re-entry Plan',
          message: 'Close this re-entry plan? You can still view it later.',
          confirmLabel: 'Close'
        });
        if (!ok) return;
        await updateReentryPlan(plan.id, session.userId, {
          status: 'CLOSED',
          closedAt: new Date().toISOString()
        });
        await refreshData();
        await queueAndSync();
        return;
      }
      if (action === 'delete-reentry') {
        const ok = await confirmAction({
          title: 'Delete Re-entry Plan',
          message: 'Delete this re-entry plan? This cannot be undone.',
          confirmLabel: 'Delete',
          tone: 'danger'
        });
        if (!ok) return;
        await deleteReentryPlan(plan.id, session.userId);
        await refreshData();
        await queueAndSync();
      }
    });

    tradeImport.addEventListener('change', async () => {
      const file = tradeImport.files?.[0];
      if (!file) return;
      clearAlert(feedback);
      tradeImportReport.classList.add('d-none');
      tradeImportReport.textContent = '';
      try {
        const analysis = await parseTradeFile(file, session.userId);
        if (!analysis.valid.length) {
          showAlert(feedback, 'warning', 'No valid rows found in file.');
          return;
        }
        let mappedCount = 0;
        const failureMap = new Map<string, ImportFailure>();
        const lowConfidenceMap = new Map<string, LowConfidenceMapping>();
        const confidenceMap = loadImportConfidence();
        analysis.valid.forEach((row) => {
          const mapped = resolveImportedSymbol(row.symbol, row.companyName);
          if (mapped.symbol && mapped.symbol !== row.symbol) {
            row.symbol = mapped.symbol;
            mappedCount += 1;
          }
          if (mapped.score !== undefined && mapped.confidence) {
            row.mappedSymbol = mapped.symbol;
            row.mappingScore = mapped.score;
            row.mappingConfidence = mapped.confidence;
            row.mappingMethod = mapped.method;
            updateImportConfidence(confidenceMap, mapped.symbol, {
              confidence: mapped.confidence,
              score: mapped.score,
              method: mapped.method || 'companyName',
              updatedAt: new Date().toISOString(),
              companyName: row.companyName
            });
            if (mapped.confidence !== 'HIGH') {
              const key = `${mapped.symbol}|${row.companyName || ''}|${mapped.confidence}`;
              const existing = lowConfidenceMap.get(key);
              if (existing) {
                existing.count += 1;
              } else {
                lowConfidenceMap.set(key, {
                  symbol: mapped.symbol,
                  companyName: row.companyName,
                  confidence: mapped.confidence,
                  score: mapped.score,
                  count: 1
                });
              }
            }
          }
          if (!mapped.mapped && mapped.reason) {
            const key = `${row.symbol}|${row.companyName || ''}|${mapped.reason}`;
            const existing = failureMap.get(key);
            if (existing) {
              existing.count += 1;
            } else {
              failureMap.set(key, {
                symbol: row.symbol,
                companyName: row.companyName,
                reason: mapped.reason,
                count: 1
              });
            }
          }
        });
        saveImportConfidence(confidenceMap);
        const { toDelete: existingDuplicates, cleanedCount } = findExistingDuplicates(trades, analysis.valid);
        const duplicateIdSet = new Set(existingDuplicates.map((trade) => trade.id));
        const dedupeBase = trades.filter((trade) => !duplicateIdSet.has(trade.id));
        const { rows: dedupedRows, duplicateCount } = dedupeImportRows(analysis.valid, dedupeBase);
        if (!dedupedRows.length && !cleanedCount) {
          renderImportReport(failureMap.size ? Array.from(failureMap.values()) : [], Array.from(lowConfidenceMap.values()));
          showAlert(feedback, 'warning', 'All rows are duplicates. No new trades imported.');
          return;
        }
        const failures = Array.from(failureMap.values());
        const lowConfidence = Array.from(lowConfidenceMap.values());
        const failedCount = failures.reduce((sum, item) => sum + item.count, 0);
        const ok = await confirmAction({
          title: 'Import Trades',
          message: `${dedupedRows.length ? `Import ${dedupedRows.length} trades from this file?` : 'No new trades found in this file.'}${
            mappedCount ? ` (${mappedCount} symbols auto-mapped)` : ''
          }${failedCount ? ` (${failedCount} trades unmapped)` : ''}${
            lowConfidence.length ? ` (${lowConfidence.length} low confidence)` : ''
          }${duplicateCount ? ` (${duplicateCount} duplicates skipped)` : ''}${
            cleanedCount ? ` (${cleanedCount} existing duplicates will be merged)` : ''
          }`,
          confirmLabel: dedupedRows.length ? 'Import' : 'Merge Duplicates'
        });
        if (!ok) return;
        if (cleanedCount) {
          await Promise.all(existingDuplicates.map((trade) => deleteTrade(trade.id, session.userId)));
        }
        if (dedupedRows.length) {
          await Promise.all(dedupedRows.map(({ companyName: _companyName, ...row }) => addTrade(row)));
        }
        await refreshData();
        await queueAndSync();
        showAlert(
          feedback,
          'success',
          dedupedRows.length
            ? `Imported ${dedupedRows.length} trades${analysis.invalid.length ? ` (${analysis.invalid.length} invalid rows skipped).` : '.'}`
            : `Merged ${cleanedCount} duplicates${analysis.invalid.length ? ` (${analysis.invalid.length} invalid rows skipped).` : '.'}`
        );
        renderImportReport(failures, lowConfidence);
        if (tradeImportLabel) {
          flashInline(tradeImportLabel, 'Imported');
        }
        appendImportAudit({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          fileName: file.name,
          totalRows: dedupedRows.length + analysis.invalid.length,
          validCount: dedupedRows.length,
          invalidCount: analysis.invalid.length,
          mappedCount,
          failedCount,
          lowConfidenceCount: lowConfidence.length,
          duplicateCount,
          cleanupCount: cleanedCount,
          status: 'imported'
        });
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
        appendImportAudit({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          fileName: file.name,
          totalRows: 0,
          validCount: 0,
          invalidCount: 0,
          mappedCount: 0,
          failedCount: 0,
          lowConfidenceCount: 0,
          status: 'failed',
          error: toErrorMessage(error)
        });
      } finally {
        tradeImport.value = '';
      }
    });

    const updateFilters = () => {
      filters = {
        query: filterQuery.value.trim(),
        from: filterFrom.value,
        to: filterTo.value
      };
      refreshList();
    };

    const today = new Date();
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - 30);
    filterFrom.value = deepFrom || fromDate.toISOString().slice(0, 10);
    filterTo.value = deepTo || today.toISOString().slice(0, 10);
    if (deepSymbol) {
      filterQuery.value = deepSymbol;
    }

    filterQuery.addEventListener('input', updateFilters);
    filterFrom.addEventListener('change', updateFilters);
    filterTo.addEventListener('change', updateFilters);
    filter30.addEventListener('click', () => {
      const now = new Date();
      const start = new Date();
      start.setDate(now.getDate() - 30);
      filterFrom.value = start.toISOString().slice(0, 10);
      filterTo.value = now.toISOString().slice(0, 10);
      updateFilters();
    });
    filterClear.addEventListener('click', () => {
      filterQuery.value = '';
      filterFrom.value = '';
      filterTo.value = '';
      updateFilters();
    });
    updateFilters();

    modalTabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tradeTab as 'form' | 'checklist';
        if (tab === 'checklist' && tradeSide.value !== 'BUY') return;
        setModalTab(tab);
      });
    });

    tradeSymbol.addEventListener('input', () => {
      updateSymbolHint();
      updatePreBuyChecklist();
    });
    tradeSide.addEventListener('change', () => {
      const isBuy = tradeSide.value === 'BUY';
      prebuyTabBtn.disabled = !isBuy;
      updatePreBuyChecklist();
      if (!isBuy) {
        setModalTab('form');
      }
    });
    tradeQty.addEventListener('input', updatePreBuyChecklist);
    tradePrice.addEventListener('input', updatePreBuyChecklist);
    tradeDate.addEventListener('change', updatePreBuyChecklist);

    const setTickerSort = (key: typeof tickerSort.key) => {
      if (tickerSort.key === key) {
        tickerSort.dir = tickerSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        tickerSort.key = key;
        tickerSort.dir = key === 'ticker' ? 'asc' : 'desc';
      }
      renderTickerRows(applyTickerSort(tickerRows));
      updateSortIcons();
    };

    root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const sortButton = target.closest<HTMLButtonElement>('[data-sort]');
      if (!sortButton) return;
      const key = sortButton.dataset.sort as typeof tickerSort.key | undefined;
      if (!key) return;
      setTickerSort(key);
    });

    priceRefresh.addEventListener('click', async () => {
      const label = priceRefresh.textContent || 'Refresh Prices';
      setBusy(priceRefresh, true, label);
      try {
        await syncNow(session);
        await refreshTickerPanels();
        showAlert(feedback, 'success', 'Live prices refreshed.');
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(priceRefresh, false, label);
      }
    });

    const updatePriceButtonState = () => {
      const offline = !navigator.onLine;
      priceRefresh.disabled = offline;
      if (offline) {
        priceRefresh.title = 'Connect to the internet to refresh prices.';
      } else {
        priceRefresh.title = '';
      }
    };
    updatePriceButtonState();
    window.addEventListener('online', updatePriceButtonState);
    window.addEventListener('offline', updatePriceButtonState);

    tickerBody.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const actionButton = target.closest<HTMLButtonElement>('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'toggle-details') {
        const row = actionButton.closest<HTMLTableRowElement>('tr');
        if (!row) return;
        row.classList.toggle('show-details');
        actionButton.textContent = row.classList.contains('show-details') ? 'Hide' : 'Details';
        return;
      }
      if (action !== 'request') return;
      const symbol = actionButton.dataset.symbol || '';
      if (!symbol) return;
      setBusy(actionButton, true, 'Request');
      try {
        const row = tickerRows.find((item) => item.symbol === symbol);
        if (row?.valid) {
          const sent = await requestMappingReview(symbol);
          if (!sent) {
            setBusy(actionButton, false, 'Request');
            return;
          }
        } else {
          await createTickerRequest({
            userId: session.userId,
            userName: session.name,
            rawSymbol: symbol,
            note: ''
          });
        }
        await refreshData();
        showAlert(feedback, 'success', `Request sent for ${symbol}.`);
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(actionButton, false, 'Request');
      }
    });

    requestSubmit.addEventListener('click', async () => {
      const symbol = normalizeSymbol(requestSymbol.value);
      if (!symbol) {
        showAlert(feedback, 'warning', 'Enter a ticker symbol.');
        return;
      }
      const label = requestSubmit.textContent || 'Send Request';
      setBusy(requestSubmit, true, label);
      try {
        await createTickerRequest({
          userId: session.userId,
          userName: session.name,
          rawSymbol: symbol,
          note: requestNote.value.trim()
        });
        requestSymbol.value = '';
        requestNote.value = '';
        await refreshData();
        showAlert(feedback, 'success', `Request sent for ${symbol}.`);
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
      } finally {
        setBusy(requestSubmit, false, label);
      }
    });

    const handleHash = () => {
      const hash = window.location.hash.replace('#', '') || 'history';
      if (hash === 'recovery' || hash === 'reentry') {
        window.location.href = 'exit-strategy.html';
        return;
      }
      if (hash === 'add-trade') {
        setTab('history');
        updateQuickNavActive('history');
        openModal();
        return;
      }
      if (hash === 'import') {
        setTab('history');
        updateQuickNavActive('history');
        tradeImport?.click();
        return;
      }
      setTab(hash);
      updateQuickNavActive(hash);
    };

    window.addEventListener('hashchange', handleHash);
    handleHash();
    await refreshData();
  })();
}


