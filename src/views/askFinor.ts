import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, showAlert } from '../ui/feedback';
import { lucideIcon } from '../ui/icons';
import { initCloudSync } from '../services/cloudSync';
import { askFinor, AskFinorRateLimitError, buildAskFinorContext, type AskFinorMessage, type AskFinorRateLimitInfo } from '../services/askFinor';
import { requireSession } from './guards';
import { formatDateTime } from '../utils/format';
import { toErrorMessage } from '../utils/errors';

const ASK_FINOR_HISTORY_PREFIX = 'ask_finor_history_v1:';
const PROMPTS = [
  'Summarize my portfolio today.',
  'Which holdings are currently in loss?',
  'Which stock did I trade most?',
  'What are my biggest expenses this month?',
  'How is my target progress right now?',
  'Show my open positions and top allocation risks.'
];

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
  return `
    <article class="ask-finor-message assistant ask-finor-message-thinking">
      <div class="ask-finor-message-head">
        <div class="ask-finor-message-role">
          ${renderFinorLogo()}
          <span>Ask Finor</span>
        </div>
        <div class="ask-finor-message-time">Thinking...</div>
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

function renderThread(messages: AskFinorMessage[], isThinking = false): string {
  if (!messages.length) {
    return `
      <div class="ask-finor-empty">
        <div class="ask-finor-empty-icon">${lucideIcon('bot')}</div>
        <div class="fw-semibold mb-1">Ask about your portfolio, trades, expenses, or targets.</div>
        <div class="text-muted small">Try one of the suggestions near the composer to get started.</div>
      </div>
    `;
  }

  const rendered = messages
    .map((message, index) => {
      const isAssistant = message.role === 'assistant';
      const previousQuestion = index > 0 ? messages[index - 1]?.content || '' : '';
      const actions = isAssistant ? guessActions(previousQuestion, message.content) : [];
      return `
        <article class="ask-finor-message ${isAssistant ? 'assistant' : 'user'}">
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

          <div class="card shadow-sm border-0 ask-finor-hero mb-3">
            <div class="card-body">
              <div class="ask-finor-hero-row">
                <div class="ask-finor-hero-copy">
                  <div class="ask-finor-eyebrow">AI Mode</div>
                  <div class="ask-finor-brand-row">
                    ${renderFinorLogo()}
                    <div>
                      <h1 class="h5 mb-1 section-title ask-finor-brand-title">Ask Finor</h1>
                      <div class="ask-finor-version">Finor v1.6</div>
                    </div>
                  </div>
                  <div class="text-muted small ask-finor-copy">
                    Ask questions about your holdings, trades, profit &amp; loss, transactions, goals, and exit strategy scenarios.
                  </div>
                </div>
                <div class="ask-finor-guardrail">
                  <div class="fw-semibold small">Grounded answers only</div>
                  <div class="text-muted small">No live market data. No buy or sell advice.</div>
                </div>
              </div>

              <div class="ask-finor-meta-row">
                <span class="ask-finor-meta-pill source">${lucideIcon('database')} App data only</span>
                <span class="ask-finor-meta-pill model">${lucideIcon('sparkles')} Gemini</span>
                <span class="ask-finor-meta-pill scope">${lucideIcon('briefcase-business')} Holdings, trades, finance, goals</span>
              </div>
            </div>
          </div>

          <div id="ask-finor-rate-limit" class="d-none"></div>

          <div class="card shadow-sm border-0 ask-finor-chat-card">
            <div class="card-body ask-finor-chat-body">
              <div class="ask-finor-chat-head">
                <div>
                  <div class="ask-finor-eyebrow">Conversation</div>
                  <h2 class="h6 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('bot')}</span>
                    Chat with your data
                  </h2>
                </div>
                <div class="d-flex gap-2">
                  <button class="btn btn-sm btn-outline-secondary" id="ask-finor-export" type="button">Export CSV</button>
                  <button class="btn btn-sm btn-outline-secondary" id="ask-finor-clear" type="button">Clear chat</button>
                </div>
              </div>

              <div class="ask-finor-thread-wrap">
                <div class="ask-finor-thread" id="ask-finor-thread"></div>
                <button class="btn btn-primary ask-finor-scroll-latest d-none" id="ask-finor-scroll-latest" type="button" aria-label="Scroll to latest message">
                  ${lucideIcon('chevron-down')}
                </button>
              </div>

              <div class="ask-finor-composer-stack">
                <div class="ask-finor-suggestion-row" aria-label="Suggested prompts">
                  ${PROMPTS.map((prompt) => `<button class="btn btn-sm btn-outline-secondary ask-finor-prompt" data-prompt="${escapeHtml(prompt)}" type="button">${prompt}</button>`).join('')}
                </div>

                <form class="ask-finor-composer" id="ask-finor-form">
                  <div class="ask-finor-composer-shell">
                    <textarea class="form-control ask-finor-textarea" id="ask-finor-question" rows="2" placeholder="Ask something like: Which holdings are currently in loss?"></textarea>
                    <div class="ask-finor-composer-bar">
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
    const composerStack = root.querySelector<HTMLDivElement>('.ask-finor-composer-stack');
    const promptButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-prompt]'));

    if (!feedback || !thread || !form || !textarea || !sendButton || !clearButton || !exportButton || !rateLimitPanel || !scrollLatestButton || !composerStack) return;

    let history = loadHistory(session.userId);
    let isThinking = false;
    let cooldownUntil = 0;
    let cooldownTimer: number | null = null;

    const scrollThreadToBottom = (behavior: ScrollBehavior = 'smooth') => {
      const lastMessage = thread.lastElementChild as HTMLElement | null;
      if (lastMessage) {
        lastMessage.scrollIntoView({ behavior, block: 'end' });
      }
      composerStack.scrollIntoView({ behavior, block: 'end' });
    };

    const updateScrollLatestButton = () => {
      const documentHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      );
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
      const hiddenDistance = documentHeight - (scrollTop + viewportHeight);
      scrollLatestButton.classList.toggle('d-none', hiddenDistance < 220);
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
            responseMs: Math.round(performance.now() - startedAt)
          }
        ];
        saveHistory(session.userId, history);
        isThinking = false;
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

    refreshThread(true);

    window.addEventListener('scroll', () => {
      updateScrollLatestButton();
    }, { passive: true });

    scrollLatestButton.addEventListener('click', () => {
      scrollThreadToBottom();
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
