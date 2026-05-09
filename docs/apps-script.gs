const SPREADSHEET_ID = getSpreadsheetId();
const USERS_SHEET = 'Users';
const PENDING_USERS_SHEET = 'PendingUsers';
const SNAPSHOTS_SHEET = 'Snapshots';
const USER_SESSIONS_SHEET = 'UserSessions';
const ADMIN_SESSIONS_SHEET = 'AdminSessions';
const ADMIN_CONFIG_SHEET = 'AdminConfig';
const TICKER_REQUESTS_SHEET = 'TickerRequests';
const NSE_MASTER_SHEET = 'NSEMaster';
const HYBRID_DAILY_RETENTION_DAYS = 30;
const HYBRID_MONTHLY_RETENTION_MONTHS = 12;

function doGet(e) {
  const mode = String(e.parameter.mode || '').trim();
  if (mode === 'pull') return jsonResponse(handlePull(e));
  return jsonResponse({ ok: false, message: 'Unsupported GET mode' });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return jsonResponse({ ok: false, message: 'Invalid JSON body' });
  }

  const mode = String(body.mode || '').trim();
  if (mode === 'login') return jsonResponse(handleLogin(body));
  if (mode === 'register_user') return jsonResponse(handleRegisterUser(body));
  if (mode === 'list_pending') return jsonResponse(handleListPending(body));
  if (mode === 'approve_user') return jsonResponse(handleApproveUser(body));
  if (mode === 'reject_user') return jsonResponse(handleRejectUser(body));
  if (mode === 'list_users') return jsonResponse(handleListUsers(body));
  if (mode === 'update_user') return jsonResponse(handleUpdateUser(body));
  if (mode === 'get_admin_config') return jsonResponse(handleGetAdminConfig(body));
  if (mode === 'get_public_config') return jsonResponse(handleGetPublicConfig(body));
  if (mode === 'set_admin_config') return jsonResponse(handleSetAdminConfig(body));
  if (mode === 'trim_snapshots') return jsonResponse(handleTrimSnapshots(body));
  if (mode === 'list_snapshots') return jsonResponse(handleListSnapshots(body));
  if (mode === 'restore_snapshot') return jsonResponse(handleRestoreSnapshot(body));
  if (mode === 'push') return jsonResponse(handlePush(body));
  if (mode === 'list_nse_master') return jsonResponse(handleListNseMaster(body));
  if (mode === 'list_nse_master_user') return jsonResponse(handleListNseMasterUser(body));
  if (mode === 'replace_nse_master') return jsonResponse(handleReplaceNseMaster(body));
  if (mode === 'list_ticker_requests') return jsonResponse(handleListTickerRequests(body));
  if (mode === 'list_ticker_requests_admin') return jsonResponse(handleListTickerRequestsAdmin(body));
  if (mode === 'create_ticker_request') return jsonResponse(handleCreateTickerRequest(body));
  if (mode === 'resolve_ticker_request') return jsonResponse(handleResolveTickerRequest(body));
  if (mode === 'live_prices') return jsonResponse(handleLivePrices(body));
  if (mode === 'price_history') return jsonResponse(handlePriceHistory(body));
  if (mode === 'ask_finor') return jsonResponse(handleAskFinor(body));

  return jsonResponse({ ok: false, message: 'Unsupported POST mode' });
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getGeminiApiKey() {
  return String(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '').trim();
}

function getGeminiModel() {
  return String(PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash').trim();
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function parseRetryDelaySeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.ceil(parsed) : null;
}

function parseGeminiRateLimitInfo(bodyText, model) {
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText || '{}');
  } catch (err) {
    parsed = null;
  }

  const error = parsed && parsed.error ? parsed.error : {};
  const details = Array.isArray(error.details) ? error.details : [];
  let retryAfterSeconds = null;
  let quotaMetric = null;
  let docsUrl = null;

  details.forEach(function (detail) {
    if (!detail || typeof detail !== 'object') return;
    const type = String(detail['@type'] || '');
    if (type.indexOf('RetryInfo') !== -1) {
      retryAfterSeconds = retryAfterSeconds || parseRetryDelaySeconds(detail.retryDelay);
    }
    if (type.indexOf('QuotaFailure') !== -1) {
      const violations = Array.isArray(detail.violations) ? detail.violations : [];
      violations.forEach(function (violation) {
        if (!quotaMetric && violation && violation.description) {
          quotaMetric = String(violation.description);
        }
      });
    }
    if (type.indexOf('Help') !== -1) {
      const links = Array.isArray(detail.links) ? detail.links : [];
      links.forEach(function (link) {
        if (!docsUrl && link && link.url) {
          docsUrl = String(link.url);
        }
      });
    }
  });

  if (!retryAfterSeconds) {
    retryAfterSeconds = parseRetryDelaySeconds(String(error.message || ''));
  }

  return {
    provider: 'gemini',
    model: model,
    retryAfterSeconds: retryAfterSeconds,
    resetHint: 'Free-tier daily quota usually resets around midnight Pacific time.',
    quotaMetric: quotaMetric,
    docsUrl: docsUrl,
    message: retryAfterSeconds
      ? 'Gemini rate limit reached. Try again in about ' + retryAfterSeconds + ' seconds.'
      : 'Gemini rate limit reached. Please wait a bit and try again.'
  };
}

function stringifyContext(value, maxChars) {
  let text = '';
  try {
    text = JSON.stringify(value || {});
  } catch (err) {
    text = '{}';
  }
  return truncateText(text, maxChars || 90000);
}

function extractGeminiText(payload) {
  if (!payload) return '';
  const output = Array.isArray(payload.candidates) ? payload.candidates : [];
  const chunks = [];
  output.forEach(function (item) {
    const content = item && item.content && Array.isArray(item.content.parts) ? item.content.parts : [];
    content.forEach(function (part) {
      if (typeof part.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    });
  });
  return chunks.join('\n\n').trim();
}

function handleAskFinor(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;

  const apiKey = getGeminiApiKey();
  const model = getGeminiModel();
  if (!apiKey) {
    return { ok: false, message: 'GEMINI_API_KEY is missing in Apps Script Script Properties' };
  }

  const question = String(body.question || '').trim();
  if (!question) return { ok: false, message: 'Question is required' };

  const context = body.context && typeof body.context === 'object' ? body.context : {};
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  const deterministicAnswer = normalizeAnswerPayload(
    buildDeterministicAskFinorAnswerV2(question, context, conversation) || buildDeterministicAskFinorAnswer(question, context, conversation),
    'unsupported_query',
    'conversation'
  );
  if (deterministicAnswer) {
    return {
      ok: true,
      data: {
        answer: deterministicAnswer.answer,
        model: 'deterministic-finance-rules'
        ,
        answerKind: deterministicAnswer.answerKind,
        cards: deterministicAnswer.cards,
        clarification: deterministicAnswer.clarification,
        resolvedQuery: deterministicAnswer.resolvedQuery
      }
    };
  }

  const transcript = conversation
    .slice(-6)
    .map(function (message) {
      const role = String(message.role || 'user').toUpperCase();
      return role + ': ' + truncateText(String(message.content || '').trim(), 800);
    })
    .join('\n');

  const instructions = [
    'You are Ask Finor, a portfolio-aware assistant inside Finance App.',
    'Answer only from the provided Finance App JSON context and the recent conversation.',
    'Do not use live market knowledge, news, or outside facts.',
    'Do not give buy, sell, hold, or timing advice.',
    'If the user asks for unsupported live or predictive advice, say you can only summarize Finance App data.',
    'Use Indian rupees only. Never use dollars or any other currency symbol.',
    'When you mention money, format it as INR or ₹.',
    'Use exact numbers from context when possible.',
    'If data is missing, say that clearly instead of guessing.',
    'Keep the answer concise and practical.'
  ].join(' ');

  const inputText =
    'User question:\n' +
    question +
    '\n\nRecent conversation:\n' +
    (transcript || 'No prior conversation.') +
    '\n\nFinance App data context (JSON):\n' +
    stringifyContext(context, 90000);

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'System instructions:\n' +
              instructions +
              '\n\n' +
              inputText
          }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: 520,
      temperature: 0.25
    }
  };

  let response;
  try {
    response = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-goog-api-key': apiKey
        },
        muteHttpExceptions: true,
        payload: JSON.stringify(payload)
      }
    );
  } catch (err) {
    return { ok: false, message: 'Gemini request failed: ' + err.message };
  }

  const status = response.getResponseCode();
  const bodyText = response.getContentText();
  if (status === 429) {
    return { ok: false, message: 'ASK_FINOR_RATE_LIMIT::' + JSON.stringify(parseGeminiRateLimitInfo(bodyText, model)) };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, message: 'Gemini request failed (' + status + '): ' + truncateText(bodyText, 400) };
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return { ok: false, message: 'Gemini returned invalid JSON' };
  }

  const answer = extractGeminiText(parsed);
  if (!answer) {
    return { ok: false, message: 'Ask Finor could not generate an answer' };
  }

  return {
    ok: true,
    data: {
      answer: answer,
      model: model,
      answerKind: 'narrative',
      cards: [],
      clarification: null,
      resolvedQuery: makeResolvedQuery(
        'unsupported_query',
        'conversation',
        [],
        makeDateRangePayload(buildDateWindowFromText(String(question || '').trim().toLowerCase())),
        null,
        makeConfidence(0.45, 0, 0.3, 0.3),
        'narrative'
      )
    }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function getSpreadsheetId() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Missing SPREADSHEET_ID in Script Properties');
  return id;
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const values = sheet.getDataRange().getValues();
  if (!values.length) {
    sheet.appendRow(headers);
  } else {
    const existing = values[0].map(function (h) { return String(h || '').trim(); });
    const same = headers.every(function (h, i) { return existing[i] === h; });
    if (!same) {
      sheet.clearContents();
      sheet.appendRow(headers);
    }
  }
  return sheet;
}

