const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");
const xlsx = require("xlsx");
const Database = require("better-sqlite3");

const HOST = "127.0.0.1";
const PORT = 4781;
const AUTO_AIC_DISCOUNT_FACTOR = 0.9;
const BASE_DIR = __dirname;
const DASHBOARD_FILE = path.join(BASE_DIR, "copilot-cost-dashboard.html");
const rootCaches = new Map();
const copilotDbHandles = new Map();
let hasLoggedFirstRequest = false;

function color(text, code) {
  if (!process.stdout || !process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function logInfo(text) {
  console.log(color(text, "96"));
}

function logSuccess(text) {
  console.log(color(text, "92"));
}

function logTitle(text) {
  console.log(color(text, "97;1"));
}

function getDefaultRoot() {
  return os.homedir();
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

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

function buildModelPriceMap(modelsText) {
  const map = new Map();
  if (!modelsText) return map;
  try {
    const data = JSON.parse(modelsText);
    if (!Array.isArray(data)) return map;
    for (const item of data) {
      const prices = item && item.billing && item.billing.token_prices && item.billing.token_prices.default;
      const multiplier = Number((item && item.billing && item.billing.multiplier) || 0);
      if (!item || !item.id) continue;

      let normalized = null;
      if (prices) {
        normalized = {
          input_price: Number(prices.input_price || 0),
          output_price: Number(prices.output_price || 0),
          cache_price: Number(prices.cache_price || 0)
        };
      } else if (Number.isFinite(multiplier) && multiplier > 0) {
        // Newer model catalogs expose a multiplier instead of token_prices.
        // Use multiplier as a pragmatic fallback to keep AIC/EUR non-zero.
        normalized = {
          input_price: multiplier,
          output_price: multiplier,
          cache_price: multiplier
        };
      }

      if (!normalized) continue;
      map.set(String(item.id), normalized);
      if (item.version) map.set(String(item.version), normalized);
      if (item.name) map.set(String(item.name), normalized);
    }
  } catch {
    return map;
  }
  return map;
}

function deriveModelId(row) {
  const attrsModel = row && row.attrs && row.attrs.model;
  if (attrsModel) return String(attrsModel);
  const name = row && row.name ? String(row.name) : "";
  const match = name.match(/^chat:(.+)$/);
  if (match) return match[1];
  return "unknown";
}

function getPriceForModel(priceMap, modelId) {
  if (priceMap.has(modelId)) return priceMap.get(modelId);

  const target = String(modelId || "").toLowerCase();
  for (const [k, v] of priceMap.entries()) {
    const source = String(k || "").toLowerCase();
    if (source.includes(target) || target.includes(source)) return v;
  }
  return null;
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

function extractTitleFromChatSessionText(chatSessionText) {
  if (!chatSessionText) return null;

  let latestCustomTitle = null;
  let fallbackTitle = null;

  for (const rawLine of chatSessionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (!row) continue;

    if (row.kind === 1 && Array.isArray(row.k) && row.k.includes("customTitle")) {
      const customTitle = String(row.v || "").trim();
      if (customTitle) latestCustomTitle = customTitle;
      continue;
    }

    if (row.kind !== 0 || !row.v) continue;

    const customTitle = String(row.v.customTitle || "").trim();
    if (customTitle) latestCustomTitle = customTitle;

    const requests = Array.isArray(row.v.requests) ? row.v.requests : [];
    if (fallbackTitle) continue;
    for (const req of requests) {
      const messageText = String(req && req.message && req.message.text || "").trim();
      if (messageText) {
        fallbackTitle = messageText.slice(0, 120);
        break;
      }
    }
  }

  return latestCustomTitle || fallbackTitle;
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
    let turnAic = 0;
    if (prices) {
      turnAic = ((input * prices.input_price) + (cached * prices.cache_price) + (output * prices.output_price)) / 1000000;
    } else {
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

function findTitleLogFile(rows) {
  for (const row of rows) {
    if (!row || row.type !== "child_session_ref") continue;
    const attrs = row.attrs || {};
    if (row.name === "title" || attrs.label === "title") {
      const childLogFile = attrs.childLogFile;
      if (childLogFile && String(childLogFile).trim()) return String(childLogFile).trim();
    }
  }
  return null;
}

function findChildSessionLogFiles(rows) {
  const childFiles = [];
  for (const row of rows) {
    if (!row || row.type !== "child_session_ref") continue;
    const attrs = row.attrs || {};
    const childLogFile = attrs.childLogFile;
    if (childLogFile && String(childLogFile).trim() && (row.name !== "title" && attrs.label !== "title")) {
      childFiles.push(String(childLogFile).trim());
    }
  }
  return childFiles;
}

function extractTitleFromTitleRows(rows) {
  for (const row of rows) {
    if (!row || row.type !== "agent_response") continue;
    const response = row.attrs && row.attrs.response;
    if (!response || typeof response !== "string") continue;
    try {
      const parsed = JSON.parse(response);
      if (!Array.isArray(parsed)) continue;
      for (const msg of parsed) {
        if (!msg || msg.role !== "assistant" || !Array.isArray(msg.parts)) continue;
        for (const part of msg.parts) {
          if (!part || part.type !== "text") continue;
          const text = String(part.content || "").trim();
          if (text) return text;
        }
      }
    } catch {
      // ignore malformed title payload
    }
  }
  return null;
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
      let turnAic = 0;
      if (prices) {
        const rawAic = ((uncached * prices.input_price) + (cached * prices.cache_price) + (output * prices.output_price)) / 1000000;
        if (isAutoModelRequest(row)) {
          autoDiscountTurns += 1;
          autoDiscountAmount += rawAic * (1 - AUTO_AIC_DISCOUNT_FACTOR);
          turnAic = rawAic * AUTO_AIC_DISCOUNT_FACTOR;
        } else {
          turnAic = rawAic;
        }
      } else {
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

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function decodeFileUri(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("file:")) return raw;
  try {
    const url = new URL(raw);
    const pathname = decodeURIComponent(url.pathname);
    return pathname.replace(/^\/([A-Za-z]):/, "$1:").replace(/\//g, path.sep);
  } catch {
    return raw.replace(/^file:\/\//, "").replace(/\//g, path.sep);
  }
}

function lineCount(text) {
  const value = String(text || "");
  return value ? value.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
}

function editingStatusFromSignal(signal) {
  const eventKind = Number(signal && signal.eventKind);
  if (eventKind === 1) return "accepted";
  if (eventKind === 2) return "rejected";
  if (eventKind === 3) return "manual";
  const state = Number(signal && signal.state);
  if (state === 1) return "accepted";
  if (state === 2) return "rejected";
  if (state === 0) return "inferred";
  return "inferred";
}

function collectEditedFileSignals(value, signals = [], requestId = null) {
  if (!value || typeof value !== "object") return signals;
  if (Array.isArray(value)) {
    for (const item of value) collectEditedFileSignals(item, signals, requestId);
    return signals;
  }
  const currentRequestId = value.requestId || requestId;
  if (Array.isArray(value.editedFileEvents)) {
    for (const event of value.editedFileEvents) {
      signals.push({
        requestId: currentRequestId ? String(currentRequestId) : null,
        uri: event && event.uri && (event.uri.fsPath || event.uri.external || event.uri.path),
        eventKind: event && event.eventKind,
        state: event && event.state
      });
    }
  }
  for (const child of Object.values(value)) collectEditedFileSignals(child, signals, currentRequestId);
  return signals;
}

function buildEditingSignalMap(chatSessionText) {
  const map = new Map();
  for (const row of parseJsonl(chatSessionText || "")) {
    for (const signal of collectEditedFileSignals(row)) {
      if (!signal.requestId && !signal.uri) continue;
      const uri = decodeFileUri(signal.uri);
      const key = `${signal.requestId || "*"}|${uri || "*"}`;
      map.set(key, editingStatusFromSignal(signal));
      if (uri) {
        const wildcardKey = `*|${path.normalize(uri)}`;
        const previous = map.get(wildcardKey);
        const current = editingStatusFromSignal(signal);
        map.set(wildcardKey, previous && previous !== current ? "inferred" : current);
      }
    }
  }
  return map;
}

function getEditingStatus(signalMap, requestId, uri) {
  const normalizedUri = path.normalize(String(uri || ""));
  return signalMap.get(`${requestId || "*"}|${normalizedUri}`) ||
    signalMap.get(`${requestId || "*"}|${String(uri || "")}`) ||
    signalMap.get(`*|${normalizedUri}`) ||
    "inferred";
}

function countLineChanges(beforeText, afterText) {
  const before = String(beforeText || "").split(/\r?\n/);
  const after = String(afterText || "").split(/\r?\n/);
  const dp = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const unchanged = dp[0][0];
  return {
    added: Math.max(0, after.length - unchanged),
    removed: Math.max(0, before.length - unchanged)
  };
}

function buildSnapshotSignalMap(state) {
  const map = new Map();
  const entries = state && state.recentSnapshot && Array.isArray(state.recentSnapshot.entries)
    ? state.recentSnapshot.entries
    : [];
  for (const entry of entries) {
    const requestId = entry && entry.telemetryInfo && entry.telemetryInfo.requestId;
    const uri = decodeFileUri(entry && (entry.resource || entry.snapshotUri));
    if (!requestId || !uri || !entry || !Number.isFinite(Number(entry.state))) continue;
    const status = editingStatusFromSignal({ state: entry.state });
    map.set(String(requestId), status);
    map.set(`${requestId}|${path.normalize(uri)}`, status);
  }
  return map;
}

function getSnapshotRequestIds(state) {
  const entries = state && state.recentSnapshot && Array.isArray(state.recentSnapshot.entries)
    ? state.recentSnapshot.entries
    : [];
  return new Set(entries
    .map((entry) => entry && entry.telemetryInfo && entry.telemetryInfo.requestId)
    .filter(Boolean)
    .map(String));
}

function getLatestRequestId(state) {
  const checkpoints = state && state.timeline && Array.isArray(state.timeline.checkpoints)
    ? state.timeline.checkpoints
    : [];
  return checkpoints.reduce((latest, checkpoint) => {
    if (!checkpoint || !checkpoint.requestId) return latest;
    return !latest || Number(checkpoint.epoch || 0) > Number(latest.epoch || 0)
      ? checkpoint
      : latest;
  }, null)?.requestId || null;
}

function buildTimelineSignalMap(state) {
  const map = new Map();
  const checkpoints = state && state.timeline && Array.isArray(state.timeline.checkpoints)
    ? state.timeline.checkpoints
    : [];
  for (const checkpoint of checkpoints) {
    if (!checkpoint || !checkpoint.requestId) continue;
    if (checkpoint.undoStopId) {
      map.set(String(checkpoint.requestId), "rejected");
    }
  }
  return map;
}

function getBaselineContent(state, requestId, uri) {
  const baselines = state && state.timeline && Array.isArray(state.timeline.fileBaselines)
    ? state.timeline.fileBaselines
    : [];
  const target = path.normalize(String(uri || ""));
  for (const item of baselines) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const baseline = item[1] || {};
    const baselineUri = decodeFileUri(baseline.uri && (baseline.uri.fsPath || baseline.uri.external || baseline.uri.path));
    if (baseline.requestId === requestId && baselineUri && path.normalize(baselineUri) === target) {
      return baseline.content;
    }
  }
  return null;
}

function getOperationLines(operation, baselineContent = null) {
  if (!operation) return { added: 0, removed: 0 };
  if (operation.type === "create") return { added: lineCount(operation.initialContent), removed: 0 };
  if (operation.type === "delete") return { added: 0, removed: lineCount(operation.content || operation.initialContent) };
  const edit = Array.isArray(operation.edits) ? operation.edits[0] : null;
  const range = edit && edit.range;
  if (baselineContent !== null && range && Number(range.startLineNumber) <= 1 &&
      Number(range.endLineNumber) >= lineCount(baselineContent)) {
    return countLineChanges(baselineContent, edit && edit.text);
  }
  return {
    added: lineCount(edit && edit.text),
    removed: range ? Math.max(0, Number(range.endLineNumber || 0) - Number(range.startLineNumber || 0)) : 0
  };
}

function summarizeEditingOperations(stateText, signalMap) {
  const empty = {
    available: false,
    files: 0,
    operations: 0,
    addedAccepted: 0,
    removedAccepted: 0,
    addedRejected: 0,
    removedRejected: 0,
    addedManual: 0,
    removedManual: 0,
    addedInferred: 0,
    removedInferred: 0,
    details: []
  };
  if (!stateText) return empty;
  let state;
  try {
    state = JSON.parse(stateText);
  } catch {
    return empty;
  }
  const operations = state.timeline && Array.isArray(state.timeline.operations) ? state.timeline.operations : [];
  if (!operations.length) return { ...empty, available: true };
  const snapshotSignalMap = buildSnapshotSignalMap(state);
  const snapshotRequestIds = getSnapshotRequestIds(state);
  const latestRequestId = getLatestRequestId(state);
  const timelineSignalMap = buildTimelineSignalMap(state);
  const seen = new Set();
  const byFile = new Map();
  for (const operation of operations) {
    const uri = decodeFileUri(operation.uri && (operation.uri.fsPath || operation.uri.external || operation.uri.path)) || "(file non identificato)";
    const edit = Array.isArray(operation.edits) ? operation.edits[0] : null;
    const signature = JSON.stringify([
      operation.requestId || null, operation.epoch || null, operation.type || null, uri,
      edit && edit.range ? edit.range : null, edit && edit.text ? edit.text : operation.initialContent || ""
    ]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const transcriptStatus = getEditingStatus(signalMap, operation.requestId, uri);
    const isActiveRequest = String(operation.requestId || "") === String(latestRequestId || "") ||
      snapshotRequestIds.has(String(operation.requestId || ""));
    const status = isActiveRequest
      ? (snapshotSignalMap.get(String(operation.requestId || "")) ||
        snapshotSignalMap.get(`${operation.requestId || "*"}|${path.normalize(uri)}`) || "inferred")
      : (transcriptStatus !== "inferred"
        ? transcriptStatus
        : (timelineSignalMap.get(String(operation.requestId || "")) || "inferred"));
    const lines = getOperationLines(operation, getBaselineContent(state, operation.requestId, uri));
    const detail = byFile.get(uri) || { file: uri, operations: 0, added: 0, removed: 0, statuses: [] };
    detail.operations += 1;
    detail.added += lines.added;
    detail.removed += lines.removed;
    detail.statuses.push({ status, operation: operation.type || "unknown", requestId: operation.requestId || null, epoch: operation.epoch || null, added: lines.added, removed: lines.removed });
    byFile.set(uri, detail);
    empty.operations += 1;
    empty[`${status === "manual" ? "addedManual" : status === "accepted" ? "addedAccepted" : status === "rejected" ? "addedRejected" : "addedInferred"}`] += lines.added;
    empty[`${status === "manual" ? "removedManual" : status === "accepted" ? "removedAccepted" : status === "rejected" ? "removedRejected" : "removedInferred"}`] += lines.removed;
  }
  empty.available = true;
  empty.files = byFile.size;
  empty.details = [...byFile.values()];
  return empty;
}

function summarizeStateEditingOperations(rows) {
  const summary = {
    available: false,
    files: 0,
    operations: 0,
    addedAccepted: 0,
    removedAccepted: 0,
    addedRejected: 0,
    removedRejected: 0,
    addedManual: 0,
    removedManual: 0,
    addedInferred: 0,
    removedInferred: 0,
    details: []
  };
  const completions = new Map();
  for (const row of rows) {
    if (!row || row.type !== "tool.execution_complete") continue;
    const data = row.data || {};
    if (data.toolCallId) completions.set(String(data.toolCallId), data);
  }

  const byFile = new Map();
  for (const row of rows) {
    if (!row || row.type !== "tool.execution_start") continue;
    const data = row.data || {};
    const toolName = String(data.toolName || "").toLowerCase();
    if (!["apply_patch", "edit", "edit_file", "create_file", "delete_file"].includes(toolName)) continue;

    const rawArgs = typeof data.arguments === "string"
      ? data.arguments
      : JSON.stringify(data.arguments || {});
    const completion = completions.get(String(data.toolCallId || ""));
    const status = completion && completion.success === false ? "rejected" : (completion ? "accepted" : "inferred");
    const files = [...rawArgs.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)/g)].map((match) => match[1].trim());
    const targets = files.length ? files : ["(file non identificato)"];
    const added = (rawArgs.match(/^\+(?!\+\+\+)/gm) || []).length;
    const removed = (rawArgs.match(/^-(?!---)/gm) || []).length;
    const detailAddedKey = status === "accepted" ? "addedAccepted" : status === "rejected" ? "addedRejected" : "addedInferred";
    const detailRemovedKey = status === "accepted" ? "removedAccepted" : status === "rejected" ? "removedRejected" : "removedInferred";

    summary.operations += 1;
    summary[detailAddedKey] += added;
    summary[detailRemovedKey] += removed;
    for (const file of targets) {
      const detail = byFile.get(file) || { file, operations: 0, added: 0, removed: 0, statuses: [] };
      detail.operations += 1;
      detail.added += added;
      detail.removed += removed;
      detail.statuses.push({ status, operation: toolName, requestId: data.toolCallId || null, added, removed });
      byFile.set(file, detail);
    }
  }

  summary.available = summary.operations > 0;
  summary.files = byFile.size;
  summary.details = [...byFile.values()];
  return summary;
}

async function readProjectInfo(workspaceDir) {
  const text = await safeReadText(path.join(workspaceDir, "workspace.json"));
  if (!text) return { project: null, projectPath: null, projectSource: "unidentified" };
  try {
    const metadata = JSON.parse(text);
    const raw = metadata.folder || metadata.workspace;
    const projectPath = decodeFileUri(raw);
    if (!projectPath) return { project: null, projectPath: null, projectSource: "unidentified" };
    return {
      project: path.basename(projectPath.replace(/[\\/]$/, "")) || projectPath,
      projectPath,
      projectSource: metadata.folder ? "folder" : "workspace"
    };
  } catch {
    return { project: null, projectPath: null, projectSource: "unidentified" };
  }
}

async function readSessionFromDirectory(sessionDir, sessionId) {
  const mainPath = path.join(sessionDir, "main.jsonl");
  if (!(await exists(mainPath))) return null;

  const [mainText, modelsText] = await Promise.all([
    safeReadText(mainPath),
    safeReadText(path.join(sessionDir, "models.json"))
  ]);

  const rows = parseJsonl(mainText);
  if (!rows.length) return null;
  const priceMap = buildModelPriceMap(modelsText);

  let sessionTitle = null;
  const titleLogFile = findTitleLogFile(rows);
  if (titleLogFile) {
    const titleText = await safeReadText(path.join(sessionDir, titleLogFile));
    if (titleText) {
      const titleRows = parseJsonl(titleText);
      sessionTitle = extractTitleFromTitleRows(titleRows);
    }
  }

  let allRows = [...rows];
  const childLogFiles = findChildSessionLogFiles(rows);
  for (const childLogFile of childLogFiles) {
    const childPath = path.join(sessionDir, childLogFile);
    const childText = await safeReadText(childPath);
    if (childText) {
      const childRows = parseJsonl(childText);
      allRows = allRows.concat(childRows);
    }
  }

  const workspaceDir = path.resolve(sessionDir, "..", "..", "..");
  const chatSessionPath = path.join(workspaceDir, "chatSessions", `${sessionId}.jsonl`);
  const chatSessionText = await safeReadText(chatSessionPath);
  const projectInfo = await readProjectInfo(workspaceDir);
  const editingStateText = await safeReadText(path.join(workspaceDir, "chatEditingSessions", sessionId, "state.json"));
  const editing = summarizeEditingOperations(editingStateText, buildEditingSignalMap(chatSessionText));
  const titleFromChatSession = extractTitleFromChatSessionText(chatSessionText);

  const primary = analyzeSession(sessionId, allRows, priceMap, sessionTitle || titleFromChatSession);
  const enriched = { ...primary, ...projectInfo, editing };
  if (primary.modelTurns > 0) return enriched;

  if (!chatSessionText) return enriched;

  const fallbackTurns = extractChatSessionTurns(chatSessionText);
  if (!fallbackTurns.length) return enriched;

  return { ...buildSessionFromFallbackTurns(sessionId, primary, fallbackTurns, priceMap), ...projectInfo, editing };
}

async function buildSessionFingerprint(sessionDir) {
  const mainPath = path.join(sessionDir, "main.jsonl");
  const modelsPath = path.join(sessionDir, "models.json");

  const mainStat = await statSafe(mainPath);
  if (!mainStat) return null;

  const modelsStat = await statSafe(modelsPath);

  let titleCount = 0;
  let titleSize = 0;
  let titleMtime = 0;
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("title-") || !entry.name.endsWith(".jsonl")) continue;
      titleCount += 1;
      const titleStat = await statSafe(path.join(sessionDir, entry.name));
      if (!titleStat) continue;
      titleSize += Number(titleStat.size || 0);
      titleMtime = Math.max(titleMtime, Number(titleStat.mtimeMs || 0));
    }
  } catch {
    // ignore sidecar listing failures
  }

  const modelsMtime = modelsStat ? Number(modelsStat.mtimeMs || 0) : 0;
  const modelsSize = modelsStat ? Number(modelsStat.size || 0) : 0;
  const workspaceDir = path.resolve(sessionDir, "..", "..", "..");
  const chatSessionStat = await statSafe(path.join(workspaceDir, "chatSessions", `${path.basename(sessionDir)}.jsonl`));
  const workspaceStat = await statSafe(path.join(workspaceDir, "workspace.json"));
  const editingStat = await statSafe(path.join(workspaceDir, "chatEditingSessions", `${path.basename(sessionDir)}`, "state.json"));

  return [
    Number(mainStat.mtimeMs || 0),
    Number(mainStat.size || 0),
    modelsMtime,
    modelsSize,
    titleCount,
    titleMtime,
    titleSize,
    chatSessionStat ? Number(chatSessionStat.mtimeMs || 0) : 0,
    chatSessionStat ? Number(chatSessionStat.size || 0) : 0
    ,workspaceStat ? Number(workspaceStat.mtimeMs || 0) : 0
    ,editingStat ? Number(editingStat.mtimeMs || 0) : 0
    ,editingStat ? Number(editingStat.size || 0) : 0
  ].join("|");
}

function isoToTs(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function getLatestEvent(rows, type) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index] && rows[index].type === type) return rows[index];
  }
  return null;
}

function getLatestUsageEvent(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && (row.type === "session.usage_checkpoint" || row.type === "session.shutdown")) {
      return row;
    }
  }
  return null;
}

function getMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : String(part && (part.text || part.content) || ""))
    .join("")
    .trim();
}

function getTokenDetail(tokenDetails, key) {
  const detail = tokenDetails && tokenDetails[key];
  return Number(detail && (detail.tokenCount ?? detail.count) || 0);
}

function extractWorkspaceName(workspaceText) {
  if (!workspaceText) return null;
  const match = workspaceText.match(/^\s*name:\s*(.+?)\s*$/m);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "").trim() || null;
}

function extractWorkspaceField(workspaceText, field) {
  if (!workspaceText) return null;
  const match = workspaceText.match(new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "m"));
  return match ? match[1].replace(/^["']|["']$/g, "").trim() || null : null;
}

function projectInfoFromWorkspace(workspaceText) {
  const projectPath = extractWorkspaceField(workspaceText, "git_root") ||
    extractWorkspaceField(workspaceText, "cwd");
  if (!projectPath) return { project: null, projectPath: null, projectSource: "unidentified" };
  return {
    project: path.basename(projectPath.replace(/[\\/]$/, "")) || projectPath,
    projectPath,
    projectSource: extractWorkspaceField(workspaceText, "git_root") ? "git_root" : "cwd"
  };
}

function projectInfoFromRepository(repository, cwd) {
  const repositoryName = String(repository || "").trim().split("/").pop() || null;
  const currentPath = String(cwd || "").trim();
  const worktreeMatch = currentPath.match(/^(.+?)[\\/]copilot-worktrees[\\/][^\\/]+[\\/][^\\/]+(?:[\\/]|$)/i);
  const projectPath = worktreeMatch
    ? path.join(worktreeMatch[1], repositoryName || "")
    : null;
  return {
    project: repositoryName,
    projectPath: projectPath && repositoryName ? projectPath : null,
    projectSource: repositoryName ? "repository" : "unidentified"
  };
}

function readCopilotSessionInfo(sessionId) {
  const dbPath = path.join(os.homedir(), ".copilot", "session-store.db");
  try {
    let db = copilotDbHandles.get(dbPath);
    if (!db) {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      copilotDbHandles.set(dbPath, db);
    }
    return db.prepare("SELECT repository, cwd FROM sessions WHERE id = ?").get(sessionId) || null;
  } catch {
    return null;
  }
}

function readCopilotStoreUsage(sessionId) {
  const dbPath = path.join(os.homedir(), ".copilot", "session-store.db");
  try {
    let db = copilotDbHandles.get(dbPath);
    if (!db) {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      copilotDbHandles.set(dbPath, db);
    }

    const rows = db.prepare(`
      SELECT model,
             COUNT(*) AS turns,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(total_nano_aiu), 0) AS total_nano_aiu
      FROM assistant_usage_events
      WHERE session_id = ?
      GROUP BY model
    `).all(sessionId);
    if (!rows.length) return null;

    return rows.reduce((result, row) => {
      result.inputTokens += Number(row.input_tokens || 0);
      result.outputTokens += Number(row.output_tokens || 0);
      result.cachedTokens += Number(row.cache_read_tokens || 0);
      result.aic += Number(row.total_nano_aiu || 0) / 1000000000;
      result.modelAgg.push({
        model: String(row.model || "unknown"),
        turns: Number(row.turns || 0),
        aic: Number(row.total_nano_aiu || 0) / 1000000000
      });
      return result;
    }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, aic: 0, modelAgg: [] });
  } catch {
    return null;
  }
}

