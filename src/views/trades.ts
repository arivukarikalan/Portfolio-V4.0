import * as XLSX from 'xlsx';
import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { renderConfirmModal, bindConfirmModal } from '../ui/confirm';
import { addTrade, deleteTrade, listTrades, updateTrade, type TradeInput } from '../storage/trades';
import { getUserSettings } from '../storage/settings';
import type { TradeRecord, TradeSide } from '../core/types';
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
import { requireSession } from './guards';
import { formatAmount, formatDate, formatDateTime, formatMoney, formatPct, coerceNumber } from '../utils/format';
import { nameInitials, normalizeName, normalizeSymbol, stripSeriesSuffix } from '../utils/symbols';
import { computeCurrentCycleState } from '../utils/tradeCycles';
import { getOverrideSymbol, setOverrideSymbol } from '../storage/mappingOverrides';

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

type TradeDisplay =
  | { kind: 'single'; trade: TradeRecord }
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
      companyName: companyName || undefined
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
          companyName: companyName || undefined
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
          companyName: companyName || undefined
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
      companyName: companyName || undefined
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

function renderTableRows(trades: TradeRecord[]): string {
  if (!trades.length) {
    return '<tr><td colspan="7" class="text-muted text-center py-3">No trades yet.</td></tr>';
  }

  const display = groupTradesForDisplay(trades);
  return display
    .map((row) => {
      if (row.kind === 'single') {
        const trade = row.trade;
        const sideBadge = trade.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
        return `
          <tr data-trade-id="${trade.id}">
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

function renderCardRows(trades: TradeRecord[]): string {
  if (!trades.length) {
    return '<div class="text-muted text-center py-3">No trades yet.</div>';
  }

  const display = groupTradesForDisplay(trades);
  return display
    .map((row) => {
      if (row.kind === 'single') {
        const trade = row.trade;
        const sideBadge = trade.side === 'BUY' ? 'text-bg-success' : 'text-bg-danger';
        return `
          <div class="card trade-card shadow-sm border-0" data-trade-id="${trade.id}">
            <div class="card-body d-flex flex-column gap-2">
              <div class="d-flex justify-content-between">
                <div>
                  <div class="fw-semibold">${trade.symbol}</div>
                  <div class="text-muted small">${formatDate(trade.tradeDate)}</div>
                </div>
                <div class="text-end">
                  <span class="badge ${sideBadge}">${trade.side}</span>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-3 small">
                <div><span class="text-muted">Qty:</span> ${trade.quantity}</div>
                <div><span class="text-muted">Entry:</span> ${formatMoney(trade.price)}</div>
                <div><span class="text-muted">Amount:</span> ${formatAmount(trade.quantity, trade.price)}</div>
              </div>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary flex-grow-1" data-action="edit">Edit</button>
                <button class="btn btn-sm btn-outline-danger flex-grow-1" data-action="delete">Delete</button>
              </div>
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
          <div class="card-body d-flex flex-column gap-2">
            <div class="d-flex justify-content-between">
              <div>
                <div class="fw-semibold">${row.symbol} <span class="badge text-bg-light border">Fills ${fillCount}</span></div>
                <div class="text-muted small">${formatDate(row.tradeDate)}</div>
              </div>
              <div class="text-end">
                <span class="badge ${sideBadge}">${row.side}</span>
              </div>
            </div>
            <div class="d-flex flex-wrap gap-3 small">
              <div><span class="text-muted">Qty:</span> ${row.quantity}</div>
              <div><span class="text-muted">Entry:</span> ${formatMoney(row.price)}</div>
              <div><span class="text-muted">Amount:</span> ${formatMoney(row.amount)}</div>
            </div>
            <div class="d-flex gap-2">
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
  const map = new Map<string, TradeDisplay>();
  const order: string[] = [];
  trades.forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    const price = Number(trade.price);
    const key = `${trade.tradeDate}|${symbol}|${trade.side}|${Number.isFinite(price) ? price.toFixed(2) : ''}`;
    const existing = map.get(key);
    if (!existing) {
      const entry: TradeDisplay = {
        kind: 'group',
        key,
        symbol: trade.symbol,
        side: trade.side,
        tradeDate: trade.tradeDate,
        quantity: 0,
        price: 0,
        amount: 0,
        trades: []
      };
      map.set(key, entry);
      order.push(key);
    }
    const group = map.get(key) as Extract<TradeDisplay, { kind: 'group' }>;
    group.trades.push(trade);
    group.quantity += trade.quantity;
    group.amount += trade.quantity * trade.price;
    group.price = group.quantity > 0 ? group.amount / group.quantity : trade.price;
  });

  return order.map((key) => {
    const group = map.get(key) as Extract<TradeDisplay, { kind: 'group' }>;
    if (group.trades.length === 1) {
      return { kind: 'single', trade: group.trades[0] };
    }
    return group;
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
  trades.forEach((trade) => {
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
    const initialTab = window.location.hash.replace('#', '') || (deepSymbol ? 'history' : 'history');
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
        <div id="trade-feedback" class="alert d-none" role="alert"></div>

        <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h1 class="h5 mb-1 section-title">
              <span class="section-icon">${lucideIcon('repeat')}</span>
              Trades
            </h1>
            <div class="text-muted small">Track positions, outcomes, and quick performance stats.</div>
          </div>
          <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-primary" id="trade-add">${lucideIcon('plus')} Add Trade</button>
            <label class="btn btn-outline-secondary mb-0">
              ${lucideIcon('upload')} Import File
              <input type="file" id="trade-import" accept=".csv,.xlsx,.xls" hidden />
            </label>
          </div>
          <div id="trade-import-report" class="alert alert-warning d-none mt-2" role="alert"></div>
        </div>

        <div class="row g-3 mb-3">
          <div class="col-6 col-lg-3">
            <div class="card shadow-sm border-0 h-100">
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
            <div class="card shadow-sm border-0 h-100">
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
            <div class="card shadow-sm border-0 h-100">
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
            <div class="card shadow-sm border-0 h-100">
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
          <div class="card shadow-sm border-0 mb-3">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 ticker-header">
                <div>
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
              <div class="card shadow-sm border-0">
                <div class="card-body">
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
              <div class="card shadow-sm border-0">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-center mb-3 request-header">
                    <h2 class="h6 mb-0 section-title">
                      <span class="section-icon">${lucideIcon('clipboard-list')}</span>
                      My Ticker Requests
                    </h2>
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
          <div class="card shadow-sm border-0 mb-3">
            <div class="card-body">
              <div class="row g-2 align-items-end mb-3">
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
              <div class="d-flex justify-content-between align-items-center mb-2">
                <h2 class="h6 mb-0 section-title">
                  <span class="section-icon">${lucideIcon('history')}</span>
                  Trade History
                </h2>
                <div class="text-muted small" id="trade-count">--</div>
              </div>
              <div class="table-responsive d-none d-md-block">
                <table class="table table-sm align-middle trade-table mb-0">
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
              <div class="d-md-none d-flex flex-column gap-2" id="trade-card-list"></div>
            </div>
          </div>
        </section>

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
    let importConfidence = loadImportConfidence();
    let userSettings = await getUserSettings(session.userId);
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
        btn.classList.toggle('active', btn.dataset.quickId === name);
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

    const resolveImportedSymbol = (rawSymbol: string, companyName?: string) => {
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
      const total = trades.length;
      const buys = trades.filter((trade) => trade.side === 'BUY').length;
      const sells = trades.filter((trade) => trade.side === 'SELL').length;
      const amounts = trades
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
      tradeTableBody.innerHTML = renderTableRows(filtered);
      tradeCardList.innerHTML = renderCardRows(filtered);
      tradeCount.textContent = `${filtered.length} of ${trades.length} trades`;
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
      const [list, masterRows, requests, settings] = await Promise.all([
        listTrades(session.userId),
        listNseMasterForUser(session.userId),
        listTickerRequests(session.userId),
        getUserSettings(session.userId)
      ]);
      trades = list;
      nseMasterRows = masterRows;
      nseSymbols = new Set(masterRows.map((row) => normalizeSymbol(row.symbol)));
      tickerRequests = requests;
      userSettings = settings;
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
        const failures = Array.from(failureMap.values());
        const lowConfidence = Array.from(lowConfidenceMap.values());
        const failedCount = failures.reduce((sum, item) => sum + item.count, 0);
        const ok = await confirmAction({
          title: 'Import Trades',
          message: `Import ${analysis.valid.length} trades from this file?${
            mappedCount ? ` (${mappedCount} symbols auto-mapped)` : ''
          }${failedCount ? ` (${failedCount} trades unmapped)` : ''}${
            lowConfidence.length ? ` (${lowConfidence.length} low confidence)` : ''
          }`,
          confirmLabel: 'Import'
        });
        if (!ok) return;
        await Promise.all(analysis.valid.map(({ companyName: _companyName, ...row }) => addTrade(row)));
        await refreshData();
        await queueAndSync();
        showAlert(
          feedback,
          'success',
          `Imported ${analysis.valid.length} trades${analysis.invalid.length ? ` (${analysis.invalid.length} invalid rows skipped).` : '.'}`
        );
        renderImportReport(failures, lowConfidence);
      } catch (error) {
        showAlert(feedback, 'danger', toErrorMessage(error));
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
      const tab = window.location.hash.replace('#', '') || 'history';
      setTab(tab);
      updateQuickNavActive(tab);
    };

    window.addEventListener('hashchange', handleHash);
    handleHash();
    await refreshData();
  })();
}

