const { getPriceForModel, calculateTurnAic } = require("./pricing");
function parseJsonl(text) {
  if (!text) return [];
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

function deriveModelId(row) {
  const attrsModel = row && row.attrs && row.attrs.model;
  if (attrsModel) return String(attrsModel);
  const name = row && row.name ? String(row.name) : "";
  const match = name.match(/^chat:(.+)$/);
  if (match) return match[1];
  return "unknown";
}

function extractChatSessionTurns(chatSessionText) {
  if (!chatSessionText) return [];

  const turns = [];

  // Primary strategy: parse full snapshots (kind=0) and read per-request usage directly.
  for (const rawLine of chatSessionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const requests = row && row.kind === 0 && row.v && Array.isArray(row.v.requests)
      ? row.v.requests
      : null;
    if (!requests) continue;

    for (const req of requests) {
      const input = Number((req && (req.promptTokens ?? req.inputTokens)) || 0);
      const output = Number((req && (req.completionTokens ?? req.outputTokens)) || 0);
      const modelId = String(
        (req && (req.resolvedModel || req.modelId || (req.inputState && req.inputState.selectedModel && req.inputState.selectedModel.metadata && req.inputState.selectedModel.metadata.id))) ||
        "unknown"
      ).trim() || "unknown";

      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      if (input <= 0 && output <= 0) continue;
      turns.push({ modelId, input, output });
    }
  }

  // Secondary strategy: regex extraction for incremental/patch rows that still contain usage fragments.
  const patterns = [
    /"(?:promptTokens|inputTokens)"\s*:\s*(\d+)[\s\S]{0,1200}?"(?:completionTokens|outputTokens)"\s*:\s*(\d+)[\s\S]{0,2000}?"(?:modelId|resolvedModel|model)"\s*:\s*"([^"]+)"/g,
    /"(?:modelId|resolvedModel|model)"\s*:\s*"([^"]+)"[\s\S]{0,2000}?"(?:promptTokens|inputTokens)"\s*:\s*(\d+)[\s\S]{0,1200}?"(?:completionTokens|outputTokens)"\s*:\s*(\d+)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(chatSessionText)) !== null) {
      const modelFirst = pattern === patterns[1];
      const modelId = String(modelFirst ? match[1] : match[3] || "unknown").trim() || "unknown";
      const input = Number(modelFirst ? match[2] : match[1] || 0);
      const output = Number(modelFirst ? match[3] : match[2] || 0);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      if (input <= 0 && output <= 0) continue;
      turns.push({ modelId, input, output });
    }
  }

  if (turns.length <= 1) return turns;

  // Some snapshots may repeat near-identical fragments; dedupe exact triplets while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const turn of turns) {
    const key = `${turn.modelId}|${turn.input}|${turn.output}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(turn);
  }
  return deduped;
}

function buildSessionFromFallbackTurns(sessionId, baseSummary, turns, priceMap) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let aic = 0;
  let missingPriceTurns = 0;
  const modelAgg = new Map();

  for (const turn of turns) {
    const input = Math.max(0, Number(turn.input || 0));
    const output = Math.max(0, Number(turn.output || 0));
    const cached = 0;
    const modelId = String(turn.modelId || "unknown");

    inputTokens += input;
    outputTokens += output;
    cachedTokens += cached;

    const prices = getPriceForModel(priceMap, modelId);
    const turnPricing = calculateTurnAic(input, cached, output, prices);
    const turnAic = turnPricing.aic;
    if (!prices) {
      missingPriceTurns += 1;
    }
    aic += turnAic;

    const current = modelAgg.get(modelId) || { model: modelId, turns: 0, aic: 0 };
    current.turns += 1;
    current.aic += turnAic;
    modelAgg.set(modelId, current);
  }

  return {
    sessionId,
    title: baseSummary.title || null,
    startTs: baseSummary.startTs || null,
    endTs: baseSummary.endTs || null,
    modelTurns: turns.length,
    toolCalls: baseSummary.toolCalls || 0,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    errors: baseSummary.errors || 0,
    aic,
    missingPriceTurns,
    autoDiscountTurns: 0,
    autoDiscountAmount: 0,
    modelAgg: [...modelAgg.values()].sort((a, b) => b.aic - a.aic)
  };
}

function isAutoModelRequest(row) {
  const attrs = (row && row.attrs) || {};
  const model = String(attrs.model || "").trim().toLowerCase();
  const name = String((row && row.name) || "").trim().toLowerCase();
  const selectionMode = String(attrs.modelSelection || attrs.routingMode || attrs.route || "").trim().toLowerCase();

  if (model === "auto" || model === "gpt-auto" || model.startsWith("auto/")) return true;
  if (name === "chat:auto" || name.startsWith("chat:auto:")) return true;
  if (selectionMode.includes("auto")) return true;
  return false;
}

function isMeaningfulSessionStartEvent(row) {
  if (!row || !row.type) return false;
  const type = String(row.type);
  return type === "session_start" ||
    type === "user_message" ||
    type === "turn_start" ||
    type === "llm_request" ||
    type === "agent_response" ||
    type === "tool_call" ||
    type === "turn_end";
}

function analyzeSession(sessionId, rows, priceMap, title = null) {
  let minTsAny = Number.POSITIVE_INFINITY;
  let minTsMeaningful = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  let modelTurns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let errors = 0;
  let aic = 0;
  let missingPriceTurns = 0;
  let autoDiscountTurns = 0;
  let autoDiscountAmount = 0;
  const modelAgg = new Map();

  for (const row of rows) {
    const ts = Number(row && row.ts);
    if (Number.isFinite(ts)) {
      if (ts < minTsAny) minTsAny = ts;
      if (isMeaningfulSessionStartEvent(row) && ts < minTsMeaningful) minTsMeaningful = ts;
      if (ts > maxTs) maxTs = ts;
    }

    if (row && row.status && row.status !== "ok") errors += 1;
    if (row && row.type === "tool_call") toolCalls += 1;

    if (row && row.type === "llm_request") {
      modelTurns += 1;
      const attrs = (row && row.attrs) || {};
      const modelId = deriveModelId(row);
      const input = Number(attrs.inputTokens || 0);
      const output = Number(attrs.outputTokens || 0);
      const cached = Number(attrs.cachedTokens || 0);
      const uncached = Math.max(0, input - cached);

      inputTokens += input;
      outputTokens += output;
      cachedTokens += cached;

      const prices = getPriceForModel(priceMap, modelId);
      const discounted = isAutoModelRequest(row);
      const turnPricing = calculateTurnAic(input, cached, output, prices, discounted);
      const turnAic = turnPricing.aic;
      if (prices && discounted) {
        autoDiscountTurns += 1;
        autoDiscountAmount += turnPricing.discountedAmount;
      }
      if (!prices) {
        missingPriceTurns += 1;
      }
      aic += turnAic;

      const current = modelAgg.get(modelId) || { model: modelId, turns: 0, aic: 0 };
      current.turns += 1;
      current.aic += turnAic;
      modelAgg.set(modelId, current);
    }
  }

  return {
    sessionId,
    title,
    startTs: Number.isFinite(minTsMeaningful)
      ? minTsMeaningful
      : (Number.isFinite(minTsAny) ? minTsAny : null),
    endTs: Number.isFinite(maxTs) ? maxTs : null,
    modelTurns,
    toolCalls,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    errors,
    aic,
    missingPriceTurns,
    autoDiscountTurns,
    autoDiscountAmount,
    modelAgg: [...modelAgg.values()].sort((a, b) => b.aic - a.aic)
  };
}


module.exports = { parseJsonl, deriveModelId, extractChatSessionTurns, buildSessionFromFallbackTurns, isAutoModelRequest, isMeaningfulSessionStartEvent, analyzeSession };