function buildStateModelAgg(modelMetrics) {
  const modelAgg = [];
  for (const [model, metrics] of Object.entries(modelMetrics || {})) {
    const usage = (metrics && metrics.usage) || {};
    const aic = Number(metrics && metrics.totalNanoAiu || 0) / 1000000000;
    const turns = Number(metrics && metrics.requests && metrics.requests.count || 0);
    if (!model || (!turns && !aic && !usage.inputTokens && !usage.outputTokens)) continue;
    modelAgg.push({ model, turns, aic });
  }
  return modelAgg.sort((a, b) => b.aic - a.aic);
}

async function readSessionFromStateDirectory(sessionDir, sessionId) {
  const eventsText = await safeReadText(path.join(sessionDir, "events.jsonl"));
  if (!eventsText) return null;

  const rows = parseJsonl(eventsText);
  if (!rows.length) return null;

  const startEvent = rows.find((row) => row && row.type === "session.start");
  const latestShutdown = getLatestEvent(rows, "session.shutdown");
  const shutdownData = (latestShutdown && latestShutdown.data) || {};
  const latestUsageEvent = getLatestUsageEvent(rows);
  const latestUsageData = (latestUsageEvent && latestUsageEvent.data) || {};
  const modelMetrics = shutdownData.modelMetrics || {};
  const shutdownTokenDetails = shutdownData.tokenDetails || {};
  const modelAgg = buildStateModelAgg(modelMetrics);
  const usage = Object.values(modelMetrics).reduce((total, metrics) => {
    const current = (metrics && metrics.usage) || {};
    return {
      inputTokens: total.inputTokens + Number(current.inputTokens || 0),
      outputTokens: total.outputTokens + Number(current.outputTokens || 0),
      cachedTokens: total.cachedTokens + Number(current.cacheReadTokens || 0)
    };
  }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  if (!usage.inputTokens && !usage.outputTokens) {
    usage.inputTokens =
      getTokenDetail(shutdownTokenDetails, "input") +
      getTokenDetail(shutdownTokenDetails, "cache_read") +
      getTokenDetail(shutdownTokenDetails, "cache_write");
    usage.outputTokens = getTokenDetail(shutdownTokenDetails, "output");
    usage.cachedTokens = getTokenDetail(shutdownTokenDetails, "cache_read");
  }

  const fallbackModel = String((startEvent && startEvent.data && startEvent.data.selectedModel) || "unknown");
  const assistantMessages = rows.filter((row) => row && row.type === "assistant.message");
  const fallbackOutput = assistantMessages.reduce((total, row) => total + Number(row.data && row.data.outputTokens || 0), 0);
  const modelTurns = modelAgg.reduce((total, model) => total + model.turns, 0) || assistantMessages.length;
  const fallbackInput = modelAgg.length ? 0 : 0;
  const fallbackModels = modelAgg.length ? modelAgg : (modelTurns ? [{ model: fallbackModel, turns: modelTurns, aic: 0 }] : []);
  const workspaceText = await safeReadText(path.join(sessionDir, "workspace.yaml"));
  const workspaceProjectInfo = projectInfoFromWorkspace(workspaceText);
  const storeInfo = readCopilotSessionInfo(sessionId);
  const workspacePath = workspaceProjectInfo.projectPath || "";
  const repositoryProjectInfo = projectInfoFromRepository(storeInfo && storeInfo.repository, storeInfo && storeInfo.cwd);
  const isWorktree = /[\\/]copilot-worktrees[\\/]/i.test(workspacePath);
  const projectInfo = isWorktree && repositoryProjectInfo.project
    ? repositoryProjectInfo
    : (workspaceProjectInfo.project
      ? workspaceProjectInfo
      : repositoryProjectInfo);
  const titleRow = rows.find((row) => row && row.type === "user.message");
  const title = extractWorkspaceName(workspaceText) ||
    getMessageText(titleRow && titleRow.data && titleRow.data.content).slice(0, 120) || null;
  const startTs = isoToTs(
    (startEvent && startEvent.data && startEvent.data.startTime) ||
    (startEvent && startEvent.timestamp) ||
    (rows[0] && rows[0].timestamp)
  );
  const endTs = isoToTs(rows[rows.length - 1] && rows[rows.length - 1].timestamp);
  const aic = Number(latestUsageData.totalNanoAiu || 0) / 1000000000;
  const storeUsage = readCopilotStoreUsage(sessionId);
  const resolvedUsage = storeUsage || usage;
  const editing = summarizeStateEditingOperations(rows);

  return {
    sessionId,
    title,
    startTs,
    endTs,
    modelTurns: storeUsage ? storeUsage.modelAgg.reduce((total, model) => total + model.turns, 0) : modelTurns,
    toolCalls: rows.filter((row) => row && row.type === "tool.execution_start").length,
    inputTokens: resolvedUsage.inputTokens || fallbackInput,
    outputTokens: resolvedUsage.outputTokens || fallbackOutput,
    cachedTokens: resolvedUsage.cachedTokens,
    totalTokens: (resolvedUsage.inputTokens || fallbackInput) + (resolvedUsage.outputTokens || fallbackOutput),
    errors: rows.filter((row) => row && row.type === "tool.execution_complete" && row.data && row.data.success === false).length,
    aic,
    missingPriceTurns: 0,
    autoDiscountTurns: 0,
    autoDiscountAmount: 0,
    modelAgg: storeUsage ? storeUsage.modelAgg : fallbackModels,
    ...projectInfo,
    editing
  };
}

async function buildStateFingerprint(sessionDir) {
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const stat = await statSafe(eventsPath);
  if (!stat) return null;
  return [
    Number(stat.mtimeMs || 0),
    Number(stat.size || 0)
  ].join("|");
}

async function refreshSessionsFromRoot(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  if (!(await exists(resolvedRoot))) {
    throw new Error(`Percorso non trovato: ${resolvedRoot}`);
  }

  const debugDirs = await findDebugLogsDirectories(resolvedRoot);
  const rootBaseName = path.basename(resolvedRoot).toLowerCase();
  const stateRoot = rootBaseName === "session-state"
    ? resolvedRoot
    : (rootBaseName === ".copilot"
      ? path.join(resolvedRoot, "session-state")
      : path.join(resolvedRoot, ".copilot", "session-state"));
  const hasStateRoot = await exists(stateRoot);
  if (!debugDirs.length && !hasStateRoot) {
    rootCaches.set(resolvedRoot, {
      sessionsById: new Map(),
      fingerprints: new Map(),
      lastSyncTs: Date.now()
    });
    return {
      root: resolvedRoot,
      inspectedFolders: 0,
      sessions: [],
      changed: [],
      removedSessionIds: [],
      unchangedCount: 0,
      fullRebuild: true,
      lastSyncTs: Date.now()
    };
  }

  const cache = rootCaches.get(resolvedRoot) || {
    sessionsById: new Map(),
    fingerprints: new Map(),
    lastSyncTs: 0
  };

  const discovered = new Map();
  let inspectedFolders = 0;

  for (const debugDir of debugDirs) {
    let entries = [];
    try {
      entries = await fs.readdir(debugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      inspectedFolders += 1;
      discovered.set(entry.name, { kind: "debug", dir: path.join(debugDir, entry.name) });
    }
  }

  if (hasStateRoot) {
    let entries = [];
    try {
      entries = await fs.readdir(stateRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        discovered.set(entry.name, { kind: "state", dir: path.join(stateRoot, entry.name) });
      }
    }
  }

  const changed = [];
  let unchangedCount = 0;

  for (const [sessionId, source] of discovered.entries()) {
    const sessionDir = source.dir;
    const fingerprint = source.kind === "state"
      ? await buildStateFingerprint(sessionDir)
      : await buildSessionFingerprint(sessionDir);
    if (!fingerprint) continue;

    const prevFingerprint = cache.fingerprints.get(sessionId);
    if (prevFingerprint === fingerprint && cache.sessionsById.has(sessionId)) {
      unchangedCount += 1;
      continue;
    }

    const analyzed = source.kind === "state"
      ? await readSessionFromStateDirectory(sessionDir, sessionId)
      : await readSessionFromDirectory(sessionDir, sessionId);
    if (!analyzed) {
      cache.sessionsById.delete(sessionId);
      cache.fingerprints.delete(sessionId);
      continue;
    }

    cache.sessionsById.set(sessionId, analyzed);
    cache.fingerprints.set(sessionId, fingerprint);
    changed.push(analyzed);
  }

  const removedSessionIds = [];
  for (const cachedSessionId of [...cache.sessionsById.keys()]) {
    if (discovered.has(cachedSessionId)) continue;
    cache.sessionsById.delete(cachedSessionId);
    cache.fingerprints.delete(cachedSessionId);
    removedSessionIds.push(cachedSessionId);
  }

  const sessions = [...cache.sessionsById.values()].sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  const fullRebuild = cache.lastSyncTs === 0;
  cache.lastSyncTs = Date.now();
  rootCaches.set(resolvedRoot, cache);

  return {
    root: resolvedRoot,
    inspectedFolders,
    sessions,
    changed,
    removedSessionIds,
    unchangedCount,
    fullRebuild,
    lastSyncTs: cache.lastSyncTs
  };
}

async function findDebugLogsDirectories(rootPath) {
  const resolved = path.resolve(rootPath);
  const found = [];
  const baseName = path.basename(resolved).toLowerCase();

  if (baseName === "debug-logs") return [resolved];

  if (baseName === "session-state") return [];

  if (baseName === ".copilot") return [];

  if (baseName === "github.copilot-chat") {
    const candidate = path.join(resolved, "debug-logs");
    if (await exists(candidate)) found.push(candidate);
    return found;
  }

  if (baseName === path.basename(os.homedir()).toLowerCase()) {
    const workspaceStorage = path.join(resolved, "AppData", "Roaming", "Code", "User", "workspaceStorage");
    if (await exists(workspaceStorage)) {
      const nested = await findDebugLogsDirectories(workspaceStorage);
      found.push(...nested);
    }
    return found;
  }

  if (baseName === "workspacestorage") {
    let entries = [];
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(resolved, entry.name, "GitHub.copilot-chat", "debug-logs");
      if (await exists(candidate)) found.push(candidate);
    }
    return found;
  }

  async function walk(current, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.toLowerCase() === "debug-logs") {
        found.push(full);
        continue;
      }
      await walk(full, depth + 1);
    }
  }

  await walk(resolved, 0);
  return found;
}

