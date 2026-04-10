import { renderShell, bindShell } from '../ui/shell';
import { clearAlert, setBusy, showAlert } from '../ui/feedback';
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

function renderThread(messages: AskFinorMessage[]): string {
  if (!messages.length) {
    return `
      <div class="ask-finor-empty">
        <div class="ask-finor-empty-icon">${lucideIcon('bot')}</div>
        <div class="fw-semibold mb-1">Ask about your portfolio, trades, expenses, or targets.</div>
        <div class="text-muted small">Try one of the prompt chips above to get started.</div>
      </div>
    `;
  }

  return messages
    .map((message, index) => {
      const isAssistant = message.role === 'assistant';
      const previousQuestion = index > 0 ? messages[index - 1]?.content || '' : '';
      const actions = isAssistant ? guessActions(previousQuestion, message.content) : [];
      return `
        <article class="ask-finor-message ${isAssistant ? 'assistant' : 'user'}">
          <div class="ask-finor-message-head">
            <div class="ask-finor-message-role">
              ${isAssistant ? lucideIcon('bot') : lucideIcon('user-round')}
              <span>${isAssistant ? 'Ask Finor' : 'You'}</span>
            </div>
            <div class="ask-finor-message-time">${formatDateTime(message.createdAt)}</div>
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
              <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
                <div>
                  <div class="ask-finor-eyebrow">AI Mode</div>
                  <h1 class="h5 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('message-square')}</span>
                    Ask Finor
                  </h1>
                  <div class="text-muted small ask-finor-copy">
                    Ask questions about your holdings, trades, profit &amp; loss, transactions, goals, and exit strategy scenarios.
                  </div>
                </div>
                <div class="ask-finor-guardrail">
                  <div class="fw-semibold small">Grounded answers only</div>
                  <div class="text-muted small">No live market data. No buy or sell advice.</div>
                </div>
              </div>

              <div class="ask-finor-meta-row mt-3">
                <span class="ask-finor-meta-pill source">${lucideIcon('database')} App data only</span>
                <span class="ask-finor-meta-pill model">${lucideIcon('sparkles')} Gemini</span>
                <span class="ask-finor-meta-pill scope">${lucideIcon('briefcase-business')} Holdings, trades, finance, goals</span>
              </div>

              <div class="ask-finor-prompt-row mt-3">
                ${PROMPTS.map((prompt) => `<button class="btn btn-sm btn-outline-secondary ask-finor-prompt" data-prompt="${escapeHtml(prompt)}" type="button">${prompt}</button>`).join('')}
              </div>
            </div>
          </div>

          <div id="ask-finor-rate-limit" class="d-none"></div>

          <div class="card shadow-sm border-0 ask-finor-chat-card">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center gap-2 mb-3">
                <div>
                  <div class="ask-finor-eyebrow">Conversation</div>
                  <h2 class="h6 mb-1 section-title">
                    <span class="section-icon">${lucideIcon('bot')}</span>
                    Chat with your data
                  </h2>
                </div>
                <button class="btn btn-sm btn-outline-secondary" id="ask-finor-clear" type="button">Clear chat</button>
              </div>

              <div class="ask-finor-thread" id="ask-finor-thread"></div>

              <form class="ask-finor-composer" id="ask-finor-form">
                <label class="form-label small text-muted" for="ask-finor-question">Question</label>
                <textarea class="form-control ask-finor-textarea" id="ask-finor-question" rows="3" placeholder="Ask something like: Which holdings are currently in loss?"></textarea>
                <div class="ask-finor-composer-actions">
                  <div class="text-muted small">Answers are generated from your stored app data snapshot on this device.</div>
                  <button class="btn btn-primary" id="ask-finor-send" type="submit">
                    ${lucideIcon('send')} Ask Finor
                  </button>
                </div>
              </form>
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
    const rateLimitPanel = root.querySelector<HTMLDivElement>('#ask-finor-rate-limit');
    const promptButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-prompt]'));

    if (!feedback || !thread || !form || !textarea || !sendButton || !clearButton || !rateLimitPanel) return;

    let history = loadHistory(session.userId);

    const hideRateLimitPanel = () => {
      rateLimitPanel.classList.add('d-none');
      rateLimitPanel.innerHTML = '';
    };

    const showRateLimitPanel = (info: AskFinorRateLimitInfo) => {
      rateLimitPanel.innerHTML = renderRateLimitPanel(info);
      rateLimitPanel.classList.remove('d-none');
    };

    const refreshThread = () => {
      thread.innerHTML = renderThread(history);
      thread.scrollTop = thread.scrollHeight;
    };

    const runQuestion = async (question: string) => {
      const cleanQuestion = question.trim();
      if (!cleanQuestion) return;
      clearAlert(feedback);
      hideRateLimitPanel();
      const userMessage: AskFinorMessage = {
        role: 'user',
        content: cleanQuestion,
        createdAt: new Date().toISOString()
      };
      history = [...history, userMessage];
      refreshThread();
      textarea.value = '';
      setBusy(sendButton, true, 'Ask Finor');
      textarea.disabled = true;
      clearButton.disabled = true;
      promptButtons.forEach((button) => {
        button.disabled = true;
      });

      try {
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
            createdAt: new Date().toISOString()
          }
        ];
        saveHistory(session.userId, history);
        refreshThread();
      } catch (error) {
        history = history.slice(0, -1);
        refreshThread();
        if (error instanceof AskFinorRateLimitError) {
          showRateLimitPanel(error.info);
          showAlert(feedback, 'warning', error.info.message);
        } else {
          showAlert(feedback, 'danger', toErrorMessage(error));
        }
      } finally {
        setBusy(sendButton, false, 'Ask Finor');
        textarea.disabled = false;
        clearButton.disabled = false;
        promptButtons.forEach((button) => {
          button.disabled = false;
        });
        textarea.focus();
      }
    };

    refreshThread();

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
      refreshThread();
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