function normalizeLoginId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSymbol(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const FINOR_SYMBOL_ALIASES = {
  WAAREE: 'WAAREERTL',
  WAAREERTL: 'WAAREERTL',
  DABURINDIA: 'DABUR',
  DABUR: 'DABUR',
  COLGATE: 'COLPAL',
  COLPAL: 'COLPAL',
  HINDUSTANAERONAUTICS: 'HAL',
  HAL: 'HAL',
  RELIANCEINDUSTRIES: 'RELIANCE',
  RELIANCE: 'RELIANCE',
  GOLDBEES: 'GOLDBEES',
  GOLDIETF: 'GOLDIETF',
  GOLDETF: 'GOLDIETF'
};

function normalizeLooseText(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getQuestionTokens(question) {
  var normalized = normalizeLooseText(question);
  return normalized ? normalized.split(' ') : [];
}

function resolveAliasSymbolCandidates(question) {
  var collapsed = normalizeSymbol(question);
  var tokens = getQuestionTokens(question);
  var matches = [];
  var pushMatch = function (value) {
    if (!value) return;
    if (matches.indexOf(value) === -1) matches.push(value);
  };

  for (var key in FINOR_SYMBOL_ALIASES) {
    var aliasTarget = FINOR_SYMBOL_ALIASES[key];
    if (collapsed === key || collapsed.indexOf(key) >= 0 || key.indexOf(collapsed) >= 0) {
      pushMatch(aliasTarget);
    }
  }

  tokens.forEach(function (token) {
    var compact = normalizeSymbol(token);
    if (!compact) return;
    if (FINOR_SYMBOL_ALIASES[compact]) pushMatch(FINOR_SYMBOL_ALIASES[compact]);
    for (var alias in FINOR_SYMBOL_ALIASES) {
      if (alias.indexOf(compact) === 0 || compact.indexOf(alias) === 0) {
        pushMatch(FINOR_SYMBOL_ALIASES[alias]);
      }
    }
  });

  return matches;
}

function scoreSymbolMatch(question, symbol) {
  var normalizedQuestion = normalizeLooseText(question);
  var compactQuestion = normalizeSymbol(question);
  var compactSymbol = normalizeSymbol(symbol);
  if (!compactSymbol) return 0;

  var best = 0;
  var exactPattern = new RegExp('(^|[^A-Z0-9])' + escapeRegex(compactSymbol) + '([^A-Z0-9]|$)');
  if (exactPattern.test(compactQuestion)) best = Math.max(best, 120);
  if (compactQuestion === compactSymbol) best = Math.max(best, 125);

  var aliasCandidates = resolveAliasSymbolCandidates(question);
  if (aliasCandidates.indexOf(compactSymbol) >= 0) best = Math.max(best, 110);

  var tokens = getQuestionTokens(question);
  tokens.forEach(function (token) {
    var compactToken = normalizeSymbol(token);
    if (!compactToken) return;
    if (compactToken === compactSymbol) best = Math.max(best, 105);
    if (compactSymbol.indexOf(compactToken) >= 0 && compactToken.length >= 4) best = Math.max(best, 84);
    if (compactToken.indexOf(compactSymbol) >= 0 && compactSymbol.length >= 4) best = Math.max(best, 82);
    if (compactToken.length >= 4 && compactSymbol.length >= 4) {
      var shared = 0;
      while (
        shared < compactToken.length &&
        shared < compactSymbol.length &&
        compactToken.charAt(shared) === compactSymbol.charAt(shared)
      ) {
        shared += 1;
      }
      if (shared >= 4) best = Math.max(best, 70 + shared);
    }
  });

  if (normalizedQuestion.indexOf(symbol) >= 0) best = Math.max(best, 95);
  return best;
}

function resolveBestCandidate(question, rows, getSymbol) {
  var bestRow = null;
  var bestScore = 0;
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var symbol = String(getSymbol(row) || '').trim();
    if (!symbol) continue;
    var score = scoreSymbolMatch(question, symbol);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore >= 80 ? bestRow : null;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatInr(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '₹0.00';
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPctNumber(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0.00%';
  const sign = num > 0 ? '+' : '';
  return sign + num.toFixed(2) + '%';
}

function makeConfidence(intent, entity, dateRange, metric) {
  return {
    intent: Number(intent || 0),
    entity: Number(entity || 0),
    dateRange: Number(dateRange || 0),
    metric: Number(metric || 0)
  };
}

function makeResolvedEntity(symbol, kind, confidence) {
  if (!symbol) return null;
  return {
    symbol: String(symbol),
    confidence: Number(confidence || 0),
    kind: kind || 'stock'
  };
}

function makeDateRangePayload(window) {
  if (!window) return null;
  return {
    label: String(window.label || ''),
    fromDate: String(window.fromDate || ''),
    toDate: window.toDate ? String(window.toDate) : null
  };
}

function makeResolvedQuery(intent, domain, entities, dateRange, metric, confidence, resultType) {
  return {
    intent: intent,
    domain: domain,
    entities: (entities || []).filter(Boolean),
    dateRange: makeDateRangePayload(dateRange),
    metric: metric || null,
    confidence: confidence || makeConfidence(0, 0, 0, 0),
    resultType: resultType || 'narrative'
  };
}

function makeCard(kind, title, metrics, items, note) {
  return {
    kind: kind,
    title: title,
    metrics: Array.isArray(metrics) ? metrics : [],
    items: Array.isArray(items) ? items : [],
    note: note || ''
  };
}

function makeAnswerPayload(answer, options) {
  var config = options || {};
  return {
    answer: String(answer || ''),
    answerKind: config.answerKind || 'narrative',
    cards: Array.isArray(config.cards) ? config.cards : [],
    clarification: config.clarification || null,
    resolvedQuery: config.resolvedQuery || null
  };
}

function makeClarificationPayload(message, suggestions, resolvedQuery) {
  return makeAnswerPayload(message, {
    answerKind: 'clarification',
    clarification: {
      message: message,
      suggestions: suggestions || []
    },
    cards: [
      makeCard('clarification', 'Need a little more direction', [], suggestions || [], message)
    ],
    resolvedQuery: resolvedQuery || null
  });
}

function buildPortfolioSummaryCard(context) {
  var portfolio = getPortfolioContext(context);
  var pnl = context && context.pnl ? context.pnl : {};
  var topHolding = Array.isArray(portfolio.topHoldings) && portfolio.topHoldings.length ? portfolio.topHoldings[0] : null;
  var topGainer = getContextHoldings(context)
    .slice()
    .sort(function (a, b) { return Number(b.unrealizedPnlPct || 0) - Number(a.unrealizedPnlPct || 0); })[0] || null;
  return makeCard(
    'portfolio_summary',
    'Portfolio snapshot',
    [
      { label: 'Holdings', value: String(Number(portfolio.holdingsCount || 0)) },
      { label: 'Invested', value: formatInr(portfolio.invested) },
      { label: 'Current Value', value: formatInr(portfolio.currentValue) },
      { label: 'Unrealized P&L', value: formatInr(portfolio.unrealizedPnl) + ' (' + formatPctNumber(portfolio.unrealizedPnlPct) + ')' },
      { label: 'Realized P&L', value: formatInr(pnl.realizedPnl) }
    ],
    [],
    (topHolding ? 'Largest allocation: ' + topHolding.symbol + '. ' : '') +
      (topGainer ? 'Best performer: ' + topGainer.symbol + '.' : '')
  );
}

function buildRankingCard(title, items, note) {
  return makeCard('ranking', title, [], items || [], note || '');
}

function buildHoldingDetailCard(holding) {
  if (!holding) return null;
  return makeCard(
    'holding_detail',
    holding.symbol + ' holding detail',
    [
      { label: 'Quantity', value: String(Number(holding.qty || 0)) },
      { label: 'Avg Buy', value: formatInr(holding.avgBuy) },
      { label: 'Current Value', value: formatInr(holding.currentValue) },
      { label: 'Unrealized P&L', value: formatInr(holding.unrealizedPnl) + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ')' },
      { label: 'Allocation', value: formatPctNumber(holding.allocationPct).replace('+', '') },
      { label: 'Break-even', value: formatInr(holding.breakEvenSellPrice) }
    ],
    [],
    'Target sell price: ' + formatInr(holding.targetSellPrice)
  );
}

function buildSimulationCard(holding, context, sellPrice) {
  if (!holding) return null;
  var qty = Number(holding.qty || 0);
  var sellRate = Number(context && context.settings ? context.settings.sellBrokeragePct || 0 : 0);
  var dpCharge = Number(context && context.settings ? context.settings.dpCharge || 0 : 0);
  var effectiveInvested = Number(holding.effectiveInvested || holding.invested || 0);
  var grossValue = qty * sellPrice;
  var charges = grossValue * (sellRate / 100) + dpCharge;
  var netValue = grossValue - charges;
  var profit = netValue - effectiveInvested;
  var returnPct = effectiveInvested > 0 ? (profit / effectiveInvested) * 100 : 0;
  return makeCard(
    'simulation',
    holding.symbol + ' sell simulation',
    [
      { label: 'Sell Price', value: formatInr(sellPrice) },
      { label: 'Quantity', value: String(qty) },
      { label: 'Gross Value', value: formatInr(grossValue) },
      { label: 'Estimated Charges', value: formatInr(charges) },
      { label: 'Net Proceeds', value: formatInr(netValue) },
      { label: 'Estimated Return', value: formatPctNumber(returnPct) }
    ],
    [],
    'Cost basis: ' + formatInr(effectiveInvested) + '. Estimated P&L: ' + formatInr(profit) + '.'
  );
}

function isShortFollowup(text) {
  return /^(same like|same|details|detail|summary|target price|target|break even|breakeven|avg price|average price|quantity|qty|realized only|unrealized only|names only|top \d+|current holdings only)$/i.test(
    String(text || '').trim()
  );
}

function normalizeAnswerPayload(result, fallbackIntent, fallbackDomain) {
  if (!result) return null;
  if (typeof result === 'string') {
    return makeAnswerPayload(result, {
      resolvedQuery: makeResolvedQuery(
        fallbackIntent || 'unsupported_query',
        fallbackDomain || 'conversation',
        [],
        null,
        null,
        makeConfidence(0.7, 0, 0, 0),
        'narrative'
      )
    });
  }
  return result;
}

function findHoldingFromQuestion(question, context) {
  const holdings =
    context && context.portfolio && Array.isArray(context.portfolio.holdings) ? context.portfolio.holdings : [];
  return resolveBestCandidate(question, holdings, function (holding) {
    return holding && holding.symbol;
  });
}

function findHoldingFromConversation(conversation, context) {
  if (!Array.isArray(conversation) || !conversation.length) return null;
  for (var i = conversation.length - 1; i >= 0; i -= 1) {
    var message = conversation[i];
    var content = String(message && message.content ? message.content : '').trim();
    if (!content) continue;
    var holding = findHoldingFromQuestion(content, context);
    if (holding) return holding;
  }
  return null;
}

function getContextHoldings(context) {
  return context && context.portfolio && Array.isArray(context.portfolio.holdings) ? context.portfolio.holdings : [];
}

function formatHoldingDetail(holding, context) {
  return (
    holding.symbol +
    ' holding summary: quantity ' +
    Number(holding.qty || 0) +
    ', average buy ' +
    formatInr(holding.avgBuy) +
    ', LTP ' +
    formatInr(holding.ltp) +
    ', invested ' +
    formatInr(holding.invested) +
    ', current value ' +
    formatInr(holding.currentValue) +
    ', unrealized P&L ' +
    formatInr(holding.unrealizedPnl) +
    ' (' +
    formatPctNumber(holding.unrealizedPnlPct) +
    '). Target sell price is ' +
    formatInr(holding.targetSellPrice) +
    ' and break-even sell price is ' +
    formatInr(holding.breakEvenSellPrice) +
    '.'
  );
}

function extractPercentThreshold(text) {
  var patterns = [
    /(?:above|more than|greater than|over)\s*(-?\d+(?:\.\d+)?)\s*%/,
    /(?:below|less than|under)\s*(-?\d+(?:\.\d+)?)\s*%/,
    /(-?\d+(?:\.\d+)?)\s*%\s*(?:return|profit|gain|loss)/
  ];
  for (var i = 0; i < patterns.length; i += 1) {
    var match = text.match(patterns[i]);
    if (match) {
      var parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function buildHoldingsListAnswer(context, includeDetails) {
  var holdings = getContextHoldings(context);
  if (!holdings.length) {
    return 'You do not have any current holdings in the app right now.';
  }
  var sorted = holdings.slice().sort(function (a, b) {
    return Number(b.currentValue || 0) - Number(a.currentValue || 0);
  });
  if (includeDetails) {
    return (
      'Your current holdings are: ' +
      sorted
        .map(function (holding) {
          return (
            holding.symbol +
            ' (' +
            Number(holding.qty || 0) +
            ' qty, ' +
            formatPctNumber(holding.unrealizedPnlPct) +
            ')'
          );
        })
        .join(', ') +
      '.'
    );
  }
  return 'Your current holding symbols are: ' + sorted.map(function (holding) { return holding.symbol; }).join(', ') + '.';
}

function buildFilteredHoldingsAnswer(context, mode, threshold) {
  var holdings = getContextHoldings(context);
  if (!holdings.length) {
    return 'You do not have any current holdings in the app right now.';
  }

  var filtered = holdings.filter(function (holding) {
    var pct = Number(holding.unrealizedPnlPct || 0);
    if (mode === 'profit') return pct > 0;
    if (mode === 'loss') return pct < 0;
    if (mode === 'above') return pct > Number(threshold || 0);
    if (mode === 'below') return pct < Number(threshold || 0);
    return false;
  });

  filtered.sort(function (a, b) {
    return Number(b.unrealizedPnlPct || 0) - Number(a.unrealizedPnlPct || 0);
  });

  if (!filtered.length) {
    if (mode === 'profit') return 'None of your current holdings are in profit right now.';
    if (mode === 'loss') return 'None of your current holdings are in loss right now.';
    if (mode === 'above') return 'No current holdings are above ' + formatPctNumber(threshold).replace('+', '') + '.';
    if (mode === 'below') return 'No current holdings are below ' + formatPctNumber(threshold) + '.';
  }

  if (mode === 'profit') {
    return (
      'Current holdings in profit: ' +
      filtered
        .map(function (holding) {
          return holding.symbol + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ', ' + formatInr(holding.unrealizedPnl) + ')';
        })
        .join(', ') +
      '.'
    );
  }

  if (mode === 'loss') {
    return (
      'Current holdings in loss: ' +
      filtered
        .map(function (holding) {
          return holding.symbol + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ', ' + formatInr(holding.unrealizedPnl) + ')';
        })
        .join(', ') +
      '.'
    );
  }

  if (mode === 'above') {
    return (
      'Current holdings above ' +
      formatPctNumber(threshold).replace('+', '') +
      ': ' +
      filtered
        .map(function (holding) {
          return holding.symbol + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ', ' + formatInr(holding.unrealizedPnl) + ')';
        })
        .join(', ') +
      '.'
    );
  }

  return (
    'Current holdings below ' +
    formatPctNumber(threshold) +
    ': ' +
    filtered
      .map(function (holding) {
        return holding.symbol + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ', ' + formatInr(holding.unrealizedPnl) + ')';
      })
      .join(', ') +
    '.'
  );
}

function getTradeContext(context) {
  return context && context.trades ? context.trades : {};
}

function getFinanceContext(context) {
  return context && context.finance ? context.finance : {};
}

function getTradeSummaries(context) {
  var trades = getTradeContext(context);
  return Array.isArray(trades.stockSummaries) ? trades.stockSummaries : Array.isArray(trades.mostTradedSymbols) ? trades.mostTradedSymbols : [];
}

function findTradeSummaryFromQuestion(question, context) {
  var summaries = getTradeSummaries(context);
  return resolveBestCandidate(question, summaries, function (summary) {
    return summary && summary.symbol;
  });
}

function findTradeSummaryFromConversation(conversation, context) {
  if (!Array.isArray(conversation) || !conversation.length) return null;
  for (var i = conversation.length - 1; i >= 0; i -= 1) {
    var message = conversation[i];
    var content = String(message && message.content ? message.content : '').trim();
    if (!content) continue;
    var summary = findTradeSummaryFromQuestion(content, context);
    if (summary) return summary;
  }
  return null;
}

function buildMostTradedAnswer(context) {
  var top = getTradeSummaries(context);
  if (!top.length) return 'I do not see enough trade data to determine your most traded stock yet.';
  var first = top[0];
  return (
    'Your most traded stock is ' +
    first.symbol +
    ' with ' +
    Number(first.tradeCount || 0) +
    ' trades. Buy trades: ' +
    Number(first.buyCount || 0) +
    ', sell trades: ' +
    Number(first.sellCount || 0) +
    ', net P&L: ' +
    formatInr(first.netPnl) +
    '.'
  );
}

function buildTopPnlAnswer(context, mode, limit) {
  var source =
    mode === 'winner'
      ? context && context.pnl && Array.isArray(context.pnl.topNetWinners) ? context.pnl.topNetWinners : []
      : context && context.pnl && Array.isArray(context.pnl.topNetLosers) ? context.pnl.topNetLosers : [];
  var topLimit = Math.max(1, Number(limit || 5));
  if (!source.length) {
    return mode === 'winner'
      ? 'I do not see any net winners in the current app summary.'
      : 'I do not see any net losers in the current app summary.';
  }
  return (
    (mode === 'winner' ? 'Top net winners: ' : 'Top net losers: ') +
    source
      .slice(0, topLimit)
      .map(function (row) {
        return row.symbol + ' (' + formatInr(row.netPnl) + ')';
      })
      .join(', ') +
    '.'
  );
}

function buildRecentTradesAnswer(summary, context) {
  var trades = getTradeContext(context);
  var recentTrades = Array.isArray(trades.recentTrades) ? trades.recentTrades : [];
  var symbol = normalizeSymbol(summary && summary.symbol);
  var filtered = recentTrades.filter(function (row) {
    return normalizeSymbol(row && row.symbol) === symbol;
  });

  if (!filtered.length) {
    return (
      'I do not see recent trade rows for ' +
      symbol +
      ' in the current Ask Finor summary. Trade summary available: ' +
      Number(summary.tradeCount || 0) +
      ' trades, buy quantity ' +
      Number(summary.buyQty || 0) +
      ', sell quantity ' +
      Number(summary.sellQty || 0) +
      ', net P&L ' +
      formatInr(summary.netPnl) +
      '.'
    );
  }

  return (
    'Recent trades for ' +
    symbol +
    ': ' +
    filtered
      .slice(0, 5)
      .map(function (row) {
        return row.date + ' ' + row.side + ' ' + Number(row.quantity || 0) + ' @ ' + formatInr(row.price);
      })
      .join(', ') +
    '.'
  );
}

function buildTradeSummaryAnswer(summary) {
  return (
    summary.symbol +
    ' trade summary: total trades ' +
    Number(summary.tradeCount || 0) +
    ', buy trades ' +
    Number(summary.buyCount || 0) +
    ', sell trades ' +
    Number(summary.sellCount || 0) +
    ', buy quantity ' +
    Number(summary.buyQty || 0) +
    ', sell quantity ' +
    Number(summary.sellQty || 0) +
    ', realized P&L ' +
    formatInr(summary.realizedPnl) +
    ', unrealized P&L ' +
    formatInr(summary.unrealizedPnl) +
    ', net P&L ' +
    formatInr(summary.netPnl) +
    '.'
  );
}

function buildExpenseCategoryAnswer(context, currentMonthOnly) {
  var finance = getFinanceContext(context);
  var list = currentMonthOnly
    ? Array.isArray(finance.thisMonthTopExpenseCategories) ? finance.thisMonthTopExpenseCategories : []
    : Array.isArray(finance.topExpenseCategories) ? finance.topExpenseCategories : [];
  if (!list.length) {
    return currentMonthOnly
      ? 'I do not see any expense categories recorded for this month.'
      : 'I do not see any expense category data in the current app summary.';
  }
  var first = list[0];
  return (
    (currentMonthOnly ? 'Your biggest expense category this month is ' : 'Your biggest expense category is ') +
    first.category +
    ' at ' +
    formatInr(first.amount) +
    '.'
  );
}

function getRealizedHistory(context) {
  var trades = getTradeContext(context);
  return Array.isArray(trades.realizedHistory) ? trades.realizedHistory : [];
}

function extractSellPrice(text) {
  var match = text.match(/(?:sell(?:ed)?\s+at|sold\s+at|at)\s*₹?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  var parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveSellPriceFromQuestion(text, holding) {
  var explicit = extractSellPrice(text);
  if (Number.isFinite(explicit)) return explicit;
  if (!holding) return null;
  if (/target price|target sell price/.test(text)) {
    var target = Number(holding.targetSellPrice || 0);
    return Number.isFinite(target) && target > 0 ? target : null;
  }
  if (/break.?even/.test(text)) {
    var breakEven = Number(holding.breakEvenSellPrice || 0);
    return Number.isFinite(breakEven) && breakEven > 0 ? breakEven : null;
  }
  return null;
}

function buildWhatIfSellAnswer(holding, context, sellPrice) {
  var qty = Number(holding.qty || 0);
  var sellRate = Number(context && context.settings ? context.settings.sellBrokeragePct || 0 : 0);
  var dpCharge = Number(context && context.settings ? context.settings.dpCharge || 0 : 0);
  var effectiveInvested = Number(holding.effectiveInvested || holding.invested || 0);
  var grossValue = qty * sellPrice;
  var netValue = grossValue * (1 - sellRate / 100) - dpCharge;
  var profit = netValue - effectiveInvested;
  return (
    'If you sell ' +
    holding.symbol +
    ' at ' +
    formatInr(sellPrice) +
    ' per share for ' +
    qty +
    ' shares, your estimated net result after configured sell charges would be ' +
    formatInr(profit) +
    '. Gross sell value would be ' +
    formatInr(grossValue) +
    ' and estimated net sell value would be ' +
    formatInr(netValue) +
    '.'
  );
}

function buildProfitLossAnalysisAnswer(context, periodLabel, fromDate, toDate) {
  var realized = getRealizedHistory(context).filter(function (entry) {
    var date = String(entry && entry.date || '');
    return date >= fromDate && (!toDate || date <= toDate);
  });
  if (!realized.length) {
    return 'I do not see any booked profit or loss entries for ' + periodLabel + '.';
  }
  var profit = 0;
  var loss = 0;
  realized.forEach(function (entry) {
    var pnl = Number(entry && entry.pnl || 0);
    if (pnl > 0) profit += pnl;
    if (pnl < 0) loss += Math.abs(pnl);
  });
  return (
    'Your booked profit/loss for ' +
    periodLabel +
    ': profit ' +
    formatInr(profit) +
    ', loss ' +
    formatInr(loss) +
    ', net ' +
    formatInr(profit - loss) +
    '.'
  );
}

function buildGreetingAnswer(text) {
  if (/^(hi|hello|hey|hii|helo)\b/.test(text)) {
    return 'Hi. Ask me about your holdings, trades, profit and loss, expenses, or targets, and I will answer from your Finance App data.';
  }
  if (/(^|\b)(thank you|thanks|thx)\b/.test(text)) {
    return 'You are welcome. Ask anything else about your Finance App data whenever you want.';
  }
  if (/(^|\b)(bye|goodbye|see you|ok bye)\b/.test(text)) {
    return 'Bye. Come back anytime if you want another summary from your Finance App data.';
  }
  return null;
}

function findAllHoldingsFromQuestion(question, context) {
  var holdings = getContextHoldings(context);
  var matches = [];
  for (var i = 0; i < holdings.length; i += 1) {
    var holding = holdings[i];
    if (scoreSymbolMatch(question, holding && holding.symbol) >= 80) matches.push(holding);
  }
  return matches;
}

function buildHoldingComparisonAnswer(holdings) {
  if (!holdings || holdings.length < 2) return null;
  var first = holdings[0];
  var second = holdings[1];
  return (
    first.symbol +
    ': qty ' +
    Number(first.qty || 0) +
    ', avg buy ' +
    formatInr(first.avgBuy) +
    ', current value ' +
    formatInr(first.currentValue) +
    ', unrealized P&L ' +
    formatInr(first.unrealizedPnl) +
    ' (' +
    formatPctNumber(first.unrealizedPnlPct) +
    '). ' +
    second.symbol +
    ': qty ' +
    Number(second.qty || 0) +
    ', avg buy ' +
    formatInr(second.avgBuy) +
    ', current value ' +
    formatInr(second.currentValue) +
    ', unrealized P&L ' +
    formatInr(second.unrealizedPnl) +
    ' (' +
    formatPctNumber(second.unrealizedPnlPct) +
    ').'
  );
}

function startOfTodayIso() {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString().slice(0, 10);
}

function isoDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function monthWindow(year, monthIndex) {
  return {
    fromDate: isoDateOnly(new Date(year, monthIndex, 1)),
    toDate: isoDateOnly(new Date(year, monthIndex + 1, 0)),
    monthKey: year + '-' + String(monthIndex + 1).padStart(2, '0')
  };
}

function detectMonthIndex(text) {
  var names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (var i = 0; i < names.length; i += 1) {
    if (new RegExp('(?:in|for)\\s+' + names[i] + '(?:\\b|\\s+month)').test(text)) {
      return i;
    }
  }
  return null;
}

function buildDateWindowFromText(text) {
  var now = new Date();
  var monthRangeMatch = text.match(/last\s+(\d+)\s+months?/);
  if (monthRangeMatch) {
    var monthCount = Number(monthRangeMatch[1]);
    if (Number.isFinite(monthCount) && monthCount > 0) {
      var rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
      rangeStart.setMonth(rangeStart.getMonth() - (monthCount - 1));
      return {
        label: 'the last ' + monthCount + ' months',
        fromDate: isoDateOnly(rangeStart),
        toDate: isoDateOnly(now),
        monthKey: null
      };
    }
  }

  if (/last 30 days/.test(text)) {
    return {
      label: 'the last 30 days',
      fromDate: isoDateOnly(shiftDate(now, -29)),
      toDate: isoDateOnly(now),
      monthKey: null
    };
  }

  if (/this month/.test(text)) {
    var current = monthWindow(now.getFullYear(), now.getMonth());
    return {
      label: 'this month',
      fromDate: current.fromDate,
      toDate: current.toDate,
      monthKey: current.monthKey
    };
  }

  if (/last month/.test(text)) {
    var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var previous = monthWindow(lastMonth.getFullYear(), lastMonth.getMonth());
    return {
      label: 'last month',
      fromDate: previous.fromDate,
      toDate: previous.toDate,
      monthKey: previous.monthKey
    };
  }

  var monthIndex = detectMonthIndex(text);
  if (monthIndex !== null) {
    var year = now.getFullYear();
    if (monthIndex > now.getMonth()) year -= 1;
    var named = monthWindow(year, monthIndex);
    var label = named.monthKey === String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0')
      ? 'this month'
      : new Date(year, monthIndex, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    return {
      label: label,
      fromDate: named.fromDate,
      toDate: named.toDate,
      monthKey: named.monthKey
    };
  }

  return null;
}

function getPortfolioContext(context) {
  return context && context.portfolio ? context.portfolio : {};
}

function classifyHoldingAssetGroup(holding) {
  var symbol = normalizeSymbol(holding && holding.symbol);
  var raw = String(holding && holding.symbol || '').toUpperCase();
  if (/GOLD|GOLDBEES|GOLDIETF|GOLDETf|GOLD ETF/.test(raw) || /GOLD/.test(symbol)) return 'gold';
  if (/CASH|LIQUID|LIQUIDBEES|MONEY|SAVINGS/.test(raw) || /CASH/.test(symbol) || /LIQUID/.test(symbol)) return 'cash';
  return 'equity';
}

function getHoldingsByAssetGroup(context, group) {
  return getContextHoldings(context).filter(function (holding) {
    return classifyHoldingAssetGroup(holding) === group;
  });
}

function buildCategoryAllocationAnswer(context, groupLabel, holdings) {
  if (!holdings.length) {
    return 'I do not see any ' + groupLabel + '-related holdings in your current portfolio.';
  }
  var portfolio = getPortfolioContext(context);
  var invested = holdings.reduce(function (sum, holding) { return sum + Number(holding.invested || 0); }, 0);
  var currentValue = holdings.reduce(function (sum, holding) { return sum + Number(holding.currentValue || 0); }, 0);
  var totalCurrentValue = Number(portfolio.currentValue || 0);
  var allocationPct = totalCurrentValue > 0 ? (currentValue / totalCurrentValue) * 100 : 0;
  return (
    groupLabel.charAt(0).toUpperCase() +
    groupLabel.slice(1) +
    ' allocation in your current holdings is ' +
    formatPctNumber(allocationPct).replace('+', '') +
    ', with invested amount ' +
    formatInr(invested) +
    ' and current value ' +
    formatInr(currentValue) +
    '. Holdings: ' +
    holdings.map(function (holding) { return holding.symbol; }).join(', ') +
    '.'
  );
}

function buildSingleHoldingAllocationAnswer(holding) {
  return (
    holding.symbol +
    ' allocation in your current holdings is ' +
    formatPctNumber(holding.allocationPct).replace('+', '') +
    '. Invested amount is ' +
    formatInr(holding.invested) +
    ' and current value is ' +
    formatInr(holding.currentValue) +
    '.'
  );
}

function buildTopAllocationRisksAnswer(context) {
  var holdings = getContextHoldings(context)
    .slice()
    .sort(function (a, b) { return Number(b.allocationPct || 0) - Number(a.allocationPct || 0); })
    .slice(0, 5);
  if (!holdings.length) {
    return 'I do not see any current holdings to analyze for allocation risk.';
  }
  return (
    'Top allocation risks in your current holdings: ' +
    holdings
      .map(function (holding) {
        return holding.symbol + ' (' + formatPctNumber(holding.allocationPct).replace('+', '') + ', ' + formatInr(holding.currentValue) + ')';
      })
      .join(', ') +
    '.'
  );
}

function buildOpenPositionsAnswer(context) {
  var holdings = getContextHoldings(context)
    .slice()
    .sort(function (a, b) { return Number(b.currentValue || 0) - Number(a.currentValue || 0); });
  if (!holdings.length) {
    return 'You do not have any open positions in the app right now.';
  }
  return (
    'Your open positions: ' +
    holdings
      .slice(0, 8)
      .map(function (holding) {
        return holding.symbol + ' (' + Number(holding.qty || 0) + ' qty, ' + formatInr(holding.currentValue) + ', ' + formatPctNumber(holding.unrealizedPnlPct) + ')';
      })
      .join(', ') +
    '.'
  );
}

function buildOpenPositionsAndRiskAnswer(context) {
  var portfolio = getPortfolioContext(context);
  return (
    buildOpenPositionsAnswer(context) +
    ' ' +
    'You currently hold ' +
    Number(portfolio.holdingsCount || 0) +
    ' stocks. ' +
    buildTopAllocationRisksAnswer(context)
  );
}

function buildPortfolioSummaryAnswer(context, periodLabel) {
  var portfolio = getPortfolioContext(context);
  var pnl = context && context.pnl ? context.pnl : {};
  var topHolding = Array.isArray(portfolio.topHoldings) && portfolio.topHoldings.length ? portfolio.topHoldings[0] : null;
  var topGainer = getContextHoldings(context)
    .slice()
    .sort(function (a, b) { return Number(b.unrealizedPnlPct || 0) - Number(a.unrealizedPnlPct || 0); })[0] || null;
  return (
    'Portfolio summary' +
    (periodLabel ? ' for ' + periodLabel : '') +
    ': total holdings ' +
    Number(portfolio.holdingsCount || 0) +
    ', invested ' +
    formatInr(portfolio.invested) +
    ', current value ' +
    formatInr(portfolio.currentValue) +
    ', unrealized P&L ' +
    formatInr(portfolio.unrealizedPnl) +
    ' (' +
    formatPctNumber(portfolio.unrealizedPnlPct) +
    ')' +
    ', realized P&L ' +
    formatInr(pnl.realizedPnl) +
    '. ' +
    (topHolding ? 'Largest allocation is ' + topHolding.symbol + ' at ' + formatPctNumber(topHolding.allocationPct).replace('+', '') + '. ' : '') +
    (topGainer ? 'Best current performer is ' + topGainer.symbol + ' at ' + formatPctNumber(topGainer.unrealizedPnlPct) + '.' : '')
  );
}

function buildRealizedNamesAnswer(context, mode, window) {
  var rows = getRealizedHistory(context);
  if (window) {
    rows = rows.filter(function (entry) {
      var date = String(entry && entry.date || '');
      return date >= window.fromDate && date <= window.toDate;
    });
  }
  var totals = {};
  rows.forEach(function (entry) {
    var symbol = normalizeSymbol(entry && entry.symbol);
    if (!symbol) return;
    totals[symbol] = (totals[symbol] || 0) + Number(entry && entry.pnl || 0);
  });
  var symbols = Object.keys(totals).filter(function (symbol) {
    return mode === 'profit' ? totals[symbol] > 0 : totals[symbol] < 0;
  });
  symbols.sort(function (a, b) {
    return mode === 'profit' ? totals[b] - totals[a] : totals[a] - totals[b];
  });
  if (!symbols.length) {
    return mode === 'profit'
      ? 'I do not see any realized profit-making stocks' + (window ? ' for ' + window.label : '') + '.'
      : 'I do not see any realized loss-making stocks' + (window ? ' for ' + window.label : '') + '.';
  }
  return (
    'Realized ' +
    (mode === 'profit' ? 'profit' : 'loss') +
    ' stock names' +
    (window ? ' for ' + window.label : '') +
    ': ' +
    symbols.join(', ') +
    '.'
  );
}

function buildCapabilitiesAnswer() {
  return 'You can ask me about portfolio summary, open positions, holdings, allocation, top risks, realized and unrealized profit/loss, date-range sell history, most traded stocks, expenses, and sell simulations based on your Finance App data.';
}

function extractTopLimit(text) {
  var match = text.match(/top\s+(\d+)/);
  if (!match) return null;
  var parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildTradeRealizedOnlyAnswer(summary) {
  return (
    summary.symbol +
    ' realized P&L from your transaction history is ' +
    formatInr(summary.realizedPnl) +
    ' across ' +
    Number(summary.sellCount || 0) +
    ' sell trades.'
  );
}

function buildHoldingUnrealizedOnlyAnswer(holding) {
  return (
    holding.symbol +
    ' unrealized P&L in your current holdings is ' +
    formatInr(holding.unrealizedPnl) +
    ' (' +
    formatPctNumber(holding.unrealizedPnlPct) +
    ') with current value ' +
    formatInr(holding.currentValue) +
    '.'
  );
}

function getPreviousUserMessages(conversation, currentQuestion) {
  if (!Array.isArray(conversation) || !conversation.length) return [];
  var current = String(currentQuestion || '').trim();
  var currentNormalized = normalizeLooseText(current);
  var skippedCurrent = false;
  var messages = [];
  for (var i = conversation.length - 1; i >= 0; i -= 1) {
    var row = conversation[i];
    if (!row || String(row.role || '') !== 'user') continue;
    var content = String(row.content || '').trim();
    if (!content) continue;
    var normalized = normalizeLooseText(content);
    if (!skippedCurrent && normalized === currentNormalized) {
      skippedCurrent = true;
      continue;
    }
    messages.push(content);
  }
  return messages;
}

function buildCorrectionFollowupAnswer(question, context, conversation) {
  var text = String(question || '').trim().toLowerCase();
  if (!/(^|\b)(no|not that|i mean|realized only|unrealized only|current holdings only|names only|details|summary|top \d+)\b/.test(text)) {
    return null;
  }

  var previousMessages = getPreviousUserMessages(conversation, question);
  var previousQuestion = previousMessages.length ? previousMessages[0] : '';
  var previousText = String(previousQuestion || '').trim().toLowerCase();
  if (!previousText) {
    return 'I may have misunderstood. Tell me the exact metric you want, like realized loss names, current holdings, or stock details.';
  }

  var previousWindow = buildDateWindowFromText(previousText);
  var currentWindow = buildDateWindowFromText(text);
  var activeWindow = currentWindow || previousWindow;
  var previousHolding = findHoldingFromQuestion(previousQuestion, context) || findHoldingFromConversation(conversation, context);
  var previousTradeSummary =
    findTradeSummaryFromQuestion(previousQuestion, context) || findTradeSummaryFromConversation(conversation, context);
  var topLimit = extractTopLimit(text);

  if (/realized only/.test(text)) {
    if (/loss/.test(previousText) && /(stock|name|loser)/.test(previousText)) {
      return buildRealizedNamesAnswer(context, 'loss', activeWindow);
    }
    if (/profit|winner/.test(previousText) && /(stock|name|winner)/.test(previousText)) {
      return buildRealizedNamesAnswer(context, 'profit', activeWindow);
    }
    if (previousTradeSummary) return buildTradeRealizedOnlyAnswer(previousTradeSummary);
    if (activeWindow) return buildProfitLossAnalysisAnswer(context, activeWindow.label, activeWindow.fromDate, activeWindow.toDate);
    return 'I can show realized results from your transaction history. Tell me the stock name or the date range you want.';
  }

  if (/unrealized only/.test(text)) {
    if (previousHolding) return buildHoldingUnrealizedOnlyAnswer(previousHolding);
    if (/loss/.test(previousText)) return buildFilteredHoldingsAnswer(context, 'loss', null);
    if (/profit/.test(previousText)) return buildFilteredHoldingsAnswer(context, 'profit', null);
    return 'I can show unrealized results from your current holdings. Tell me the stock name or the holdings filter you want.';
  }

  if (/current holdings only/.test(text)) {
    return buildHoldingsListAnswer(context, false);
  }

  if (/names only/.test(text)) {
    if (/realized/.test(previousText) && /loss/.test(previousText)) return buildRealizedNamesAnswer(context, 'loss', activeWindow);
    if (/realized/.test(previousText) && /profit|winner/.test(previousText)) return buildRealizedNamesAnswer(context, 'profit', activeWindow);
    if (/holding|portfolio|position/.test(previousText)) return buildHoldingsListAnswer(context, false);
  }

  if (/top \d+/.test(text)) {
    if (/loss|loser|worst/.test(previousText)) return buildTopPnlAnswer(context, 'loser', topLimit || 5);
    if (/winner|gainer|best/.test(previousText)) return buildTopPnlAnswer(context, 'winner', topLimit || 5);
  }

  if (/(details|summary)/.test(text)) {
    if (previousHolding) return formatHoldingDetail(previousHolding, context);
    if (previousTradeSummary) return buildTradeSummaryAnswer(previousTradeSummary);
    if (/portfolio/.test(previousText)) return buildPortfolioSummaryAnswer(context, activeWindow ? activeWindow.label : 'today');
  }

  if (/(^|\b)(no|not that|i mean)\b/.test(text)) {
    return 'I may have misunderstood. You can correct me with a phrase like realized only, unrealized only, names only, top 5, or mention the stock again.';
  }

  return null;
}

function filterRowsByDateWindow(rows, getDate, window) {
  return rows.filter(function (row) {
    var date = String(getDate(row) || '');
    return !!date && date >= window.fromDate && date <= window.toDate;
  });
}

function buildRealizedPeriodAnswer(context, periodLabel, fromDate, mode, toDate) {
  var realized = getRealizedHistory(context).filter(function (entry) {
    var date = String(entry && entry.date || '');
    return date >= fromDate && (!toDate || date <= toDate);
  });
  if (!realized.length) {
    return 'I do not see any booked ' + (mode === 'loss' ? 'loss' : 'profit') + ' entries for ' + periodLabel + '.';
  }
  var total = realized.reduce(function (sum, entry) {
    var pnl = Number(entry && entry.pnl || 0);
    if (mode === 'loss') return sum + (pnl < 0 ? Math.abs(pnl) : 0);
    return sum + (pnl > 0 ? pnl : 0);
  }, 0);
  return (
    'Your booked ' +
    (mode === 'loss' ? 'loss' : 'profit') +
    ' for ' +
    periodLabel +
    ' is ' +
    formatInr(total) +
    '.'
  );
}

function buildExpenseCategoryForWindow(context, window) {
  var finance = getFinanceContext(context);
  var monthlyCategories = Array.isArray(finance.monthlyExpenseCategories) ? finance.monthlyExpenseCategories : [];
  if (window.monthKey) {
    for (var i = 0; i < monthlyCategories.length; i += 1) {
      if (String(monthlyCategories[i] && monthlyCategories[i].month || '') !== window.monthKey) continue;
      var categories = Array.isArray(monthlyCategories[i].categories) ? monthlyCategories[i].categories : [];
      if (!categories.length) {
        return 'I do not see any expense categories recorded for ' + window.label + '.';
      }
      return 'Your biggest expense category for ' + window.label + ' is ' + categories[0].category + ' at ' + formatInr(categories[0].amount) + '.';
    }
  }

  var recentTransactions = Array.isArray(finance.recentTransactions) ? finance.recentTransactions : [];
  var expenses = filterRowsByDateWindow(recentTransactions, function (row) { return row && row.date; }, window).filter(function (row) {
    return String(row && row.type || '').toUpperCase() === 'EXPENSE';
  });

  if (!expenses.length) {
    return 'I do not see any expense categories recorded for ' + window.label + '.';
  }

  var totals = {};
  expenses.forEach(function (row) {
    var category = String(row && row.category || 'Other').trim() || 'Other';
    totals[category] = (totals[category] || 0) + Number(row && row.amount || 0);
  });

  var topCategory = null;
  var topAmount = 0;
  for (var key in totals) {
    if (totals[key] > topAmount) {
      topCategory = key;
      topAmount = totals[key];
    }
  }

  return topCategory
    ? 'Your biggest expense category for ' + window.label + ' is ' + topCategory + ' at ' + formatInr(topAmount) + '.'
    : 'I do not see any expense categories recorded for ' + window.label + '.';
}

function buildTopHoldingByMetric(context, mode) {
  var holdings = getContextHoldings(context).slice();
  if (!holdings.length) return null;
  if (mode === 'highest_return_percent') {
    holdings.sort(function (a, b) { return Number(b.unrealizedPnlPct || -999999) - Number(a.unrealizedPnlPct || -999999); });
  } else if (mode === 'lowest_return_percent' || mode === 'top_loser_unrealized' || mode === 'worst_performer') {
    holdings.sort(function (a, b) { return Number(a.unrealizedPnlPct || 999999) - Number(b.unrealizedPnlPct || 999999); });
  } else if (mode === 'highest_invested_holding') {
    holdings.sort(function (a, b) { return Number(b.invested || 0) - Number(a.invested || 0); });
  } else if (mode === 'lowest_invested_holding') {
    holdings.sort(function (a, b) { return Number(a.invested || 0) - Number(b.invested || 0); });
  } else if (mode === 'top_gainer_unrealized' || mode === 'best_performer') {
    holdings.sort(function (a, b) { return Number(b.unrealizedPnl || -999999) - Number(a.unrealizedPnl || -999999); });
  }
  return holdings[0] || null;
}

function buildHoldingMetricAnswer(context, mode) {
  var holding = buildTopHoldingByMetric(context, mode);
  if (!holding) return 'I do not see any current holdings to analyze.';
  if (mode === 'highest_return_percent') {
    return holding.symbol + ' has the highest return percentage in your current holdings at ' + formatPctNumber(holding.unrealizedPnlPct) + '.';
  }
  if (mode === 'lowest_return_percent') {
    return holding.symbol + ' has the lowest return percentage in your current holdings at ' + formatPctNumber(holding.unrealizedPnlPct) + '.';
  }
  if (mode === 'highest_invested_holding') {
    return holding.symbol + ' is your highest invested holding at ' + formatInr(holding.invested) + '.';
  }
  if (mode === 'lowest_invested_holding') {
    return holding.symbol + ' is your lowest invested holding at ' + formatInr(holding.invested) + '.';
  }
  if (mode === 'top_gainer_unrealized' || mode === 'best_performer') {
    return holding.symbol + ' is the top unrealized gainer in your current holdings at ' + formatInr(holding.unrealizedPnl) + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ').';
  }
  return holding.symbol + ' is the top unrealized loser in your current holdings at ' + formatInr(holding.unrealizedPnl) + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ').';
}

function buildTradeSummaryOverviewAnswer(context) {
  var trades = getTradeContext(context);
  return (
    'Trade frequency summary: total trades ' +
    Number(trades.totalTrades || 0) +
    ', buy trades ' +
    Number(trades.buyTrades || 0) +
    ', sell trades ' +
    Number(trades.sellTrades || 0) +
    ', first trade date ' +
    (trades.firstTradeDate || 'not available') +
    ', last trade date ' +
    (trades.lastTradeDate || 'not available') +
    '.'
  );
}

function buildUnrealizedTotalAnswer(context) {
  var portfolio = getPortfolioContext(context);
  return 'Total unrealized P&L in your current holdings is ' + formatInr(portfolio.unrealizedPnl) + ' (' + formatPctNumber(portfolio.unrealizedPnlPct) + ').';
}

function buildRealizedTotalAnswer(context, window) {
  var realized = getRealizedHistory(context);
  if (window) {
    realized = realized.filter(function (entry) {
      var date = String(entry && entry.date || '');
      return date >= window.fromDate && date <= window.toDate;
    });
  }
  var total = realized.reduce(function (sum, entry) { return sum + Number(entry && entry.pnl || 0); }, 0);
  return 'Total realized P&L' + (window ? ' for ' + window.label : '') + ' is ' + formatInr(total) + '.';
}

function buildRealizedByStockAnswer(summary, window) {
  if (!summary) return null;
  return summary.symbol + ' realized P&L from your transaction history' + (window ? ' for ' + window.label : '') + ' is ' + formatInr(summary.realizedPnl) + '.';
}

function buildUnrealizedByStockAnswer(holding) {
  if (!holding) return null;
  return holding.symbol + ' unrealized P&L in your current holdings is ' + formatInr(holding.unrealizedPnl) + ' (' + formatPctNumber(holding.unrealizedPnlPct) + ').';
}

function buildInvestmentRangeAnswer(context, window) {
  var finance = getFinanceContext(context);
  if (!window) {
    return 'Total investments recorded in your app are ' + formatInr(finance.investments) + '.';
  }
  var monthly = Array.isArray(finance.monthlyFlow) ? finance.monthlyFlow : [];
  var total = monthly.reduce(function (sum, row) {
    var month = String(row && row.month || '');
    if (!month) return sum;
    if (month < window.fromDate.slice(0, 7) || month > window.toDate.slice(0, 7)) return sum;
    return sum + Number(row && row.investments || 0);
  }, 0);
  return 'Your recorded investments for ' + window.label + ' are ' + formatInr(total) + '.';
}

function buildAllocationClarificationAnswer() {
  return makeClarificationPayload(
    'I can help with allocation, but I am not fully sure whether you want a stock allocation, gold allocation, cash allocation, or top allocation risks.',
    ['Gold allocation in holdings', 'Cash allocation in holdings', 'Top allocation risks', 'DABUR allocation']
  );
}

function buildProfitClarificationAnswer(entity) {
  var name = entity ? entity.symbol : 'that stock';
  return makeClarificationPayload(
    'I understood ' + name + ', but I am not fully sure whether you want realized or unrealized profit.',
    ['Realized only', 'Unrealized only', 'Full details']
  );
}

function buildDeterministicAskFinorAnswerV2(question, context, conversation) {
  var text = String(question || '').trim().toLowerCase();
  var dateWindow = buildDateWindowFromText(text);
  var helpQuery = /(what can you do|help|capabilities|what all can i ask|how can you help)/.test(text);
  var askUnsupported = /(should i buy|should i sell|buy or sell now|market news|live news|tomorrow target|future prediction|price prediction)/.test(text);
  var askPortfolioSummary = /(portfolio summary|summarize my portfolio|portfolio today summary|summary of my portfolio)/.test(text);
  var askOpenPositions = /(open positions|open holdings|current open positions)/.test(text);
  var askTopAllocationRisks = /(top allocation risks|allocation risks|concentration risk|highest allocation risk|risk summary)/.test(text);
  var askCombinedOpenPositionsRisk = askOpenPositions && askTopAllocationRisks;
  var askGoldAllocation = /(gold allocation|gold holdings|gold in holdings)/.test(text);
  var askCashAllocation = /(cash allocation|cash in holdings|cash holdings)/.test(text);
  var askAssetAllocation = /(asset allocation|equity allocation|gold allocation|cash allocation)/.test(text);
  var askAllocationQuery = /(allocation|allocation percentage|allocation %)/.test(text);
  var askHoldingsList = /(all stock names|all holdings|current holdings|current holding stocks list|list holdings|holding names|holding list|which stocks do i have)/.test(text);
  var askNamesOnly = /(stock names|holding names|list of stocks|symbol names|names only)/.test(text);
  var askRealizedLossNames = /(realized loss stock names|loss stock names|stocks in realized loss|realized losers)/.test(text);
  var askRealizedProfitNames = /(realized profit stock names|profit stock names|stocks in realized profit|realized winners)/.test(text);
  var askMostTraded = /(most traded stock|most traded symbol|which stock did i trade most|top traded stock)/.test(text);
  var askTradeFrequencySummary = /(trade frequency|trading activity|trade summary overall|how many trades)/.test(text) && !askMostTraded;
  var askCurrentMonthInvestment = /(current month investment|investment this month|this month investment)/.test(text);
  var askInvestmentRange = dateWindow !== null && /(investment|invested)/.test(text) && !/(holding|allocation)/.test(text);
  var askTopWinners = /(top winners|top winner|best performers|best performing stocks|top gainers)/.test(text);
  var askTopLosers = /(top losers|top loser|worst performers|worst performing stocks|top loss makers|top lossmakers|top \d+ losses|top losses)/.test(text);
  var askHighestReturn = /(highest return percent|highest return %|best return percent|which stock having highest return percent)/.test(text);
  var askLowestReturn = /(lowest return percent|lowest return %|worst return percent)/.test(text);
  var askHighestInvested = /(highest invested holding|highest investment holding|most invested stock)/.test(text);
  var askLowestInvested = /(lowest invested holding|lowest investment holding|least invested stock)/.test(text);
  var askUnrealizedTotal = /(unrealized pnl total|unrealized p&l total|total unrealized|overall unrealized)/.test(text);
  var askRealizedTotal = /(realized pnl total|realized p&l total|total realized|overall realized|booked pnl total)/.test(text);
  var askProfitLossAnalysis = dateWindow !== null && /(profit\s*\/\s*loss|profit and loss|p&l|analysis|how much profit|how much loss)/.test(text);
  var askBiggestExpenseThisMonth = /(biggest expense category this month|highest expense category this month|top expense category this month|biggest expenses this month|highest expenses this month)/.test(text);
  var topLimit = extractTopLimit(text) || 5;
  var explicitHolding = findHoldingFromQuestion(question, context);
  var explicitTradeSummary = findTradeSummaryFromQuestion(question, context);
  var allowConversationCarry = isShortFollowup(text);
  var holding = explicitHolding || (allowConversationCarry ? findHoldingFromConversation(conversation, context) : null);
  var tradeSummary = explicitTradeSummary || (allowConversationCarry ? findTradeSummaryFromConversation(conversation, context) : null);
  var comparisonHoldings = findAllHoldingsFromQuestion(question, context);
  var holdingEntities = holding ? [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.98 : 0.72)] : [];
  var tradeEntities = tradeSummary ? [makeResolvedEntity(tradeSummary.symbol, 'stock', explicitTradeSummary ? 0.98 : 0.72)] : [];

  if (askUnsupported) {
    return makeAnswerPayload(
      'I can analyze only your Finance App data. I cannot give live market advice, news-based calls, or future price predictions.',
      {
        answerKind: 'clarification',
        cards: [makeCard('clarification', 'Unsupported for Finor', [], ['Portfolio summary', 'Holdings analysis', 'Realized P&L', 'Sell simulation'], 'Finor stays analytical and data-based.')],
        resolvedQuery: makeResolvedQuery('unsupported_query', 'conversation', [], dateWindow, null, makeConfidence(0.98, 0, 0.3, 1), 'clarification')
      }
    );
  }

  if (helpQuery) {
    return makeAnswerPayload(buildCapabilitiesAnswer(), {
      answerKind: 'narrative',
      resolvedQuery: makeResolvedQuery('help_or_capabilities', 'conversation', [], null, null, makeConfidence(0.99, 0, 0, 1), 'narrative')
    });
  }

  if (askCombinedOpenPositionsRisk) {
    return makeAnswerPayload(buildOpenPositionsAndRiskAnswer(context), {
      answerKind: 'portfolio_summary',
      cards: [
        buildRankingCard('Open positions', getContextHoldings(context).slice(0, 8).map(function (row) {
          return row.symbol + ' (' + Number(row.qty || 0) + ' qty)';
        })),
        buildRankingCard('Top allocation risks', getContextHoldings(context).slice().sort(function (a, b) {
          return Number(b.allocationPct || 0) - Number(a.allocationPct || 0);
        }).slice(0, 5).map(function (row) {
          return row.symbol + ' (' + formatPctNumber(row.allocationPct).replace('+', '') + ')';
        }))
      ],
      resolvedQuery: makeResolvedQuery('open_positions', 'holdings', [], null, 'allocation_pct', makeConfidence(0.98, 0, 0, 0.96), 'summary')
    });
  }

  if (askPortfolioSummary) {
    return makeAnswerPayload(buildPortfolioSummaryAnswer(context, dateWindow ? dateWindow.label : 'today'), {
      answerKind: 'portfolio_summary',
      cards: [buildPortfolioSummaryCard(context)],
      resolvedQuery: makeResolvedQuery('portfolio_summary', 'portfolio', [], dateWindow, 'portfolio_summary', makeConfidence(0.98, 0, dateWindow ? 0.9 : 0, 0.96), 'summary')
    });
  }

  if (askOpenPositions) {
    return makeAnswerPayload(buildOpenPositionsAnswer(context), {
      answerKind: 'list',
      cards: [buildRankingCard('Open positions', getContextHoldings(context).slice(0, 8).map(function (row) {
        return row.symbol + ' (' + Number(row.qty || 0) + ' qty, ' + formatInr(row.currentValue) + ')';
      }))],
      resolvedQuery: makeResolvedQuery('open_positions', 'holdings', [], null, 'current_value', makeConfidence(0.97, 0, 0, 0.92), 'list')
    });
  }

  if (askTopAllocationRisks) {
    return makeAnswerPayload(buildTopAllocationRisksAnswer(context), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Top allocation risks', getContextHoldings(context).slice().sort(function (a, b) {
        return Number(b.allocationPct || 0) - Number(a.allocationPct || 0);
      }).slice(0, 5).map(function (row) {
        return row.symbol + ' (' + formatPctNumber(row.allocationPct).replace('+', '') + ')';
      }))],
      resolvedQuery: makeResolvedQuery('top_allocation_risks', 'portfolio', [], null, 'allocation_pct', makeConfidence(0.98, 0, 0, 0.95), 'ranking')
    });
  }

  if (askGoldAllocation) {
    var goldHoldings = getHoldingsByAssetGroup(context, 'gold');
    return makeAnswerPayload(buildCategoryAllocationAnswer(context, 'gold', goldHoldings), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Gold allocation', goldHoldings.map(function (row) { return row.symbol + ' (' + formatPctNumber(row.allocationPct).replace('+', '') + ')'; }))],
      resolvedQuery: makeResolvedQuery('gold_allocation_query', 'portfolio', [makeResolvedEntity('gold', 'category', 0.99)], null, 'allocation_pct', makeConfidence(0.99, 0.99, 0, 0.96), 'summary')
    });
  }

  if (askCashAllocation) {
    var cashHoldings = getHoldingsByAssetGroup(context, 'cash');
    return makeAnswerPayload(buildCategoryAllocationAnswer(context, 'cash', cashHoldings), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Cash allocation', cashHoldings.map(function (row) { return row.symbol + ' (' + formatPctNumber(row.allocationPct).replace('+', '') + ')'; }))],
      resolvedQuery: makeResolvedQuery('cash_allocation_query', 'portfolio', [makeResolvedEntity('cash', 'category', 0.99)], null, 'allocation_pct', makeConfidence(0.99, 0.99, 0, 0.96), 'summary')
    });
  }

  if (askAssetAllocation && !explicitHolding) {
    return makeAnswerPayload(
      [
        buildCategoryAllocationAnswer(context, 'equity', getHoldingsByAssetGroup(context, 'equity')),
        buildCategoryAllocationAnswer(context, 'gold', getHoldingsByAssetGroup(context, 'gold')),
        buildCategoryAllocationAnswer(context, 'cash', getHoldingsByAssetGroup(context, 'cash'))
      ].join(' '),
      {
        answerKind: 'portfolio_summary',
        cards: [buildRankingCard('Asset allocation', [
          'Equity: ' + getHoldingsByAssetGroup(context, 'equity').length + ' holdings',
          'Gold: ' + getHoldingsByAssetGroup(context, 'gold').length + ' holdings',
          'Cash: ' + getHoldingsByAssetGroup(context, 'cash').length + ' holdings'
        ])],
        resolvedQuery: makeResolvedQuery('asset_allocation_query', 'portfolio', [], null, 'allocation_pct', makeConfidence(0.97, 0.7, 0, 0.94), 'summary')
      }
    );
  }

  if (askAllocationQuery && !explicitHolding && !askGoldAllocation && !askCashAllocation && !askAssetAllocation && !askTopAllocationRisks) {
    return buildAllocationClarificationAnswer();
  }

  if (askRealizedLossNames) {
    var realizedLossText = buildRealizedNamesAnswer(context, 'loss', dateWindow);
    var realizedLossRows = getRealizedHistory(context);
    if (dateWindow) {
      realizedLossRows = realizedLossRows.filter(function (entry) {
        var date = String(entry && entry.date || '');
        return date >= dateWindow.fromDate && date <= dateWindow.toDate;
      });
    }
    var realizedLossTotals = {};
    realizedLossRows.forEach(function (entry) {
      var symbol = normalizeSymbol(entry && entry.symbol);
      var pnl = Number(entry && entry.pnl || 0);
      if (!symbol || !(pnl < 0)) return;
      realizedLossTotals[symbol] = (realizedLossTotals[symbol] || 0) + pnl;
    });
    var realizedLossItems = Object.keys(realizedLossTotals)
      .sort(function (a, b) { return realizedLossTotals[a] - realizedLossTotals[b]; })
      .slice(0, topLimit)
      .map(function (symbol) {
        return symbol + ' (' + formatInr(realizedLossTotals[symbol]) + ')';
      });
    return makeAnswerPayload(realizedLossText, {
      answerKind: 'list',
      cards: [buildRankingCard('Realized loss names' + (dateWindow ? ' for ' + dateWindow.label : ''), realizedLossItems)],
      resolvedQuery: makeResolvedQuery(
        'realized_loss_stock_names',
        'trades',
        [],
        dateWindow,
        'realized_pnl',
        makeConfidence(0.99, 0.82, dateWindow ? 0.94 : 0, 0.98),
        'list'
      )
    });
  }

  if (askRealizedProfitNames) {
    var realizedProfitText = buildRealizedNamesAnswer(context, 'profit', dateWindow);
    var realizedProfitRows = getRealizedHistory(context);
    if (dateWindow) {
      realizedProfitRows = realizedProfitRows.filter(function (entry) {
        var date = String(entry && entry.date || '');
        return date >= dateWindow.fromDate && date <= dateWindow.toDate;
      });
    }
    var realizedProfitTotals = {};
    realizedProfitRows.forEach(function (entry) {
      var symbol = normalizeSymbol(entry && entry.symbol);
      var pnl = Number(entry && entry.pnl || 0);
      if (!symbol || !(pnl > 0)) return;
      realizedProfitTotals[symbol] = (realizedProfitTotals[symbol] || 0) + pnl;
    });
    var realizedProfitItems = Object.keys(realizedProfitTotals)
      .sort(function (a, b) { return realizedProfitTotals[b] - realizedProfitTotals[a]; })
      .slice(0, topLimit)
      .map(function (symbol) {
        return symbol + ' (' + formatInr(realizedProfitTotals[symbol]) + ')';
      });
    return makeAnswerPayload(realizedProfitText, {
      answerKind: 'list',
      cards: [buildRankingCard('Realized profit names' + (dateWindow ? ' for ' + dateWindow.label : ''), realizedProfitItems)],
      resolvedQuery: makeResolvedQuery(
        'realized_profit_stock_names',
        'trades',
        [],
        dateWindow,
        'realized_pnl',
        makeConfidence(0.99, 0.82, dateWindow ? 0.94 : 0, 0.98),
        'list'
      )
    });
  }

  if (askHoldingsList) {
    return makeAnswerPayload(buildHoldingsListAnswer(context, !askNamesOnly), {
      answerKind: 'list',
      cards: [buildRankingCard(
        askNamesOnly ? 'Holding symbols' : 'Current holdings',
        getContextHoldings(context)
          .slice()
          .sort(function (a, b) { return Number(b.currentValue || 0) - Number(a.currentValue || 0); })
          .slice(0, 10)
          .map(function (row) {
            return askNamesOnly ? row.symbol : row.symbol + ' (' + Number(row.qty || 0) + ' qty)';
          })
      )],
      resolvedQuery: makeResolvedQuery(
        'holdings_list',
        'holdings',
        [],
        null,
        askNamesOnly ? 'symbols' : 'current_positions',
        makeConfidence(0.98, 0.4, 0, 0.95),
        'list'
      )
    });
  }

  if (askMostTraded) {
    return makeAnswerPayload(buildMostTradedAnswer(context), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Most traded stocks', getTradeSummaries(context).slice(0, Math.max(3, topLimit)).map(function (row) {
        return row.symbol + ' (' + Number(row.tradeCount || 0) + ' trades)';
      }))],
      resolvedQuery: makeResolvedQuery(
        'most_traded_stock',
        'trades',
        [],
        null,
        'trade_count',
        makeConfidence(0.98, 0.72, 0, 0.97),
        'ranking'
      )
    });
  }

  if (askTradeFrequencySummary) {
    return makeAnswerPayload(buildTradeSummaryOverviewAnswer(context), {
      answerKind: 'narrative',
      cards: [makeCard('portfolio_summary', 'Trade frequency', [
        { label: 'Total trades', value: String(Number(getTradeContext(context).totalTrades || 0)) },
        { label: 'Buy trades', value: String(Number(getTradeContext(context).buyTrades || 0)) },
        { label: 'Sell trades', value: String(Number(getTradeContext(context).sellTrades || 0)) }
      ], [], 'From your transaction history.')],
      resolvedQuery: makeResolvedQuery(
        'trade_frequency_summary',
        'trades',
        [],
        null,
        'trade_count',
        makeConfidence(0.96, 0.55, 0, 0.94),
        'summary'
      )
    });
  }

  if (askTopWinners) {
    return makeAnswerPayload(buildTopPnlAnswer(context, 'winner', topLimit), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Top net winners', (context && context.pnl && Array.isArray(context.pnl.topNetWinners) ? context.pnl.topNetWinners : [])
        .slice(0, topLimit)
        .map(function (row) { return row.symbol + ' (' + formatInr(row.netPnl) + ')'; }))],
      resolvedQuery: makeResolvedQuery(
        'top_5_gainers',
        'trades',
        [],
        null,
        'net_pnl',
        makeConfidence(0.97, 0.72, 0, 0.96),
        'ranking'
      )
    });
  }

  if (askTopLosers) {
    return makeAnswerPayload(buildTopPnlAnswer(context, 'loser', topLimit), {
      answerKind: 'ranking',
      cards: [buildRankingCard('Top net losers', (context && context.pnl && Array.isArray(context.pnl.topNetLosers) ? context.pnl.topNetLosers : [])
        .slice(0, topLimit)
        .map(function (row) { return row.symbol + ' (' + formatInr(row.netPnl) + ')'; }))],
      resolvedQuery: makeResolvedQuery(
        'top_5_losers',
        'trades',
        [],
        null,
        'net_pnl',
        makeConfidence(0.97, 0.72, 0, 0.96),
        'ranking'
      )
    });
  }

  if (askHighestReturn) {
    var highestReturnHolding = buildTopHoldingByMetric(context, 'highest_return_percent');
    return makeAnswerPayload(buildHoldingMetricAnswer(context, 'highest_return_percent'), {
      answerKind: 'ranking',
      cards: highestReturnHolding ? [buildHoldingDetailCard(highestReturnHolding)] : [],
      resolvedQuery: makeResolvedQuery(
        'highest_return_percent',
        'holdings',
        highestReturnHolding ? [makeResolvedEntity(highestReturnHolding.symbol, 'stock', 0.96)] : [],
        null,
        'return_pct',
        makeConfidence(0.98, highestReturnHolding ? 0.96 : 0.2, 0, 0.98),
        'ranking'
      )
    });
  }

  if (askLowestReturn) {
    var lowestReturnHolding = buildTopHoldingByMetric(context, 'lowest_return_percent');
    return makeAnswerPayload(buildHoldingMetricAnswer(context, 'lowest_return_percent'), {
      answerKind: 'ranking',
      cards: lowestReturnHolding ? [buildHoldingDetailCard(lowestReturnHolding)] : [],
      resolvedQuery: makeResolvedQuery(
        'lowest_return_percent',
        'holdings',
        lowestReturnHolding ? [makeResolvedEntity(lowestReturnHolding.symbol, 'stock', 0.96)] : [],
        null,
        'return_pct',
        makeConfidence(0.98, lowestReturnHolding ? 0.96 : 0.2, 0, 0.98),
        'ranking'
      )
    });
  }

  if (askHighestInvested) {
    var highestInvestedHolding = buildTopHoldingByMetric(context, 'highest_invested_holding');
    return makeAnswerPayload(buildHoldingMetricAnswer(context, 'highest_invested_holding'), {
      answerKind: 'ranking',
      cards: highestInvestedHolding ? [buildHoldingDetailCard(highestInvestedHolding)] : [],
      resolvedQuery: makeResolvedQuery(
        'highest_invested_holding',
        'holdings',
        highestInvestedHolding ? [makeResolvedEntity(highestInvestedHolding.symbol, 'stock', 0.96)] : [],
        null,
        'invested',
        makeConfidence(0.98, highestInvestedHolding ? 0.96 : 0.2, 0, 0.97),
        'ranking'
      )
    });
  }

  if (askLowestInvested) {
    var lowestInvestedHolding = buildTopHoldingByMetric(context, 'lowest_invested_holding');
    return makeAnswerPayload(buildHoldingMetricAnswer(context, 'lowest_invested_holding'), {
      answerKind: 'ranking',
      cards: lowestInvestedHolding ? [buildHoldingDetailCard(lowestInvestedHolding)] : [],
      resolvedQuery: makeResolvedQuery(
        'lowest_invested_holding',
        'holdings',
        lowestInvestedHolding ? [makeResolvedEntity(lowestInvestedHolding.symbol, 'stock', 0.96)] : [],
        null,
        'invested',
        makeConfidence(0.98, lowestInvestedHolding ? 0.96 : 0.2, 0, 0.97),
        'ranking'
      )
    });
  }

  if (askUnrealizedTotal) {
    return makeAnswerPayload(buildUnrealizedTotalAnswer(context), {
      answerKind: 'portfolio_summary',
      cards: [buildPortfolioSummaryCard(context)],
      resolvedQuery: makeResolvedQuery(
        'unrealized_pnl_total',
        'holdings',
        [],
        null,
        'unrealized_pnl',
        makeConfidence(0.98, 0.4, 0, 0.97),
        'summary'
      )
    });
  }

  if (askRealizedTotal) {
    return makeAnswerPayload(buildRealizedTotalAnswer(context, dateWindow), {
      answerKind: 'portfolio_summary',
      cards: [buildPortfolioSummaryCard(context)],
      resolvedQuery: makeResolvedQuery(
        'realized_pnl_total',
        'trades',
        [],
        dateWindow,
        'realized_pnl',
        makeConfidence(0.98, 0.4, dateWindow ? 0.94 : 0, 0.97),
        'summary'
      )
    });
  }

  if (askCurrentMonthInvestment) {
    var currentMonthWindow = dateWindow || buildDateWindowFromText('this month');
    return makeAnswerPayload(buildInvestmentRangeAnswer(context, currentMonthWindow), {
      answerKind: 'portfolio_summary',
      cards: [makeCard('portfolio_summary', 'Current month investment', [
        { label: 'Period', value: currentMonthWindow ? currentMonthWindow.label : 'this month' },
        { label: 'Investments', value: buildInvestmentRangeAnswer(context, currentMonthWindow).replace(/^Your recorded investments for [^.]+ are /, '').replace(/\.$/, '') }
      ], [], 'Based on your recorded monthly flow.')],
      resolvedQuery: makeResolvedQuery(
        'current_month_investment',
        'finance',
        [],
        currentMonthWindow,
        'investments',
        makeConfidence(0.97, 0.4, 0.95, 0.96),
        'summary'
      )
    });
  }

  if (askInvestmentRange) {
    return makeAnswerPayload(buildInvestmentRangeAnswer(context, dateWindow), {
      answerKind: 'portfolio_summary',
      cards: [makeCard('portfolio_summary', 'Investment summary', [
        { label: 'Period', value: dateWindow ? dateWindow.label : 'all time' },
        { label: 'Investments', value: buildInvestmentRangeAnswer(context, dateWindow).replace(/^Your recorded investments(?: for [^.]+)? are /, '').replace(/\.$/, '') }
      ], [], 'Based on your recorded monthly flow.')],
      resolvedQuery: makeResolvedQuery(
        dateWindow ? 'date_range_investment' : 'current_month_investment',
        'finance',
        [],
        dateWindow,
        'investments',
        makeConfidence(0.96, 0.4, dateWindow ? 0.94 : 0.6, 0.95),
        'summary'
      )
    });
  }

  if (askBiggestExpenseThisMonth) {
    return makeAnswerPayload(buildExpenseCategoryAnswer(context, true), {
      answerKind: 'narrative',
      cards: [makeCard('ranking', 'Top expense category this month', [], [buildExpenseCategoryAnswer(context, true).replace(/^Your biggest expense category this month is /, '').replace(/\.$/, '')], 'From your recorded transaction data.')],
      resolvedQuery: makeResolvedQuery(
        'date_range_investment',
        'finance',
        [],
        buildDateWindowFromText('this month'),
        'expense_category',
        makeConfidence(0.97, 0.45, 0.96, 0.93),
        'summary'
      )
    });
  }

  if (askProfitLossAnalysis) {
    return makeAnswerPayload(
      buildProfitLossAnalysisAnswer(context, dateWindow ? dateWindow.label : 'the selected period', dateWindow ? dateWindow.fromDate : '', dateWindow ? dateWindow.toDate : ''),
      {
        answerKind: 'portfolio_summary',
        cards: [makeCard('portfolio_summary', 'Booked profit/loss', [
          { label: 'Range', value: dateWindow ? dateWindow.label : 'selected period' },
          { label: 'Trades', value: String(getRealizedHistory(context).filter(function (entry) {
            if (!dateWindow) return true;
            var date = String(entry && entry.date || '');
            return date >= dateWindow.fromDate && date <= dateWindow.toDate;
          }).length) }
        ], [], 'Calculated from your recorded sell history.')],
        resolvedQuery: makeResolvedQuery(
          'date_range_realized_pnl',
          'trades',
          [],
          dateWindow,
          'realized_pnl',
          makeConfidence(0.96, 0.45, dateWindow ? 0.95 : 0.3, 0.95),
          'summary'
        )
      }
    );
  }

  var askComparison = /(vs|compare|comparison)/.test(text) && comparisonHoldings.length >= 2;
  var askTarget = /(target price|target sell price|sell price|exit price)/.test(text);
  var askBreakEven = /(break even|breakeven)/.test(text);
  var askAveragePrice = /(average price|avg price|avg buy|average buy|buy average)/.test(text);
  var askQuantityOnly = /(how much quantity|quantity do i have|qty do i have|shares do i have)/.test(text);
  var askRecentTrades = /(recent trades|recent activity|trade details|trade summary)/.test(text) && !askTradeFrequencySummary;
  var askHoldingSummary = /(holding summary|stock details|full stock details|full details|active holding trade details|summary details|holding details|position details)/.test(text);
  var askRealizedOnlyMetric = /realized only/.test(text);
  var askUnrealizedOnlyMetric = /unrealized only/.test(text);
  var sellPrice = resolveSellPriceFromQuestion(text, holding);
  var askWhatIfSell = sellPrice !== null && /(if i sell|if sold|sell at|sold at|profit i will get|how much profit|how much percent return)/.test(text);
  var askChargesEstimation = /(charges estimation|charges estimate|estimated charges|charges if i sell)/.test(text) && sellPrice !== null;

  if (askComparison) {
    return makeAnswerPayload(buildHoldingComparisonAnswer(comparisonHoldings), {
      answerKind: 'ranking',
      cards: comparisonHoldings.slice(0, 2).map(function (row) { return buildHoldingDetailCard(row); }),
      resolvedQuery: makeResolvedQuery(
        'compare_holdings',
        'holdings',
        comparisonHoldings.slice(0, 2).map(function (row) { return makeResolvedEntity(row.symbol, 'stock', 0.95); }),
        null,
        'comparison',
        makeConfidence(0.97, 0.96, 0, 0.94),
        'detail'
      )
    });
  }

  if (askWhatIfSell && holding && sellPrice !== null) {
    return makeAnswerPayload(buildWhatIfSellAnswer(holding, context, sellPrice), {
      answerKind: 'simulation',
      cards: [buildSimulationCard(holding, context, sellPrice)],
      resolvedQuery: makeResolvedQuery(
        'sell_simulation',
        'simulation',
        [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
        null,
        'sell_price',
        makeConfidence(0.98, explicitHolding ? 0.99 : 0.75, 0, 0.98),
        'simulation'
      )
    });
  }

  if (askChargesEstimation && holding && sellPrice !== null) {
    var qty = Number(holding.qty || 0);
    var grossValue = qty * sellPrice;
    var sellRate = Number(context && context.settings ? context.settings.sellBrokeragePct || 0 : 0);
    var dpCharge = Number(context && context.settings ? context.settings.dpCharge || 0 : 0);
    var estimatedCharges = grossValue * (sellRate / 100) + dpCharge;
    return makeAnswerPayload(
      'Estimated sell charges for ' + holding.symbol + ' at ' + formatInr(sellPrice) + ' per share are about ' + formatInr(estimatedCharges) + '.',
      {
        answerKind: 'simulation',
        cards: [buildSimulationCard(holding, context, sellPrice)],
        resolvedQuery: makeResolvedQuery(
          'charges_estimation',
          'simulation',
          [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
          null,
          'charges',
          makeConfidence(0.97, explicitHolding ? 0.99 : 0.75, 0, 0.95),
          'simulation'
        )
      }
    );
  }

  if (askTarget && holding) {
    return makeAnswerPayload(
      holding.symbol +
      ' target sell price is ' +
      formatInr(holding.targetSellPrice) +
      ' per share. Break-even sell price is ' +
      formatInr(holding.breakEvenSellPrice) +
      '.',
      {
        answerKind: 'holding_detail',
        cards: [buildHoldingDetailCard(holding)],
        resolvedQuery: makeResolvedQuery(
          'holding_summary',
          'holdings',
          [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
          null,
          'target_sell_price',
          makeConfidence(0.98, explicitHolding ? 0.99 : 0.75, 0, 0.97),
          'detail'
        )
      }
    );
  }

  if (askBreakEven && holding) {
    return makeAnswerPayload(
      holding.symbol +
      ' break-even sell price is ' +
      formatInr(holding.breakEvenSellPrice) +
      ' per share. Your current target sell price is ' +
      formatInr(holding.targetSellPrice) +
      '.',
      {
        answerKind: 'holding_detail',
        cards: [buildHoldingDetailCard(holding)],
        resolvedQuery: makeResolvedQuery(
          'break_even_query',
          'simulation',
          [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
          null,
          'break_even',
          makeConfidence(0.98, explicitHolding ? 0.99 : 0.75, 0, 0.97),
          'detail'
        )
      }
    );
  }

  if (askAveragePrice && holding) {
    return makeAnswerPayload(
      holding.symbol + ' average buy price in your current holdings is ' + formatInr(holding.avgBuy) + '.',
      {
        answerKind: 'holding_detail',
        cards: [buildHoldingDetailCard(holding)],
        resolvedQuery: makeResolvedQuery(
          'holding_summary',
          'holdings',
          [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
          null,
          'avg_buy',
          makeConfidence(0.98, explicitHolding ? 0.99 : 0.75, 0, 0.97),
          'detail'
        )
      }
    );
  }

  if (askQuantityOnly && holding) {
    return makeAnswerPayload(
      'You currently hold ' + Number(holding.qty || 0) + ' shares of ' + holding.symbol + '.',
      {
        answerKind: 'holding_detail',
        cards: [buildHoldingDetailCard(holding)],
        resolvedQuery: makeResolvedQuery(
          'holding_summary',
          'holdings',
          [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
          null,
          'quantity',
          makeConfidence(0.97, explicitHolding ? 0.99 : 0.75, 0, 0.96),
          'detail'
        )
      }
    );
  }

  if (askRecentTrades && tradeSummary) {
    return makeAnswerPayload(buildRecentTradesAnswer(tradeSummary, context), {
      answerKind: 'list',
      cards: [buildRankingCard('Recent trades for ' + tradeSummary.symbol, [
        'Trade count: ' + Number(tradeSummary.tradeCount || 0),
        'Buy qty: ' + Number(tradeSummary.buyQty || 0),
        'Sell qty: ' + Number(tradeSummary.sellQty || 0),
        'Net P&L: ' + formatInr(tradeSummary.netPnl)
      ])],
      resolvedQuery: makeResolvedQuery(
        'realized_pnl_by_stock',
        'trades',
        [makeResolvedEntity(tradeSummary.symbol, 'stock', explicitTradeSummary ? 0.99 : 0.75)],
        dateWindow,
        'trade_history',
        makeConfidence(0.96, explicitTradeSummary ? 0.99 : 0.75, dateWindow ? 0.9 : 0, 0.93),
        'list'
      )
    });
  }

  if (askRealizedOnlyMetric && tradeSummary) {
    return makeAnswerPayload(buildTradeRealizedOnlyAnswer(tradeSummary), {
      answerKind: 'holding_detail',
      cards: [buildRankingCard('Realized P&L for ' + tradeSummary.symbol, [
        'Sell trades: ' + Number(tradeSummary.sellCount || 0),
        'Realized P&L: ' + formatInr(tradeSummary.realizedPnl)
      ])],
      resolvedQuery: makeResolvedQuery(
        'realized_pnl_by_stock',
        'trades',
        [makeResolvedEntity(tradeSummary.symbol, 'stock', explicitTradeSummary ? 0.99 : 0.75)],
        dateWindow,
        'realized_pnl',
        makeConfidence(0.97, explicitTradeSummary ? 0.99 : 0.75, dateWindow ? 0.85 : 0, 0.96),
        'detail'
      )
    });
  }

  if (askUnrealizedOnlyMetric && holding) {
    return makeAnswerPayload(buildHoldingUnrealizedOnlyAnswer(holding), {
      answerKind: 'holding_detail',
      cards: [buildHoldingDetailCard(holding)],
      resolvedQuery: makeResolvedQuery(
        'unrealized_pnl_by_stock',
        'holdings',
        [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
        null,
        'unrealized_pnl',
        makeConfidence(0.97, explicitHolding ? 0.99 : 0.75, 0, 0.96),
        'detail'
      )
    });
  }

  if (holding && /(realized profit|realized pnl|booked pnl|booked profit|booked loss)/.test(text) && !/(unrealized|holding|current value|allocation|avg)/.test(text)) {
    if (tradeSummary) {
      return makeAnswerPayload(buildRealizedByStockAnswer(tradeSummary, dateWindow), {
        answerKind: 'holding_detail',
        cards: [buildRankingCard('Realized P&L for ' + tradeSummary.symbol, [
          'Sell trades: ' + Number(tradeSummary.sellCount || 0),
          'Realized P&L: ' + formatInr(tradeSummary.realizedPnl)
        ])],
        resolvedQuery: makeResolvedQuery(
          'realized_pnl_by_stock',
          'trades',
          [makeResolvedEntity(tradeSummary.symbol, 'stock', explicitTradeSummary ? 0.99 : 0.75)],
          dateWindow,
          'realized_pnl',
          makeConfidence(0.96, explicitTradeSummary ? 0.99 : 0.75, dateWindow ? 0.85 : 0, 0.95),
          'detail'
        )
      });
    }
    return buildProfitClarificationAnswer(holding);
  }

  if (holding && /(unrealized profit|unrealized pnl|current profit|current loss|profit in current holdings)/.test(text)) {
    return makeAnswerPayload(buildUnrealizedByStockAnswer(holding), {
      answerKind: 'holding_detail',
      cards: [buildHoldingDetailCard(holding)],
      resolvedQuery: makeResolvedQuery(
        'unrealized_pnl_by_stock',
        'holdings',
        [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
        null,
        'unrealized_pnl',
        makeConfidence(0.96, explicitHolding ? 0.99 : 0.75, 0, 0.95),
        'detail'
      )
    });
  }

  if (holding && (askHoldingSummary || /(holding|position|ltp|current value|invested amount|allocation)/.test(text))) {
    return makeAnswerPayload(formatHoldingDetail(holding, context), {
      answerKind: 'holding_detail',
      cards: [buildHoldingDetailCard(holding)],
      resolvedQuery: makeResolvedQuery(
        'holding_summary',
        'holdings',
        [makeResolvedEntity(holding.symbol, 'stock', explicitHolding ? 0.99 : 0.75)],
        null,
        'holding_snapshot',
        makeConfidence(0.95, explicitHolding ? 0.99 : 0.75, 0, 0.93),
        'detail'
      )
    });
  }

  return null;
}

function buildDeterministicAskFinorAnswer(question, context, conversation) {
  const text = String(question || '').trim().toLowerCase();
  const greetingAnswer = buildGreetingAnswer(text);
  if (greetingAnswer) return greetingAnswer;
  const correctionAnswer = buildCorrectionFollowupAnswer(question, context, conversation);
  if (correctionAnswer) return correctionAnswer;
  const dateWindow = buildDateWindowFromText(text);
  const explicitHolding = findHoldingFromQuestion(question, context);
  const holding = explicitHolding || findHoldingFromConversation(conversation, context);
  const tradeSummary = findTradeSummaryFromQuestion(question, context) || findTradeSummaryFromConversation(conversation, context);
  const comparisonHoldings = findAllHoldingsFromQuestion(question, context);
  const topLimit = extractTopLimit(text) || 5;
  const helpQuery = /(what can you do|help|capabilities|what all can i ask|how can you help)/.test(text);
  const askPortfolioSummary = /(portfolio summary|summarize my portfolio|portfolio today summary|summary of my portfolio)/.test(text);
  const askOpenPositions = /(open positions|open holdings|current open positions)/.test(text);
  const askTopAllocationRisks = /(top allocation risks|allocation risks|concentration risk|highest allocation risk|risk summary)/.test(text);
  const askCombinedOpenPositionsRisk = askOpenPositions && askTopAllocationRisks;
  const askAllocationQuery = /(allocation|allocation percentage|allocation %)/.test(text);
  const askGoldAllocation = /(gold allocation|gold holdings|gold in holdings)/.test(text);
  const askCashAllocation = /(cash allocation|cash in holdings|cash holdings)/.test(text);
  const askAssetAllocation = /(asset allocation|equity allocation|gold allocation|cash allocation)/.test(text);
  const askRealizedLossNames = /(realized loss stock names|loss stock names|stocks in realized loss|realized losers)/.test(text);
  const askRealizedProfitNames = /(realized profit stock names|profit stock names|stocks in realized profit|realized winners)/.test(text);
  const askHoldingsList =
    /(all stock names|all holdings|current holdings|current holding stocks list|list holdings|holding names|holding list|which stocks do i have)/.test(text);
  const askNamesOnly = /(stock names|holding names|list of stocks|symbol names)/.test(text);
  const askProfitHoldings =
    /(holdings.*profit|stocks.*profit|which.*in profit|profit holdings|stocks that.*profit)/.test(text);
  const askLossHoldings =
    /(holdings.*loss|stocks.*loss|which.*in loss|loss holdings|stocks that.*loss)/.test(text);
  const threshold = extractPercentThreshold(text);
  const askAboveThreshold =
    threshold !== null &&
    /(holding|holdings|stock|stocks|return|profit|gain)/.test(text) &&
    /(?:above|more than|greater than|over)/.test(text);
  const askBelowThreshold =
    threshold !== null &&
    /(holding|holdings|stock|stocks|return|profit|gain|loss)/.test(text) &&
    /(?:below|less than|under)/.test(text);

  if (askHoldingsList) {
    return buildHoldingsListAnswer(context, !askNamesOnly);
  }

  if (askAboveThreshold) {
    return buildFilteredHoldingsAnswer(context, 'above', threshold);
  }

  if (askBelowThreshold) {
    return buildFilteredHoldingsAnswer(context, 'below', threshold);
  }

  if (askProfitHoldings) {
    return buildFilteredHoldingsAnswer(context, 'profit', null);
  }

  if (askLossHoldings) {
    return buildFilteredHoldingsAnswer(context, 'loss', null);
  }

  const askMostTraded = /(most traded stock|most traded symbol|which stock did i trade most|top traded stock)/.test(text);
  const askTopWinners = /(top winners|top winner|best performers|best performing stocks|top gainers)/.test(text);
  const askTopLosers = /(top losers|top loser|worst performers|worst performing stocks|top loss makers|top lossmakers|top \d+ losses|top losses)/.test(text);
  const askBiggestExpenseThisMonth =
    /(biggest expense category this month|highest expense category this month|top expense category this month|biggest expenses this month|highest expenses this month)/.test(text);
  const askBiggestExpense =
    !askBiggestExpenseThisMonth && /(biggest expense category|highest expense category|top expense category|biggest expenses|highest expenses)/.test(text);
  const askComparison = /(vs|compare|comparison)/.test(text) && comparisonHoldings.length >= 2;
  const sellPrice = resolveSellPriceFromQuestion(text, holding);
  const askWhatIfSell = sellPrice !== null && /(if i sell|if sold|sell at|sold at|profit i will get|how much profit)/.test(text);
  const askProfitToday = /(profit today|today profit|booked profit today|how much profit today)/.test(text);
  const askLossBookedLast3Months = /(loss i booked in last 3 months|booked loss in last 3 months|loss booked last 3 months)/.test(text);
  const askProfitLossAnalysis =
    (dateWindow !== null && /(profit\s*\/\s*loss|profit and loss|p&l|analysis)/.test(text) && !explicitHolding) ||
    /(last 3 month profit\s*\/\s*loss analysis|last 3 months profit\s*\/\s*loss analysis)/.test(text);
  const askBookedProfitWithWindow =
    dateWindow !== null &&
    /(booked profit|realized profit|profit booked|how much profit|profit for|profit in|this month profit|last month profit|last 30 days profit)/.test(text) &&
    !askWhatIfSell &&
    !explicitHolding;
  const askBookedLossWithWindow =
    dateWindow !== null &&
    /(booked loss|realized loss|loss booked|how much loss|loss for|loss in|this month loss|last month loss|last 30 days loss)/.test(text) &&
    !explicitHolding;

  if (helpQuery) {
    return buildCapabilitiesAnswer();
  }

  if (askCombinedOpenPositionsRisk) {
    return buildOpenPositionsAndRiskAnswer(context);
  }

  if (askPortfolioSummary) {
    return buildPortfolioSummaryAnswer(context, dateWindow ? dateWindow.label : 'today');
  }

  if (askOpenPositions) {
    return buildOpenPositionsAnswer(context);
  }

  if (askTopAllocationRisks) {
    return buildTopAllocationRisksAnswer(context);
  }

  if (askGoldAllocation) {
    return buildCategoryAllocationAnswer(context, 'gold', getHoldingsByAssetGroup(context, 'gold'));
  }

  if (askCashAllocation) {
    return buildCategoryAllocationAnswer(context, 'cash', getHoldingsByAssetGroup(context, 'cash'));
  }

  if (askAssetAllocation && !explicitHolding) {
    return [
      buildCategoryAllocationAnswer(context, 'equity', getHoldingsByAssetGroup(context, 'equity')),
      buildCategoryAllocationAnswer(context, 'gold', getHoldingsByAssetGroup(context, 'gold')),
      buildCategoryAllocationAnswer(context, 'cash', getHoldingsByAssetGroup(context, 'cash'))
    ].join(' ');
  }

  if (askRealizedLossNames) {
    return buildRealizedNamesAnswer(context, 'loss', dateWindow);
  }

  if (askRealizedProfitNames) {
    return buildRealizedNamesAnswer(context, 'profit', dateWindow);
  }

  if (askAllocationQuery && explicitHolding) {
    return buildSingleHoldingAllocationAnswer(explicitHolding);
  }

  if (askMostTraded) {
    return buildMostTradedAnswer(context);
  }

  if (askTopWinners) {
    return buildTopPnlAnswer(context, 'winner', topLimit);
  }

  if (askTopLosers) {
    return buildTopPnlAnswer(context, 'loser', topLimit);
  }

  if (dateWindow && askBiggestExpense) {
    return buildExpenseCategoryForWindow(context, dateWindow);
  }

  if (askBiggestExpenseThisMonth) {
    return buildExpenseCategoryAnswer(context, true);
  }

  if (askBiggestExpense) {
    return buildExpenseCategoryAnswer(context, false);
  }

  if (askComparison) {
    return buildHoldingComparisonAnswer(comparisonHoldings);
  }

  if (askProfitLossAnalysis) {
    if (dateWindow) {
      return buildProfitLossAnalysisAnswer(context, dateWindow.label, dateWindow.fromDate, dateWindow.toDate);
    }
    var analysisFromDate = new Date();
    analysisFromDate.setMonth(analysisFromDate.getMonth() - 3);
    return buildProfitLossAnalysisAnswer(context, 'the last 3 months', analysisFromDate.toISOString().slice(0, 10), null);
  }

  if (askBookedProfitWithWindow) {
    return buildRealizedPeriodAnswer(context, dateWindow.label, dateWindow.fromDate, 'profit', dateWindow.toDate);
  }

  if (askBookedLossWithWindow) {
    return buildRealizedPeriodAnswer(context, dateWindow.label, dateWindow.fromDate, 'loss', dateWindow.toDate);
  }

  if (askProfitToday) {
    return buildRealizedPeriodAnswer(context, 'today', startOfTodayIso(), 'profit');
  }

  if (askLossBookedLast3Months) {
    var fromDate = new Date();
    fromDate.setMonth(fromDate.getMonth() - 3);
    return buildRealizedPeriodAnswer(context, 'the last 3 months', fromDate.toISOString().slice(0, 10), 'loss');
  }

  const askTarget = /(target price|target sell price|sell price|exit price)/.test(text);
  const askBreakEven = /(break even|breakeven)/.test(text);
  const askAveragePrice = /(average price|avg price|average buy|avg buy|buy average)/.test(text);
  const askQuantityOnly = /(how much quantity|quantity|qty|shares|share count|units)/.test(text);
  const askRecentTrades = /(recent trades|last trades|latest trades|recent activity|trade history)/.test(text);
  const askHoldingSummary =
    /(holding|position|ltp|current value|profit|loss|p&l|pnl|stock details|full stock details|details about|details for|active holding|trade details|summary data|stock summary|full details|same like)/.test(
      text
    );

  if (askRecentTrades && tradeSummary) {
    return buildRecentTradesAnswer(tradeSummary, context);
  }

  if (tradeSummary && /(trade summary|stock summary|trading summary|summary for|details for)/.test(text) && !holding) {
    return buildTradeSummaryAnswer(tradeSummary);
  }

  if (!holding) return null;

  if (askWhatIfSell) {
    return buildWhatIfSellAnswer(holding, context, sellPrice);
  }

  if (askTarget && holding.targetSellPrice) {
    return (
      holding.symbol +
      ' target sell price is ' +
      formatInr(holding.targetSellPrice) +
      ' per share. This is based on your target profit setting of ' +
      formatPctNumber(context.settings && context.settings.targetProfitPct) +
      ', current open quantity of ' +
      Number(holding.qty || 0) +
      ', and your configured brokerage and DP charges. Break-even sell price is ' +
      formatInr(holding.breakEvenSellPrice) +
      ' per share.'
    );
  }

  if (askBreakEven && holding.breakEvenSellPrice) {
    return (
      holding.symbol +
      ' break-even sell price is ' +
      formatInr(holding.breakEvenSellPrice) +
      ' per share. Your target sell price with the current app settings is ' +
      formatInr(holding.targetSellPrice) +
      ' per share.'
    );
  }

  if (askAveragePrice) {
    return holding.symbol + ' average buy price is ' + formatInr(holding.avgBuy) + ' per share for your current open holding.';
  }

  if (askQuantityOnly) {
    return (
      'You currently hold ' +
      Number(holding.qty || 0) +
      ' shares of ' +
      holding.symbol +
      '. Average buy price is ' +
      formatInr(holding.avgBuy) +
      ' and current value is ' +
      formatInr(holding.currentValue) +
      '.'
    );
  }

  if (askHoldingSummary) {
    return formatHoldingDetail(holding, context);
  }

  if (tradeSummary && /(trade summary|stock summary|trading summary|summary for|details for)/.test(text)) {
    return buildTradeSummaryAnswer(tradeSummary);
  }

  return null;
}

function sha256Hex(value) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    const n = (b < 0 ? b + 256 : b).toString(16);
    return n.length === 1 ? '0' + n : n;
  }).join('');
}

function hashPassword(password, salt) {
  const saltValue = salt || Utilities.getUuid();
  return {
    salt: saltValue,
    passwordHash: sha256Hex(String(password || '') + saltValue)
  };
}

function readUsers() {
  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      userId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      email: String(values[i][3] || '').trim(),
      passwordHash: String(values[i][4] || '').trim(),
      salt: String(values[i][5] || '').trim(),
      role: String(values[i][6] || '').trim() || 'USER',
      status: String(values[i][7] || '').trim() || 'ACTIVE',
      createdAt: String(values[i][8] || '').trim(),
      approvedAt: String(values[i][9] || '').trim(),
      approvedBy: String(values[i][10] || '').trim()
    });
  }
  return rows;
}

function readPendingUsers() {
  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      status: String(values[i][6] || '').trim().toUpperCase(),
      requestedAt: String(values[i][7] || '').trim()
    });
  }
  return rows;
}

function findActiveUserByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const users = readUsers();
  return users.find(function (row) {
    return row.status === 'ACTIVE' && row.loginId === target;
  }) || null;
}

function findUserByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const users = readUsers();
  return users.find(function (row) {
    return row.loginId === target;
  }) || null;
}

function findPendingByLoginId(loginId) {
  const target = normalizeLoginId(loginId);
  const pending = readPendingUsers();
  return pending.find(function (row) {
    return row.loginId === target;
  }) || null;
}

function findUserByUserId(userId) {
  const users = readUsers();
  return users.find(function (row) {
    return row.userId === userId;
  }) || null;
}

function createAdminSession(adminUserId) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  sheet.appendRow([Utilities.getUuid(), adminUserId, tokenHash, nowIso(), expiresAt, 'ACTIVE']);
  return token;
}

function createUserSession(userId) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const sheet = getSheet(USER_SESSIONS_SHEET, ['sessionId', 'userId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  sheet.appendRow([Utilities.getUuid(), userId, tokenHash, nowIso(), expiresAt, 'ACTIVE']);
  return token;
}

function validateUserSession(userId, token) {
  const tokenHash = sha256Hex(String(token || ''));
  const now = new Date().toISOString();
  const sheet = getSheet(USER_SESSIONS_SHEET, ['sessionId', 'userId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const rowUserId = String(values[i][1] || '').trim();
    const rowTokenHash = String(values[i][2] || '').trim();
    const expiresAt = String(values[i][4] || '').trim();
    const status = String(values[i][5] || '').trim().toUpperCase();
    if (rowUserId !== userId || rowTokenHash !== tokenHash) continue;
    if (status !== 'ACTIVE') return false;
    if (!expiresAt || expiresAt <= now) return false;
    return true;
  }
  return false;
}

function validateAdminSession(adminUserId, token) {
  const tokenHash = sha256Hex(String(token || ''));
  const now = new Date().toISOString();
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const rowUserId = String(values[i][1] || '').trim();
    const rowTokenHash = String(values[i][2] || '').trim();
    const expiresAt = String(values[i][4] || '').trim();
    const status = String(values[i][5] || '').trim().toUpperCase();
    if (rowUserId !== adminUserId || rowTokenHash !== tokenHash) continue;
    if (status !== 'ACTIVE') return false;
    if (!expiresAt || expiresAt <= now) return false;
    return true;
  }
  return false;
}

function assertAdmin(adminUserId, adminToken) {
  const user = findUserByUserId(String(adminUserId || '').trim());
  if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
    return { ok: false, message: 'Admin access required' };
  }
  if (!validateAdminSession(user.userId, adminToken)) {
    return { ok: false, message: 'Invalid admin session' };
  }
  return { ok: true, adminUser: user };
}

