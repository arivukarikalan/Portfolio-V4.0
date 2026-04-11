import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { initCloudSync } from '../services/cloudSync';
import {
  askFinor,
  AskFinorRateLimitError,
  buildAskFinorContext,
  type AskFinorContext,
  type AskFinorCard,
  type AskFinorMessage,
  type AskFinorRateLimitInfo
} from '../services/askFinor';
import { requireSession } from './guards';
import { formatDateTime } from '../utils/format';
import { toErrorMessage } from '../utils/errors';

const ASK_FINOR_HISTORY_PREFIX = 'ask_finor_history_v1:';
const PROMPT_GROUPS = [
  {
    label: 'Quick Insights',
    prompts: [
      'Summarize my portfolio today.',
      'Which holdings are currently in loss?',
      'What are my biggest expenses this month?'
    ]
  },
  {
    label: 'Portfolio Analysis',
    prompts: [
      'Show my open positions and top allocation risks.',
      'Which stock did I trade most?',
      'Show realized P&L for last 6 months.'
    ]
  },
  {
    label: 'Action / Simulation',
    prompts: ['Gold allocation in holdings', 'Sell DABUR at ₹600', 'Break-even for IRFC']
  }
] as const;

type ActionLink = {
  label: string;
  href: string;
};

type ConversationPair = {
  pairId: number;
  askedAt: string;
  question: string;
  answer: string;
  questionLength: number;
  answerLength: number;
};

type AnswerMetric = {
  label: string;
  value: string;
};

type AnswerDecor = {
  metrics: AnswerMetric[];
  pills: string[];
};

function formatResponseTime(responseMs?: number): string {
  if (!responseMs || responseMs <= 0) return '';
  if (responseMs < 1000) return `${responseMs}ms`;
  return `${(responseMs / 1000).toFixed(responseMs >= 10000 ? 0 : 1)}s`;
}

function renderFinorLogo(): string {
  return `
    <div class="ask-finor-brandmark" aria-hidden="true">
      <span class="ask-finor-brandmark-main">F</span>
      <span class="ask-finor-brandmark-dot"></span>
    </div>
  `;
}

function formatCompactInr(value: number | null | undefined): string {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '₹0';
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function classifyAssetType(symbol: string): string {
  const text = String(symbol || '').toUpperCase();
  if (/GOLD|GOLDBEES|GOLDIETF/.test(text)) return 'Gold';
  if (/LIQUID|CASH|MONEY/.test(text)) return 'Cash';
  return 'Equity';
}

function historyKey(userId: string): string {
  return `${ASK_FINOR_HISTORY_PREFIX}${userId}`;
}

function loadHistory(userId: string): AskFinorMessage[] {
  try {
    const raw = localStorage.getItem(historyKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AskFinorMessage[]).slice(-20) : [];
  } catch {
    return [];
  }
}

function saveHistory(userId: string, history: AskFinorMessage[]): void {
  localStorage.setItem(historyKey(userId), JSON.stringify(history.slice(-20)));
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMessageText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

function extractAnswerDecor(answer: string): AnswerDecor {
  const metrics: AnswerMetric[] = [];
  const pills: string[] = [];
  const text = String(answer || '').trim();

  if (/^Portfolio summary/i.test(text)) {
    const metricMatchers: Array<[RegExp, string]> = [
      [/total holdings\s+(\d+)/i, 'Holdings'],
      [/invested\s+(₹[\d,]+(?:\.\d+)?)/i, 'Invested'],
      [/current value\s+(₹[\d,]+(?:\.\d+)?)/i, 'Current Value'],
      [/unrealized p&l\s+(₹[\d,]+(?:\.\d+)?)\s+\(([+-]?\d+(?:\.\d+)?%)\)/i, 'Unrealized P&L'],
      [/realized p&l\s+(₹[\d,]+(?:\.\d+)?)/i, 'Realized P&L']
    ];
    metricMatchers.forEach(([pattern, label]) => {
      const match = text.match(pattern);
      if (!match) return;
      metrics.push({
        label,
        value: label === 'Unrealized P&L' ? `${match[1]} (${match[2]})` : match[1]
      });
    });

    const allocationMatch = text.match(/Largest allocation is\s+([A-Z0-9]+)\s+at\s+([+-]?\d+(?:\.\d+)?%)/i);
    if (allocationMatch) pills.push(`Largest: ${allocationMatch[1]} ${allocationMatch[2]}`);
    const performerMatch = text.match(/Best current performer is\s+([A-Z0-9]+)\s+at\s+([+-]?\d+(?:\.\d+)?%)/i);
    if (performerMatch) pills.push(`Best: ${performerMatch[1]} ${performerMatch[2]}`);
  }

  const rankingMatch = text.match(/^(Top net winners|Top net losers|Current holdings in profit|Current holdings in loss|Current holdings above [^.]+|Current holdings below [^.]+):\s+(.+)\.$/i);
  if (rankingMatch) {
    rankingMatch[2]
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6)
      .forEach((item) => pills.push(item));
  }

  const holdingsListMatch = text.match(/^Your current holding symbols are:\s+(.+)\.$/i);
  if (holdingsListMatch) {
    holdingsListMatch[1]
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10)
      .forEach((item) => pills.push(item));
  }

  return { metrics, pills };
}