async function readSessionsFromRoot(rootPath) {
  const refreshed = await refreshSessionsFromRoot(rootPath);
  return {
    root: refreshed.root,
    inspectedFolders: refreshed.inspectedFolders,
    sessions: refreshed.sessions
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      return true;
    }

    if (process.platform === "darwin") {
      const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      return true;
    }

    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function pickDirectoryNative() {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Folder picker nativo disponibile solo su Windows in questa versione."));
      return;
    }

    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dlg.Description = 'Seleziona la cartella root dei logs'",
      "$dlg.ShowNewFolderButton = $false",
      "$result = $dlg.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }"
    ].join("; ");

    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      reject(new Error(error.message || "Errore apertura folder picker."));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || "Errore esecuzione folder picker.").trim()));
        return;
      }
      const selectedPath = stdout.trim();
      if (!selectedPath) {
        resolve(null);
        return;
      }
      resolve(selectedPath);
    });
  });
}

async function serveDashboard(res) {
  const html = await safeReadText(DASHBOARD_FILE);
  if (!html) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Dashboard file not found.");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (!hasLoggedFirstRequest) {
      hasLoggedFirstRequest = true;
      logInfo(`[INFO] First request received: ${req.method || "GET"} ${reqUrl.pathname}`);
    }

    if (reqUrl.pathname === "/") {
      await serveDashboard(res);
      return;
    }

    if (reqUrl.pathname === "/api/default-root") {
      sendJson(res, 200, { root: getDefaultRoot() });
      return;
    }

    if (reqUrl.pathname === "/api/pick-root") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      try {
        const selectedPath = await pickDirectoryNative();
        sendJson(res, 200, {
          canceled: !selectedPath,
          path: selectedPath || null
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore apertura folder picker." });
      }
      return;
    }

    if (reqUrl.pathname === "/api/sessions") {
      const root = reqUrl.searchParams.get("root") || getDefaultRoot();
      try {
        const payload = await readSessionsFromRoot(root);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore lettura sessioni." });
      }
      return;
    }

    if (reqUrl.pathname === "/api/sessions-delta") {
      const root = reqUrl.searchParams.get("root") || getDefaultRoot();
      try {
        const payload = await refreshSessionsFromRoot(root);
        sendJson(res, 200, {
          root: payload.root,
          inspectedFolders: payload.inspectedFolders,
          changed: payload.changed,
          removedSessionIds: payload.removedSessionIds,
          unchangedCount: payload.unchangedCount,
          totalSessions: payload.sessions.length,
          fullRebuild: payload.fullRebuild,
          lastSyncTs: payload.lastSyncTs
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore refresh sessioni." });
      }
      return;
    }

    if (reqUrl.pathname === "/api/export-excel") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
          const aicValueEuro = Number(payload.aicValueEuro || 0.01);
          const rows = sessions.map((s) => ({
            Titolo: s.title || "(non disponibile)",
            "ID Sessione": s.sessionId,
            Progetto: s.project || "Non identificato",
            "Percorso Progetto": s.projectPath || "",
            "Data Inizio": new Date(s.startTs || 0).toLocaleString("it-IT"),
            "Model Turns": s.modelTurns || 0,
            "Auto Turns": s.autoDiscountTurns || 0,
            "Tool Calls": s.toolCalls || 0,
            "Input Tokens": s.inputTokens || 0,
            Cached: s.cachedTokens || 0,
            Output: s.outputTokens || 0,
            Total: s.totalTokens || 0,
            Errors: s.errors || 0,
            AIC: Number((s.aic || 0).toFixed(4)),
            "Sconto Auto AIC": Number((s.autoDiscountAmount || 0).toFixed(4)),
            EUR: Number((s.aic * aicValueEuro).toFixed(4))
          }));
          const ws = xlsx.utils.json_to_sheet(rows);
          ws["!cols"] = [ { wch: 25 }, { wch: 40 }, { wch: 24 }, { wch: 45 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 12 } ];
          const wb = xlsx.utils.book_new();
          xlsx.utils.book_append_sheet(wb, ws, "Sessioni");
          const projects = new Map();
          for (const s of sessions) {
            const key = s.project || "Non identificato";
            const editing = s.editing || {};
            const current = projects.get(key) || {
              Progetto: key, Sessioni: 0, "Model Turns": 0, "Input Tokens": 0, "Output Tokens": 0,
              AIC: 0, "Costo (EUR)": 0, "File modificati": 0, "Righe aggiunte accettate": 0,
              "Righe rimosse accettate": 0, "Righe aggiunte rifiutate": 0, "Righe rimosse rifiutate": 0,
              "Righe aggiunte manuali": 0, "Righe rimosse manuali": 0, "Righe non classificate": 0
            };
            current.Sessioni += 1;
            current["Model Turns"] += s.modelTurns || 0;
            current["Input Tokens"] += s.inputTokens || 0;
            current["Output Tokens"] += s.outputTokens || 0;
            current.AIC += s.aic || 0;
            current["Costo (EUR)"] += (s.aic || 0) * aicValueEuro;
            current["File modificati"] += editing.files || 0;
            current["Righe aggiunte accettate"] += editing.addedAccepted || 0;
            current["Righe rimosse accettate"] += editing.removedAccepted || 0;
            current["Righe aggiunte rifiutate"] += editing.addedRejected || 0;
            current["Righe rimosse rifiutate"] += editing.removedRejected || 0;
            current["Righe aggiunte manuali"] += editing.addedManual || 0;
            current["Righe rimosse manuali"] += editing.removedManual || 0;
            current["Righe non classificate"] += (editing.addedInferred || 0) + (editing.removedInferred || 0);
            projects.set(key, current);
          }
          xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([...projects.values()]), "Progetti");
          const excelBuffer = xlsx.write(wb, { bookType: "xlsx", type: "buffer" });
          res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=copilot-sessions.xlsx", "Content-Length": excelBuffer.length });
          res.end(excelBuffer);
        } catch (error) {
          sendJson(res, 400, { error: error.message || "Errore generazione Excel" });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  const dashboardUrl = `http://${HOST}:${PORT}`;
  logTitle("============================================================");
  logTitle(" Copilot Cost Dashboard");
  logTitle("============================================================");
  logSuccess(`Copilot Cost Dashboard server running on ${dashboardUrl}`);
  logInfo(`Default root: ${getDefaultRoot()}`);
  logSuccess("Status: READY");
  logInfo("Press CTRL+C to stop the server.");

  const shouldAutoOpen = process.env.NO_AUTO_OPEN_BROWSER !== "1";
  if (shouldAutoOpen) {
    const opened = openBrowser(dashboardUrl);
    if (opened) {
      logSuccess(`[INFO] Browser opened automatically: ${dashboardUrl}`);
    }
    if (!opened) {
      logInfo(`Open browser manually: ${dashboardUrl}`);
    }
  }
});