function assertActiveUser(userId) {
  const user = findUserByUserId(String(userId || '').trim());
  if (!user || user.status !== 'ACTIVE') {
    return { ok: false, message: 'User access required' };
  }
  return { ok: true, user: user };
}

function assertUserSession(userId, token) {
  const auth = assertActiveUser(userId);
  if (!auth.ok) return auth;
  if (!validateUserSession(auth.user.userId, token)) {
    return { ok: false, message: 'Invalid user session' };
  }
  return auth;
}

function handleLogin(body) {
  const loginId = normalizeLoginId(body.loginId);
  const password = String(body.password || '');
  if (!loginId || !password) return { ok: false, message: 'loginId and password required' };

  const user = findUserByLoginId(loginId);
  if (!user) {
    const pending = findPendingByLoginId(loginId);
    if (pending && pending.status === 'PENDING') {
      return { ok: false, message: 'Admin approval pending' };
    }
    if (pending && pending.status === 'REJECTED') {
      return { ok: false, message: 'Request rejected by admin' };
    }
    return { ok: false, message: 'Invalid credentials' };
  }

  if (user.status !== 'ACTIVE') {
    return { ok: false, message: 'Account disabled. Contact admin.' };
  }

  const computed = sha256Hex(password + user.salt);
  if (computed !== user.passwordHash) return { ok: false, message: 'Invalid credentials' };

  const sessionToken = createUserSession(user.userId);
  const adminSessionToken = user.role === 'ADMIN' ? createAdminSession(user.userId) : '';
  return {
    ok: true,
    data: {
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email || '',
        role: user.role,
        sessionToken: sessionToken,
        adminSessionToken: adminSessionToken
      }
    }
  };
}