function renderAnswerDecor(answer: string): string {
  const decor = extractAnswerDecor(answer);
  if (!decor.metrics.length && !decor.pills.length) return '';

  return `
    <div class="ask-finor-answer-decor">
      ${
        decor.metrics.length
          ? `<div class="ask-finor-metric-grid">
              ${decor.metrics
                .map(
                  (metric) => `
                    <div class="ask-finor-metric-card">
                      <div class="ask-finor-metric-label">${escapeHtml(metric.label)}</div>
                      <div class="ask-finor-metric-value">${escapeHtml(metric.value)}</div>
                    </div>
                  `
                )
                .join('')}
            </div>`
          : ''
      }
      ${
        decor.pills.length
          ? `<div class="ask-finor-pill-row">
              ${decor.pills.map((pill) => `<span class="ask-finor-answer-pill">${escapeHtml(pill)}</span>`).join('')}
            </div>`
          : ''
      }
    </div>
  `;
}

function escapeCsvCell(value: string | number): string {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildConversationPairs(messages: AskFinorMessage[]): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  let pendingQuestion: AskFinorMessage | null = null;

  messages.forEach((message) => {
    if (message.role === 'user') {
      pendingQuestion = message;
      return;
    }

    if (!pendingQuestion) return;
    pairs.push({
      pairId: pairs.length + 1,
      askedAt: pendingQuestion.createdAt,
      question: pendingQuestion.content,
      answer: message.content,
      questionLength: pendingQuestion.content.length,
      answerLength: message.content.length
    });
    pendingQuestion = null;
  });

  return pairs;
}

function buildConversationCsv(messages: AskFinorMessage[]): string {
  const pairs = buildConversationPairs(messages);
  const headers = ['pairId', 'askedAt', 'question', 'answer', 'questionLength', 'answerLength'];
  const lines = [headers.join(',')];
  pairs.forEach((pair) => {
    lines.push(
      [
        escapeCsvCell(pair.pairId),
        escapeCsvCell(pair.askedAt),
        escapeCsvCell(pair.question),
        escapeCsvCell(pair.answer),
        escapeCsvCell(pair.questionLength),
        escapeCsvCell(pair.answerLength)
      ].join(',')
    );
  });
  return lines.join('\n');
}

function downloadConversationCsv(messages: AskFinorMessage[]): void {
  const csv = buildConversationCsv(messages);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ask-finor-chat-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function guessActions(question: string, answer: string): ActionLink[] {
  const text = `${question} ${answer}`.toLowerCase();
  const actions: ActionLink[] = [];
  if (/(holding|portfolio|allocation|open position|unrealized)/.test(text)) {
    actions.push({ label: 'Open Holdings', href: 'holdings.html' });
  }
  if (/(p&l|profit|loss|winner|loser|realized|unrealized)/.test(text)) {
    actions.push({ label: 'Open P&L', href: 'pnl.html' });
  }
  if (/(transaction|expense|income|cash|finance|borrow|lent)/.test(text)) {
    actions.push({ label: 'Open Transactions', href: 'transactions.html' });
    actions.push({ label: 'Open Finance', href: 'finance.html' });
  }
  if (/(target|exit|goal|scenario)/.test(text)) {
    actions.push({ label: 'Open Target Planner', href: 'target.html' });
    actions.push({ label: 'Open Exit Strategy', href: 'exit-strategy.html' });
  }
  if (/(trade|stock|symbol|most traded)/.test(text)) {
    actions.push({ label: 'Open Trades', href: 'trades.html#history' });
  }
  return actions.filter((action, index, arr) => arr.findIndex((item) => item.href === action.href) === index).slice(0, 3);
}

function renderThinkingMessage(): string {
  const phases = ['Analyzing holdings…', 'Calculating allocation…', 'Preparing grounded answer…'];
  const phase = phases[Math.floor(Date.now() / 1000) % phases.length];
  return `
    <article class="ask-finor-message assistant ask-finor-message-thinking">
      <div class="ask-finor-message-head">
        <div class="ask-finor-message-role">
          ${renderFinorLogo()}
          <span>Ask Finor</span>
        </div>
        <div class="ask-finor-message-time">${phase}</div>
      </div>
      <div class="ask-finor-thinking">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div class="ask-finor-grounding">Reviewing your Finance App data and preparing the answer.</div>
    </article>
  `;
}

function toMetricClassName(label: string): string {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function renderCard(card: AskFinorCard): string {
  return `
    <section class="ask-finor-card ask-finor-card-${card.kind}">
      <div class="ask-finor-card-title">${escapeHtml(card.title)}</div>
      ${
        card.metrics?.length
          ? `<div class="ask-finor-card-metrics">
              ${card.metrics
                .map(
                  (metric) => `
                    <div class="ask-finor-card-metric ask-finor-card-metric-${toMetricClassName(metric.label)}">
                      <div class="ask-finor-card-metric-label">${escapeHtml(metric.label)}</div>
                      <div class="ask-finor-card-metric-value">${escapeHtml(metric.value)}</div>
                    </div>
                  `
                )
                .join('')}
            </div>`
          : ''
      }
      ${
        card.items?.length
          ? `<div class="ask-finor-card-items">
              ${card.items.map((item) => `<span class="ask-finor-card-item">${escapeHtml(item)}</span>`).join('')}
            </div>`
          : ''
      }
      ${card.note ? `<div class="ask-finor-card-note">${escapeHtml(card.note)}</div>` : ''}
    </section>
  `;
}

function renderPromptGroups(): string {
  return PROMPT_GROUPS.map(
    (group) => `
      <section class="ask-finor-suggestion-group">
        <div class="ask-finor-suggestion-group-title">${escapeHtml(group.label)}</div>
        <div class="ask-finor-suggestion-row" aria-label="${escapeHtml(group.label)}">
          ${group.prompts
            .map(
              (prompt) =>
                `<button class="btn btn-sm btn-outline-secondary ask-finor-prompt" data-prompt="${escapeHtml(prompt)}" type="button">${escapeHtml(prompt)}</button>`
            )
            .join('')}
        </div>
      </section>
    `
  ).join('');
}

function renderWorkspaceSidebar(context: AskFinorContext | null, history: AskFinorMessage[]): string {
  const recentQueries = history
    .filter((message) => message.role === 'user')
    .slice(-4)
    .reverse();

  const assetTypeCount = context
    ? new Set((context.portfolio.holdings || []).map((holding) => classifyAssetType(holding.symbol))).size
    : 0;

  return `
    <aside class="ask-finor-side-column">
      <section class="ask-finor-side-card ask-finor-side-card-snapshot">
        <div class="ask-finor-side-card-title">Portfolio Snapshot</div>
        ${
          context
            ? `
              <div class="ask-finor-side-metric-grid">
                <div class="ask-finor-side-metric">
                  <span class="label">Invested</span>
                  <span class="value">${formatCompactInr(context.portfolio.invested)}</span>
                </div>
                <div class="ask-finor-side-metric">
                  <span class="label">Current</span>
                  <span class="value">${formatCompactInr(context.portfolio.currentValue)}</span>
                </div>
                <div class="ask-finor-side-metric">
                  <span class="label">Unrealized</span>
                  <span class="value ${context.portfolio.unrealizedPnl >= 0 ? 'positive' : 'negative'}">${formatCompactInr(context.portfolio.unrealizedPnl)}</span>
                </div>
                <div class="ask-finor-side-metric">
                  <span class="label">Holdings</span>
                  <span class="value">${context.portfolio.holdingsCount}</span>
                </div>
                <div class="ask-finor-side-metric">
                  <span class="label">Asset Types</span>
                  <span class="value">${assetTypeCount || 1}</span>
                </div>
                <div class="ask-finor-side-metric">
                  <span class="label">Ready Exit</span>
                  <span class="value">${context.portfolio.readyToExitCount}</span>
                </div>
              </div>
            `
            : `<div class="ask-finor-side-empty">Preparing your current portfolio snapshot…</div>`
        }
      </section>

      <section class="ask-finor-side-card">
        <div class="ask-finor-side-card-title">Quick Actions</div>
        <div class="ask-finor-side-action-grid">
          <a class="ask-finor-side-action" href="holdings.html">Holdings</a>
          <a class="ask-finor-side-action" href="pnl.html">P&amp;L</a>
          <a class="ask-finor-side-action" href="transactions.html">Transactions</a>
          <a class="ask-finor-side-action" href="trades.html#history">Top Gainers</a>
          <a class="ask-finor-side-action" href="trades.html#history">Top Losers</a>
          <a class="ask-finor-side-action" href="holdings.html">Allocation</a>
        </div>
      </section>

      <section class="ask-finor-side-card">
        <div class="ask-finor-side-card-title">Recent Queries</div>
        ${
          recentQueries.length
            ? `<div class="ask-finor-side-query-list">
                ${recentQueries
                  .map(
                    (message) => `
                      <button class="ask-finor-side-query" data-prompt="${escapeHtml(message.content)}" type="button">
                        <span class="query-text">${escapeHtml(message.content)}</span>
                        <span class="query-time">${escapeHtml(formatDateTime(message.createdAt))}</span>
                      </button>
                    `
                  )
                  .join('')}
              </div>`
            : `<div class="ask-finor-side-empty">Your recent questions will appear here as you use Finor.</div>`
        }
      </section>
    </aside>
  `;
}

function renderThread(messages: AskFinorMessage[], isThinking = false): string {
  if (!messages.length) {
    return `
      <div class="ask-finor-empty">
        <div class="ask-finor-empty-icon">${lucideIcon('bot')}</div>
        <div class="fw-semibold mb-1">Ask about your holdings, trades, expenses, or target plan.</div>
        <div class="text-muted small">Finor will answer from your recorded Finance App data, not generic market commentary.</div>
      </div>
    `;
  }

  const rendered = messages
    .map((message, index) => {
      const isAssistant = message.role === 'assistant';
      const previousQuestion = index > 0 ? messages[index - 1]?.content || '' : '';
      const actions = isAssistant ? guessActions(previousQuestion, message.content) : [];
      const hasStructuredCards = !!(message.cards && message.cards.length);
      return `
        <article class="ask-finor-message ${isAssistant ? 'assistant' : 'user'} ${isAssistant ? `ask-finor-message-kind-${message.answerKind || 'narrative'}` : ''}">
          <div class="ask-finor-message-head">
            <div class="ask-finor-message-role">
              ${isAssistant ? renderFinorLogo() : lucideIcon('user-round')}
              <span>${isAssistant ? 'Ask Finor' : 'You'}</span>
            </div>
            <div class="ask-finor-message-time">
              ${formatDateTime(message.createdAt)}
              ${isAssistant && message.responseMs ? `<span class="ask-finor-response-time">${formatResponseTime(message.responseMs)}</span>` : ''}
            </div>
          </div>
          ${isAssistant && message.cards?.length ? `<div class="ask-finor-card-stack">${message.cards.map((card) => renderCard(card)).join('')}</div>` : ''}
          ${isAssistant && !hasStructuredCards ? renderAnswerDecor(message.content) : ''}
          <div class="ask-finor-message-body">${formatMessageText(message.content)}</div>
          ${
            isAssistant
              ? `
                <div class="ask-finor-message-foot">
                  <div class="ask-finor-grounding">Based only on your Finance App data.</div>
                  ${
                    actions.length
                      ? `<div class="ask-finor-actions">${actions
                          .map((action) => `<a class="btn btn-sm btn-outline-secondary" href="${action.href}">${action.label}</a>`)
                          .join('')}</div>`
                      : ''
                  }
                </div>
              `
              : ''
          }
        </article>
      `;
    })
    .join('');

  return rendered + (isThinking ? renderThinkingMessage() : '');
}

function renderRateLimitPanel(info: AskFinorRateLimitInfo): string {
  return `
    <div class="ask-finor-rate-limit-card">
      <div class="ask-finor-rate-limit-head">
        <div class="ask-finor-rate-limit-icon">${lucideIcon('timer-reset')}</div>
        <div>
          <div class="fw-semibold">Gemini free-tier limit reached</div>
          <div class="text-muted small">${escapeHtml(info.message)}</div>
        </div>
      </div>
      <div class="ask-finor-rate-limit-grid">
        <div class="ask-finor-rate-limit-item">
          <span class="label">Model</span>
          <span class="value">${escapeHtml(info.model || 'Gemini')}</span>
        </div>
        <div class="ask-finor-rate-limit-item">
          <span class="label">Retry After</span>
          <span class="value">${info.retryAfterSeconds ? `${info.retryAfterSeconds}s` : 'Not provided'}</span>
        </div>
        <div class="ask-finor-rate-limit-item">
          <span class="label">Reset Hint</span>
          <span class="value">${escapeHtml(info.resetHint)}</span>
        </div>
        <div class="ask-finor-rate-limit-item">
          <span class="label">Quota Note</span>
          <span class="value">${escapeHtml(info.quotaMetric || 'Free-tier rate limits vary by model and usage tier.')}</span>
        </div>
      </div>
      ${info.docsUrl ? `<a class="btn btn-sm btn-outline-secondary" href="${info.docsUrl}" target="_blank" rel="noreferrer">Open Gemini quota docs</a>` : ''}
    </div>
  `;
}

export function renderAskFinorView(root: HTMLElement): void {
  root.innerHTML = '<div class="p-4 text-muted">Loading Ask Finor...</div>';

  void (async () => {
    const session = await requireSession();
    if (!session) return;

    root.innerHTML = renderShell({
      session,
      active: 'ask-finor',
      title: 'Ask Finor',
      subtitle: 'Ask grounded questions about your app data.',
      content: `
        <div class="ask-finor-page">
          <div id="ask-finor-feedback" class="alert d-none" role="alert"></div>

          <div class="card shadow-sm border-0 ask-finor-hero mb-2">
            <div class="card-body">
              <div class="ask-finor-hero-row">
                <div class="ask-finor-hero-copy">
                  <div class="ask-finor-brand-row">
                    ${renderFinorLogo()}
                    <div class="ask-finor-hero-inline">
                      <h1 class="h5 mb-0 section-title ask-finor-brand-title">Ask Finor</h1>
                      <div class="ask-finor-version">Finor v2.0</div>
                      <div class="text-muted small ask-finor-copy">Data-first answers for holdings, P&amp;L, allocation, expenses, targets, and sell simulations.</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="ask-finor-rate-limit" class="d-none"></div>

          <div class="ask-finor-workspace">
            <div class="card shadow-sm border-0 ask-finor-chat-card">
              <div class="card-body ask-finor-chat-body">
                <div class="ask-finor-chat-shell">
                  <div class="ask-finor-chat-actions">
                    <button class="btn btn-sm btn-outline-secondary" id="ask-finor-export" type="button">Export CSV</button>
                    <button class="btn btn-sm btn-outline-secondary" id="ask-finor-clear" type="button">Clear chat</button>
                  </div>

                  <div class="ask-finor-thread-wrap">
                    <div class="ask-finor-thread" id="ask-finor-thread"></div>
                    <button class="btn btn-primary ask-finor-scroll-latest d-none" id="ask-finor-scroll-latest" type="button" aria-label="Scroll to latest message">
                      ${lucideIcon('chevron-down')}
                    </button>
                  </div>

                  <div class="ask-finor-composer-stack">
                    <button class="btn btn-sm btn-outline-secondary ask-finor-suggestion-toggle" id="ask-finor-suggestion-toggle" type="button" aria-expanded="false" aria-controls="ask-finor-suggestion-groups">
                      <span>Suggestions</span>
                      ${lucideIcon('chevron-down')}
                    </button>
                    <div class="ask-finor-suggestion-groups d-none" id="ask-finor-suggestion-groups">
                      ${renderPromptGroups()}
                    </div>

                    <form class="ask-finor-composer" id="ask-finor-form">
                      <div class="ask-finor-composer-shell">
                        <textarea class="form-control ask-finor-textarea" id="ask-finor-question" rows="2" placeholder="Ask something about your finance data…"></textarea>
                        <div class="ask-finor-composer-bar">
                          <div class="ask-finor-composer-note">Press Enter to send • Shift + Enter for a new line</div>
                          <button class="btn btn-primary ask-finor-send-btn" id="ask-finor-send" type="submit" aria-label="Send question">
                            ${lucideIcon('send')}
                            <span>Send</span>
                          </button>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>
            <div id="ask-finor-side-panel"></div>
          </div>
        </div>
      `
    });

    bindShell(root, session);
    void initCloudSync(session);

    const feedback = root.querySelector<HTMLDivElement>('#ask-finor-feedback');
    const thread = root.querySelector<HTMLDivElement>('#ask-finor-thread');
    const form = root.querySelector<HTMLFormElement>('#ask-finor-form');
    const textarea = root.querySelector<HTMLTextAreaElement>('#ask-finor-question');
    const sendButton = root.querySelector<HTMLButtonElement>('#ask-finor-send');
    const clearButton = root.querySelector<HTMLButtonElement>('#ask-finor-clear');
    const exportButton = root.querySelector<HTMLButtonElement>('#ask-finor-export');
    const rateLimitPanel = root.querySelector<HTMLDivElement>('#ask-finor-rate-limit');
    const scrollLatestButton = root.querySelector<HTMLButtonElement>('#ask-finor-scroll-latest');
    const suggestionToggle = root.querySelector<HTMLButtonElement>('#ask-finor-suggestion-toggle');
    const suggestionGroups = root.querySelector<HTMLDivElement>('#ask-finor-suggestion-groups');
    const chatBody = root.querySelector<HTMLDivElement>('.ask-finor-chat-body');
    const threadWrap = root.querySelector<HTMLDivElement>('.ask-finor-thread-wrap');
    const composerStack = root.querySelector<HTMLDivElement>('.ask-finor-composer-stack');
    const sidePanel = root.querySelector<HTMLDivElement>('#ask-finor-side-panel');
    const promptButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-prompt]'));

    if (!feedback || !thread || !form || !textarea || !sendButton || !clearButton || !exportButton || !rateLimitPanel || !scrollLatestButton || !suggestionToggle || !suggestionGroups || !chatBody || !threadWrap || !composerStack || !sidePanel) return;

    let history = loadHistory(session.userId);
    let isThinking = false;
    let latestContext: AskFinorContext | null = null;
    let cooldownUntil = 0;
    let cooldownTimer: number | null = null;
    let composerObserver: ResizeObserver | null = null;

    const scrollThreadToBottom = (behavior: ScrollBehavior = 'smooth') => {
      threadWrap.scrollTo({
        top: threadWrap.scrollHeight,
        behavior
      });
    };

    const syncComposerMetrics = () => {
      const footerHeight = Math.ceil(composerStack.getBoundingClientRect().height || composerStack.offsetHeight || 0);
      chatBody.style.setProperty('--ask-finor-footer-height', `${footerHeight}px`);
    };

    const updateScrollLatestButton = () => {
      const hiddenDistance = threadWrap.scrollHeight - (threadWrap.scrollTop + threadWrap.clientHeight);
      scrollLatestButton.classList.toggle('d-none', hiddenDistance < 140);
    };

    const refreshSidebar = () => {
      sidePanel.innerHTML = renderWorkspaceSidebar(latestContext, history);
      Array.from(sidePanel.querySelectorAll<HTMLElement>('[data-prompt]')).forEach((button) => {
        button.addEventListener('click', () => {
          const prompt = button.dataset.prompt || '';
          textarea.value = prompt;
          void runQuestion(prompt);
        });
      });
    };

    const clearCooldown = () => {
      cooldownUntil = 0;
      if (cooldownTimer !== null) {
        window.clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      textarea.disabled = false;
      sendButton.disabled = false;
      textarea.value = '';
      textarea.placeholder = 'Ask something like: Which holdings are currently in loss?';
      promptButtons.forEach((button) => {
        button.disabled = false;
      });
      textarea.focus();
    };

    const applyCooldown = (info: AskFinorRateLimitInfo) => {
      const seconds = Math.max(1, Number(info.retryAfterSeconds || 10));
      cooldownUntil = Date.now() + seconds * 1000;
      textarea.disabled = true;
      sendButton.disabled = true;
      promptButtons.forEach((button) => {
        button.disabled = true;
      });

      const updateCooldownText = () => {
        const remainingMs = cooldownUntil - Date.now();
        if (remainingMs <= 0) {
          clearCooldown();
          return;
        }
        const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
        textarea.value = `Gemini rate limit reached. Try again in ${remainingSeconds}s. Refresh page to unlock now.`;
      };

      updateCooldownText();
      if (cooldownTimer !== null) {
        window.clearInterval(cooldownTimer);
      }
      cooldownTimer = window.setInterval(updateCooldownText, 250);
    };

    const hideRateLimitPanel = () => {
      rateLimitPanel.classList.add('d-none');
      rateLimitPanel.innerHTML = '';
    };

    const showRateLimitPanel = (info: AskFinorRateLimitInfo) => {
      rateLimitPanel.innerHTML = renderRateLimitPanel(info);
      rateLimitPanel.classList.remove('d-none');
    };

    const refreshThread = (forceScroll = false) => {
      thread.innerHTML = renderThread(history, isThinking);
      requestAnimationFrame(() => {
        syncComposerMetrics();
        if (forceScroll) {
          scrollThreadToBottom('smooth');
        }
        updateScrollLatestButton();
      });
    };

    const runQuestion = async (question: string) => {
      const cleanQuestion = question.trim();
      if (!cleanQuestion) return;
      if (cooldownUntil > Date.now()) return;
      clearAlert(feedback);
      hideRateLimitPanel();
      const userMessage: AskFinorMessage = {
        role: 'user',
        content: cleanQuestion,
        createdAt: new Date().toISOString()
      };
      history = [...history, userMessage];
      refreshThread(true);
      textarea.value = '';
      isThinking = true;
      refreshThread(true);
      sendButton.disabled = true;
      textarea.disabled = true;
      clearButton.disabled = true;
      exportButton.disabled = true;
      promptButtons.forEach((button) => {
        button.disabled = true;
      });

      try {
        const startedAt = performance.now();
        const context = await buildAskFinorContext(session.userId, session.name);
        latestContext = context;
        const response = await askFinor({
          userId: session.userId,
          question: cleanQuestion,
          context,
          conversation: history
        });
        history = [
          ...history,
          {
            role: 'assistant',
            content: response.answer,
            createdAt: new Date().toISOString(),
            responseMs: Math.round(performance.now() - startedAt),
            answerKind: response.answerKind,
            cards: response.cards,
            clarification: response.clarification,
            resolvedQuery: response.resolvedQuery
          }
        ];
        saveHistory(session.userId, history);
        isThinking = false;
        refreshSidebar();
        refreshThread(true);
      } catch (error) {
        history = history.slice(0, -1);
        isThinking = false;
        refreshThread(false);
        if (error instanceof AskFinorRateLimitError) {
          showRateLimitPanel(error.info);
          showAlert(feedback, 'warning', error.info.message);
          applyCooldown(error.info);
        } else {
          showAlert(feedback, 'danger', toErrorMessage(error));
        }
      } finally {
        isThinking = false;
        refreshThread(false);
        clearButton.disabled = false;
        exportButton.disabled = false;
        if (cooldownUntil <= Date.now()) {
          sendButton.disabled = false;
          textarea.disabled = false;
          promptButtons.forEach((button) => {
            button.disabled = false;
          });
          textarea.focus();
        }
      }
    };

    try {
      latestContext = await buildAskFinorContext(session.userId, session.name);
    } catch {
      latestContext = null;
    }

    refreshSidebar();
    refreshThread(true);
    syncComposerMetrics();

    if ('ResizeObserver' in window) {
      composerObserver = new ResizeObserver(() => {
        syncComposerMetrics();
        updateScrollLatestButton();
      });
      composerObserver.observe(composerStack);
    }

    threadWrap.addEventListener('scroll', () => {
      updateScrollLatestButton();
    }, { passive: true });

    window.addEventListener('resize', () => {
      syncComposerMetrics();
      updateScrollLatestButton();
    }, { passive: true });

    scrollLatestButton.addEventListener('click', () => {
      scrollThreadToBottom();
    });

    suggestionToggle.addEventListener('click', () => {
      const isHidden = suggestionGroups.classList.toggle('d-none');
      suggestionToggle.setAttribute('aria-expanded', String(!isHidden));
      suggestionToggle.classList.toggle('is-open', !isHidden);
      syncComposerMetrics();
      updateScrollLatestButton();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void runQuestion(textarea.value);
    });

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void runQuestion(textarea.value);
      }
    });

    clearButton.addEventListener('click', () => {
      history = [];
      saveHistory(session.userId, history);
      refreshSidebar();
      refreshThread(true);
    });

    exportButton.addEventListener('click', () => {
      const pairs = buildConversationPairs(history);
      if (!pairs.length) {
        showAlert(feedback, 'warning', 'No completed Q&A pairs available to export yet.');
        return;
      }
      downloadConversationCsv(history);
      showAlert(feedback, 'success', `Exported ${pairs.length} chat pairs to CSV.`);
    });

    promptButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const prompt = button.dataset.prompt || '';
        textarea.value = prompt;
        void runQuestion(prompt);
      });
    });
  })();
}