function handleRegisterUser(body) {
  const name = String(body.name || '').trim();
  const loginId = normalizeLoginId(body.loginId);
  const password = String(body.password || '');
  const email = String(body.email || '').trim();
  if (!name || !loginId || !password) return { ok: false, message: 'name, loginId, password required' };

  const users = readUsers();
  if (users.some(function (row) { return row.loginId === loginId; })) {
    return { ok: false, message: 'Login ID already exists in Users' };
  }

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (normalizeLoginId(values[i][2]) === loginId && String(values[i][6] || '').toUpperCase() === 'PENDING') {
      return { ok: false, message: 'Request already pending' };
    }
  }

  const hashData = hashPassword(password);
  const requestId = Utilities.getUuid();
  pendingSheet.appendRow([
    requestId,
    name,
    loginId,
    email,
    hashData.passwordHash,
    hashData.salt,
    'PENDING',
    nowIso(),
    '',
    '',
    ''
  ]);

  return { ok: true, data: { requestId: requestId, message: 'Request submitted' } };
}

function handleListPending(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (status !== 'PENDING') continue;
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: normalizeLoginId(values[i][2]),
      email: String(values[i][3] || '').trim(),
      requestedAt: String(values[i][7] || '').trim(),
      status: status
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleApproveUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const role = String(body.role || 'USER').trim().toUpperCase();
  if (!requestId) return { ok: false, message: 'requestId required' };
  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;

    const loginId = normalizeLoginId(values[i][2]);
    const existing = readUsers().find(function (row) { return row.loginId === loginId; });
    if (existing) return { ok: false, message: 'Login ID already exists' };

    const usersSheet = getSheet(USERS_SHEET, [
      'userId',
      'name',
      'loginId',
      'email',
      'passwordHash',
      'salt',
      'role',
      'status',
      'createdAt',
      'approvedAt',
      'approvedBy'
    ]);
    usersSheet.appendRow([
      Utilities.getUuid(),
      String(values[i][1] || '').trim(),
      loginId,
      String(values[i][3] || '').trim().toLowerCase(),
      String(values[i][4] || '').trim(),
      String(values[i][5] || '').trim(),
      role === 'ADMIN' ? 'ADMIN' : 'USER',
      'ACTIVE',
      String(values[i][7] || '').trim(),
      nowIso(),
      auth.adminUser.userId
    ]);

    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['APPROVED', nowIso(), auth.adminUser.userId, '']]);
    return { ok: true, data: { message: 'User approved' } };
  }

  return { ok: false, message: 'Request not found' };
}

function handleRejectUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const note = String(body.note || '').trim();
  if (!requestId) return { ok: false, message: 'requestId required' };

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;
    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['REJECTED', nowIso(), auth.adminUser.userId, note]]);
    return { ok: true, data: { message: 'User rejected' } };
  }
  return { ok: false, message: 'Request not found' };
}

function handleListUsers(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const users = readUsers();
  const sanitized = users.map(function (row) {
    return {
      userId: row.userId,
      name: row.name,
      loginId: row.loginId,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy
    };
  });
  return { ok: true, data: { rows: sanitized } };
}

function handleUpdateUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const userId = String(body.userId || '').trim();
  const role = String(body.role || '').trim().toUpperCase();
  const status = String(body.status || '').trim().toUpperCase();
  if (!userId) return { ok: false, message: 'userId required' };

  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== userId) continue;
    if (role) values[i][6] = role === 'ADMIN' ? 'ADMIN' : 'USER';
    if (status) values[i][7] = status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);
    return { ok: true, data: { message: 'User updated' } };
  }

  return { ok: false, message: 'User not found' };
}

function readAdminConfig() {
  let maxSnapshots = 10;
  let livePriceRefreshSec = 60;
  let cloudSyncIntervalMin = 10;
  let snapshotDailyDays = HYBRID_DAILY_RETENTION_DAYS;
  let snapshotMonthlyMonths = HYBRID_MONTHLY_RETENTION_MONTHS;
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][0] || '').trim();
    const value = String(values[i][1] || '').trim();
    if (key === 'maxSnapshots') {
      const parsed = Number(value || 0);
      maxSnapshots = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    }
    if (key === 'livePriceRefreshSec') {
      const parsed = Number(value || 0);
      livePriceRefreshSec = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60;
    }
    if (key === 'cloudSyncIntervalMin') {
      const parsed = Number(value || 0);
      cloudSyncIntervalMin = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    }
    if (key === 'snapshotDailyDays') {
      const parsed = Number(value || 0);
      snapshotDailyDays = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : HYBRID_DAILY_RETENTION_DAYS;
    }
    if (key === 'snapshotMonthlyMonths') {
      const parsed = Number(value || 0);
      snapshotMonthlyMonths =
        Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : HYBRID_MONTHLY_RETENTION_MONTHS;
    }
  }
  return {
    maxSnapshots: maxSnapshots,
    livePriceRefreshSec: livePriceRefreshSec,
    cloudSyncIntervalMin: cloudSyncIntervalMin,
    snapshotDailyDays: snapshotDailyDays,
    snapshotMonthlyMonths: snapshotMonthlyMonths
  };
}

function setAdminConfigValue(key, value) {
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== key) continue;
    values[i][1] = String(value || '');
    sheet.getRange(i + 1, 1, 1, 2).setValues([[values[i][0], values[i][1]]]);
    return;
  }
  sheet.appendRow([key, String(value || '')]);
}

function handleGetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const config = readAdminConfig();
  return {
    ok: true,
    data: {
      maxSnapshots: config.maxSnapshots,
      livePriceRefreshSec: config.livePriceRefreshSec,
      cloudSyncIntervalMin: config.cloudSyncIntervalMin,
      snapshotDailyDays: config.snapshotDailyDays,
      snapshotMonthlyMonths: config.snapshotMonthlyMonths
    }
  };
}

function handleSetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const maxSnapshots = Math.max(1, Number(body.maxSnapshots || 10));
  const livePriceRefreshSec = Math.max(10, Number(body.livePriceRefreshSec || 60));
  const cloudSyncIntervalMin = Math.max(1, Number(body.cloudSyncIntervalMin || 10));
  const snapshotDailyDays = Math.max(1, Number(body.snapshotDailyDays || HYBRID_DAILY_RETENTION_DAYS));
  const snapshotMonthlyMonths = Math.max(1, Number(body.snapshotMonthlyMonths || HYBRID_MONTHLY_RETENTION_MONTHS));
  setAdminConfigValue('maxSnapshots', String(maxSnapshots));
  setAdminConfigValue('livePriceRefreshSec', String(livePriceRefreshSec));
  setAdminConfigValue('cloudSyncIntervalMin', String(cloudSyncIntervalMin));
  setAdminConfigValue('snapshotDailyDays', String(snapshotDailyDays));
  setAdminConfigValue('snapshotMonthlyMonths', String(snapshotMonthlyMonths));
  return { ok: true, data: { message: 'Saved' } };
}

function handleGetPublicConfig(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const config = readAdminConfig();
  return {
    ok: true,
    data: {
      maxSnapshots: config.maxSnapshots,
      livePriceRefreshSec: config.livePriceRefreshSec,
      cloudSyncIntervalMin: config.cloudSyncIntervalMin,
      snapshotDailyDays: config.snapshotDailyDays,
      snapshotMonthlyMonths: config.snapshotMonthlyMonths
    }
  };
}

function isValidIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return false;
  return dt.toISOString().slice(0, 10) === raw;
}

function fetchYahooQuote(yahooSymbol) {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(yahooSymbol);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('quote_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result =
    payload &&
    payload.quoteResponse &&
    payload.quoteResponse.result &&
    payload.quoteResponse.result[0];

  return {
    price: Number(result && result.regularMarketPrice ? result.regularMarketPrice : 0),
    previousClose: Number(result && result.regularMarketPreviousClose ? result.regularMarketPreviousClose : 0)
  };
}

function fetchYahooChart(yahooSymbol, rangeInput) {
  const range = String(rangeInput || '5d').trim() || '5d';
  const url =
    'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSymbol) +
    '?interval=1d&range=' + encodeURIComponent(range);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('chart_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) return { price: 0, previousClose: 0 };

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = (
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close
  ) || [];

  let latestClose = 0;
  for (let j = closes.length - 1; j >= 0; j -= 1) {
    const n = Number(closes[j] || 0);
    if (n > 0) {
      latestClose = n;
      break;
    }
  }

  const points = [];
  for (let i = 0; i < closes.length; i += 1) {
    const close = Number(closes[i] || 0);
    const ts = Number(timestamps[i] || 0);
    if (!(close > 0) || !(ts > 0)) continue;
    points.push({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      close: close
    });
  }

  return {
    price: Number(meta.regularMarketPrice || latestClose || 0),
    previousClose: Number(meta.previousClose || meta.chartPreviousClose || 0),
    points: points
  };
}

function toYahooSymbol(ticker) {
  const text = String(ticker || '').trim().toUpperCase();
  if (!text) return '';
  if (text.indexOf(':') >= 0) {
    const parts = text.split(':');
    const ex = String(parts[0] || '').trim();
    const sym = String(parts[1] || '').trim();
    if (!sym) return '';
    if (ex === 'NSE') return sym + '.NS';
    return sym;
  }
  if (text.indexOf('.') >= 0) return text;
  return text + '.NS';
}

function normalizeLivePriceError(message) {
  const text = String(message || '').toLowerCase();
  if (text.indexOf('script.external_request') >= 0) {
    return 'missing_external_request_permission';
  }
  if (text.indexOf('quote_http_') >= 0 || text.indexOf('chart_http_') >= 0) {
    return text.replace(/\s+/g, '_');
  }
  return 'fetch_exception';
}

function authorizeExternalRequest() {
  const res = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=INFY.NS', {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  return 'Auth check HTTP ' + String(res.getResponseCode() || 0);
}

function handleLivePrices(body) {
  const raw = body.tickers;
  const tickers = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((v) => String(v || '').trim())
      .filter((v) => !!v);

  if (!tickers.length) {
    return { ok: false, message: 'tickers required' };
  }

  const prices = {};
  const failedTickers = [];
  const failureReasons = {};
  const fetchedAt = nowIso();

  for (let i = 0; i < tickers.length; i += 1) {
    const ticker = String(tickers[i] || '').trim().toUpperCase();
    if (!ticker) continue;

    try {
      const yahooSymbol = toYahooSymbol(ticker);
      if (!yahooSymbol) {
        failedTickers.push(ticker);
        failureReasons[ticker] = 'invalid_ticker';
        continue;
      }

      let quoteReason = '';
      let chartReason = '';
      let price = 0;
      let previousClose = 0;

      try {
        const quote = fetchYahooQuote(yahooSymbol);
        price = Number(quote.price || 0);
        previousClose = Number(quote.previousClose || 0);
      } catch (quoteErr) {
        quoteReason = normalizeLivePriceError(String((quoteErr && quoteErr.message) || quoteErr || 'unknown'));
      }

      if (!(price > 0)) {
        try {
          const chart = fetchYahooChart(yahooSymbol);
          price = Number(chart.price || 0);
          if (!(previousClose > 0)) previousClose = Number(chart.previousClose || 0);
        } catch (chartErr) {
          chartReason = normalizeLivePriceError(String((chartErr && chartErr.message) || chartErr || 'unknown'));
        }
      }

      if (!(price > 0)) {
        failedTickers.push(ticker);
        if (quoteReason && chartReason) {
          failureReasons[ticker] = quoteReason + '_and_' + chartReason;
        } else if (chartReason) {
          failureReasons[ticker] = chartReason;
        } else if (quoteReason) {
          failureReasons[ticker] = quoteReason;
        } else {
          failureReasons[ticker] = 'invalid_price_from_quote_and_chart';
        }
        continue;
      }

      prices[ticker] = {
        ticker: ticker,
        price: price,
        previousClose: previousClose > 0 ? previousClose : '',
        changePct: previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : '',
        fetchedAt: fetchedAt
      };
    } catch (err) {
      failedTickers.push(ticker);
      const rawMessage = String((err && err.message) || err || 'unknown');
      failureReasons[ticker] = normalizeLivePriceError(rawMessage);
    }
  }

  if (
    failedTickers.length &&
    failedTickers.every((ticker) => String(failureReasons[ticker] || '') === 'missing_external_request_permission')
  ) {
    return {
      ok: false,
      message: 'Apps Script is missing external request permission. Run authorizeExternalRequest() once in script editor, then redeploy Web App as Execute as: Me.'
    };
  }

  return {
    ok: true,
    data: {
      prices: prices,
      success: Object.keys(prices).length,
      failedTickers: failedTickers,
      failureReasons: failureReasons
    }
  };
}

function handlePriceHistory(body) {
  const ticker = String(body.ticker || '').trim().toUpperCase();
  const days = Math.max(1, Math.min(365, Number(body.days || 7)));
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!ticker) return { ok: false, message: 'ticker required' };

  const yahooSymbol = toYahooSymbol(ticker);
  if (!yahooSymbol) return { ok: false, message: 'invalid ticker' };

  try {
    const chart = fetchYahooChart(yahooSymbol, '1y');
    let points = Array.isArray(chart.points) ? chart.points : [];

    if (from && to && isValidIsoDate(from) && isValidIsoDate(to)) {
      const fromTs = new Date(from).getTime();
      const toTs = new Date(to).getTime();
      points = points.filter((p) => {
        const ts = new Date(String(p.date || '')).getTime();
        return ts >= fromTs && ts <= toTs;
      });
    } else {
      points = points.slice(-days);
    }
    if (!points.length) {
      return { ok: false, message: 'No trading-day history found' };
    }
    return {
      ok: true,
      data: {
        ticker: ticker,
        points: points,
        latest: Number(points[points.length - 1].close || 0)
      }
    };
  } catch (err) {
    return { ok: false, message: normalizeLivePriceError(String((err && err.message) || err || 'unknown')) };
  }
}

function fetchJsonUrl(url) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });
  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('json_http_' + code);
  }
  return JSON.parse(res.getContentText() || '{}');
}

function handlePush(body) {
  const userId = String(body.userId || '').trim();
  const payload = body.payload || {};
  if (!userId) return { ok: false, message: 'userId required' };
  const auth = assertUserSession(userId, body.sessionToken);
  if (!auth.ok) return auth;
  const incomingSummary = summarizeSnapshotPayload(payload);
  const hasExistingData = listSnapshotsForUser(userId).some(function (row) {
    return !row.invalid && Number(row.totalItems || 0) > 0;
  });
  if (incomingSummary.totalItems === 0 && hasExistingData) {
    return { ok: false, message: 'Empty snapshot rejected. Restore an existing cloud snapshot instead.' };
  }

  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  sheet.appendRow([nowIso(), userId, JSON.stringify(payload)]);
  trimSnapshotsForUser(userId);
  return { ok: true, data: { message: 'Snapshot stored' } };
}

function summarizeSnapshotPayload(payload) {
  payload = payload || {};
  const trades = Array.isArray(payload.trades) ? payload.trades : [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const goals = Array.isArray(payload.goals) ? payload.goals : [];
  const recoveryPlans = Array.isArray(payload.recoveryPlans) ? payload.recoveryPlans : [];
  const reentryPlans = Array.isArray(payload.reentryPlans) ? payload.reentryPlans : [];
  const exitStrategies = Array.isArray(payload.exitStrategies) ? payload.exitStrategies : [];
  const lastTradeDate = trades.reduce(function (latest, row) {
    const value = String(row && row.tradeDate || '').trim();
    return value && value > latest ? value : latest;
  }, '');
  const lastTransactionDate = transactions.reduce(function (latest, row) {
    const value = String(row && row.date || '').trim();
    return value && value > latest ? value : latest;
  }, '');
  const totalItems =
    trades.length +
    transactions.length +
    goals.length +
    recoveryPlans.length +
    reentryPlans.length +
    exitStrategies.length;
  return {
    updatedAt: String(payload.updatedAt || ''),
    tradesCount: trades.length,
    transactionsCount: transactions.length,
    goalsCount: goals.length,
    recoveryPlansCount: recoveryPlans.length,
    reentryPlansCount: reentryPlans.length,
    exitStrategiesCount: exitStrategies.length,
    settingsPresent: Boolean(payload.settings),
    totalItems: totalItems,
    isEmpty: totalItems === 0,
    lastTradeDate: lastTradeDate,
    lastTransactionDate: lastTransactionDate
  };
}

function buildSnapshotId(rowIndex, timestamp) {
  return String(rowIndex) + '|' + Utilities.base64EncodeWebSafe(String(timestamp || ''));
}

function parseSnapshotId(snapshotId) {
  const parts = String(snapshotId || '').split('|');
  return {
    rowIndex: Number(parts[0] || 0),
    timestamp: parts.length > 1 ? Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString() : ''
  };
}

function listSnapshotsForUser(userId) {
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;
    const timestamp = String(values[i][0] || '').trim();
    try {
      const payload = JSON.parse(String(values[i][2] || '{}'));
      const summary = summarizeSnapshotPayload(payload);
      rows.push(Object.assign({
        snapshotId: buildSnapshotId(i + 1, timestamp),
        timestamp: timestamp,
        rowIndex: i + 1
      }, summary));
    } catch (err) {
      rows.push({
        snapshotId: buildSnapshotId(i + 1, timestamp),
        timestamp: timestamp,
        rowIndex: i + 1,
        updatedAt: '',
        tradesCount: 0,
        transactionsCount: 0,
        goalsCount: 0,
        recoveryPlansCount: 0,
        reentryPlansCount: 0,
        exitStrategiesCount: 0,
        settingsPresent: false,
        totalItems: 0,
        isEmpty: true,
        invalid: true,
        lastTradeDate: '',
        lastTransactionDate: ''
      });
    }
  }
  rows.sort(function (a, b) {
    return String(b.timestamp || '').localeCompare(String(a.timestamp || '')) || b.rowIndex - a.rowIndex;
  });
  return rows;
}

function findSnapshotPayload(userId, snapshotId) {
  const parsed = parseSnapshotId(snapshotId);
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const candidates = [];
  if (parsed.rowIndex > 1 && parsed.rowIndex <= values.length) {
    candidates.push(parsed.rowIndex);
  }
  for (let i = values.length - 1; i >= 1; i -= 1) {
    candidates.push(i + 1);
  }
  const seen = {};
  for (let j = 0; j < candidates.length; j += 1) {
    const rowIndex = candidates[j];
    if (seen[rowIndex]) continue;
    seen[rowIndex] = true;
    const row = values[rowIndex - 1];
    if (!row || String(row[1] || '').trim() !== userId) continue;
    const timestamp = String(row[0] || '').trim();
    if (parsed.timestamp && timestamp !== parsed.timestamp && rowIndex !== parsed.rowIndex) continue;
    return JSON.parse(String(row[2] || '{}'));
  }
  return null;
}

function handleListSnapshots(body) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };
  const auth = assertUserSession(userId, body.sessionToken);
  if (!auth.ok) return auth;
  const limit = Math.max(1, Math.min(100, Number(body.limit || 30)));
  const rows = listSnapshotsForUser(userId).slice(0, limit);
  return { ok: true, data: { rows: rows } };
}

function handleRestoreSnapshot(body) {
  const userId = String(body.userId || '').trim();
  const snapshotId = String(body.snapshotId || '').trim();
  if (!userId || !snapshotId) return { ok: false, message: 'userId and snapshotId required' };
  const auth = assertUserSession(userId, body.sessionToken);
  if (!auth.ok) return auth;
  const payload = findSnapshotPayload(userId, snapshotId);
  if (!payload) return { ok: false, message: 'Snapshot not found' };
  const summary = summarizeSnapshotPayload(payload);
  if (summary.totalItems === 0) {
    return { ok: false, message: 'Empty snapshots cannot be restored.' };
  }
  const restored = Object.assign({}, payload, { updatedAt: nowIso() });
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  sheet.appendRow([nowIso(), userId, JSON.stringify(restored)]);
  trimSnapshotsForUser(userId);
  return {
    ok: true,
    data: {
      payload: restored,
      summary: summarizeSnapshotPayload(restored),
      message: 'Snapshot restored'
    }
  };
}

function handlePull(e) {
  const userId = String(e.parameter.userId || '').trim();
  const sessionToken = String(e.parameter.sessionToken || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };
  const auth = assertUserSession(userId, sessionToken);
  if (!auth.ok) return auth;

  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;
    try {
      const payload = JSON.parse(String(values[i][2] || '{}'));
      trimSnapshotsForUser(userId);
      return { ok: true, data: { payload: payload } };
    } catch (err) {
      return { ok: false, message: 'Invalid payload data' };
    }
  }
  return { ok: false, message: 'No snapshot found' };
}

function trimSnapshotsForUser(userId) {
  const config = readAdminConfig();
  const maxSnapshots = Math.max(1, Number(config.maxSnapshots || 10));
  const dailyDays = Math.max(1, Number(config.snapshotDailyDays || HYBRID_DAILY_RETENTION_DAYS));
  const monthlyMonths = Math.max(1, Number(config.snapshotMonthlyMonths || HYBRID_MONTHLY_RETENTION_MONTHS));
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;
    const ts = String(values[i][0] || '').trim();
    const date = ts ? new Date(ts) : null;
    const time = date && !isNaN(date.getTime()) ? date.getTime() : 0;
    rows.push({ rowIndex: i + 1, time: time, date: date });
  }
  if (rows.length <= maxSnapshots) return 0;

  rows.sort(function (a, b) {
    return b.time - a.time || b.rowIndex - a.rowIndex;
  });

  const keep = {};
  const dailyKept = {};
  const monthlyKept = {};
  const now = new Date();
  const dailyCutoff = new Date(now.getTime() - (dailyDays - 1) * 24 * 60 * 60 * 1000);
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const minMonthIndex = monthIndex - (monthlyMonths - 1);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i < maxSnapshots) {
      keep[row.rowIndex] = true;
      continue;
    }
    if (!row.date || !row.time) continue;
    if (row.time >= dailyCutoff.getTime()) {
      const dayKey = Utilities.formatDate(row.date, 'GMT', 'yyyy-MM-dd');
      if (!dailyKept[dayKey]) {
        keep[row.rowIndex] = true;
        dailyKept[dayKey] = true;
        continue;
      }
    }
    const rowMonthIndex = row.date.getUTCFullYear() * 12 + row.date.getUTCMonth();
    if (rowMonthIndex >= minMonthIndex) {
      const monthKey = Utilities.formatDate(row.date, 'GMT', 'yyyy-MM');
      if (!monthlyKept[monthKey]) {
        keep[row.rowIndex] = true;
        monthlyKept[monthKey] = true;
      }
    }
  }

  const toDelete = [];
  for (let j = 0; j < rows.length; j += 1) {
    const rowIndex = rows[j].rowIndex;
    if (!keep[rowIndex]) {
      toDelete.push(rowIndex);
    }
  }
  if (!toDelete.length) return 0;
  toDelete.sort(function (a, b) { return b - a; });
  for (let k = 0; k < toDelete.length; k += 1) {
    sheet.deleteRow(toDelete[k]);
  }
  return toDelete.length;
}

function trimSnapshotsForAllUsers() {
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const userIds = {};
  for (let i = 1; i < values.length; i += 1) {
    const userId = String(values[i][1] || '').trim();
    if (userId) userIds[userId] = true;
  }
  let deleted = 0;
  for (var id in userIds) {
    deleted += trimSnapshotsForUser(id);
  }
  return deleted;
}

function handleTrimSnapshots(body) {
  const userId = String(body.userId || '').trim();
  if (userId) {
    const deleted = trimSnapshotsForUser(userId);
    return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
  }
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const deleted = trimSnapshotsForAllUsers();
  return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
}

function createAdminDirect(name, loginId, password, email) {
  const n = String(name || '').trim();
  const l = normalizeLoginId(loginId);
  const p = String(password || '');
  const e = String(email || '').trim().toLowerCase();
  if (!n || !l || !p) throw new Error('name, loginId, password required');

  const users = readUsers();
  const existingAdmin = users.find(function (row) { return row.role === 'ADMIN'; });
  if (existingAdmin) throw new Error('Admin already exists. Use update_user to promote users.');
  const existing = users.find(function (row) { return row.loginId === l; });
  if (existing) throw new Error('Login ID already exists');

  const hashData = hashPassword(p);
  const usersSheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  usersSheet.appendRow([
    Utilities.getUuid(),
    n,
    l,
    e,
    hashData.passwordHash,
    hashData.salt,
    'ADMIN',
    'ACTIVE',
    nowIso(),
    nowIso(),
    'system'
  ]);
  return 'Admin created';
}

function handleListNseMaster(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      symbol: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      isin: String(values[i][2] || '').trim(),
      updatedAt: String(values[i][3] || '').trim(),
      updatedBy: String(values[i][4] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleListNseMasterUser(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      symbol: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      isin: String(values[i][2] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleReplaceNseMaster(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const sheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 5).setValues([['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']]);
  const now = nowIso();
  const output = [];
  rows.forEach(function (row) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const name = String(row.name || '').trim();
    const isin = String(row.isin || '').trim();
    if (!symbol || !name) return;
    output.push([symbol, name, isin, now, auth.adminUser.userId]);
  });
  if (output.length) {
    sheet.getRange(2, 1, output.length, 5).setValues(output);
  }
  return { ok: true, data: { rows: output.length } };
}

function handleListTickerRequests(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== auth.user.userId) continue;
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      userId: String(values[i][1] || '').trim(),
      userName: String(values[i][2] || '').trim(),
      rawSymbol: String(values[i][3] || '').trim(),
      status: String(values[i][4] || '').trim().toUpperCase() || 'PENDING',
      requestedAt: String(values[i][5] || '').trim(),
      resolvedAt: String(values[i][6] || '').trim(),
      resolvedBy: String(values[i][7] || '').trim(),
      resolvedTicker: String(values[i][8] || '').trim(),
      note: String(values[i][9] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleListTickerRequestsAdmin(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      userId: String(values[i][1] || '').trim(),
      userName: String(values[i][2] || '').trim(),
      rawSymbol: String(values[i][3] || '').trim(),
      status: String(values[i][4] || '').trim().toUpperCase(),
      requestedAt: String(values[i][5] || '').trim(),
      resolvedAt: String(values[i][6] || '').trim(),
      resolvedBy: String(values[i][7] || '').trim(),
      resolvedTicker: String(values[i][8] || '').trim(),
      note: String(values[i][9] || '').trim()
    });
  }
  return { ok: true, data: { rows: rows } };
}

function handleCreateTickerRequest(body) {
  const auth = assertActiveUser(body.userId);
  if (!auth.ok) return auth;
  const rawSymbol = String(body.rawSymbol || '').trim();
  const symbol = normalizeSymbol(rawSymbol);
  const note = String(body.note || '').trim();
  if (!symbol) return { ok: false, message: 'Symbol required' };

  const masterSheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
  const masterValues = masterSheet.getDataRange().getValues();
  for (let i = 1; i < masterValues.length; i += 1) {
    if (normalizeSymbol(masterValues[i][0]) === symbol) {
      return { ok: false, message: 'Ticker already exists in NSE master' };
    }
  }

  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (
      String(values[i][1] || '').trim() === auth.user.userId &&
      normalizeSymbol(values[i][3]) === symbol &&
      String(values[i][4] || '').trim().toUpperCase() === 'PENDING'
    ) {
      return { ok: false, message: 'Request already pending for this ticker' };
    }
  }

  const requestId = Utilities.getUuid();
  sheet.appendRow([
    requestId,
    auth.user.userId,
    String(body.userName || auth.user.name || '').trim(),
    rawSymbol,
    'PENDING',
    nowIso(),
    '',
    '',
    '',
    note
  ]);
  return { ok: true, data: { requestId: requestId } };
}

function handleResolveTickerRequest(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;
  const requestId = String(body.requestId || '').trim();
  const status = String(body.status || '').trim().toUpperCase();
  const resolvedTicker = String(body.resolvedTicker || '').trim();
  const resolvedName = String(body.resolvedName || '').trim();
  const note = String(body.note || '').trim();
  if (!requestId) return { ok: false, message: 'requestId required' };

  const sheet = getSheet(TICKER_REQUESTS_SHEET, [
    'requestId',
    'userId',
    'userName',
    'rawSymbol',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'resolvedTicker',
    'note'
  ]);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== requestId) continue;
    const nextStatus = status || 'APPROVED';
    const rawSymbol = String(values[i][3] || '').trim();
    const finalTicker = resolvedTicker || rawSymbol;
    values[i][4] = nextStatus;
    values[i][6] = nowIso();
    values[i][7] = auth.adminUser.userId;
    values[i][8] = finalTicker;
    values[i][9] = note;
    sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);

    if (nextStatus === 'APPROVED' && finalTicker) {
      const nseSheet = getSheet(NSE_MASTER_SHEET, ['symbol', 'name', 'isin', 'updatedAt', 'updatedBy']);
      const nseValues = nseSheet.getDataRange().getValues();
      const normalized = normalizeSymbol(finalTicker);
      const companyName = resolvedName || rawSymbol || finalTicker;
      let updated = false;
      for (let j = 1; j < nseValues.length; j += 1) {
        if (normalizeSymbol(nseValues[j][0]) === normalized) {
          nseValues[j][1] = companyName;
          nseValues[j][3] = nowIso();
          nseValues[j][4] = auth.adminUser.userId;
          nseSheet.getRange(j + 1, 1, 1, nseValues[j].length).setValues([nseValues[j]]);
          updated = true;
          break;
        }
      }
      if (!updated) {
        nseSheet.appendRow([normalized, companyName, '', nowIso(), auth.adminUser.userId]);
      }
    }
    return { ok: true, data: { message: 'Ticker request updated' } };
  }
  return { ok: false, message: 'Request not found' };
}
