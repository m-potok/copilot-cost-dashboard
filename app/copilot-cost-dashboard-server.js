const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");
const xlsx = require("xlsx");

const HOST = "127.0.0.1";
const PORT = 4781;
const AUTO_AIC_DISCOUNT_FACTOR = 0.9;
const BASE_DIR = __dirname;
const DASHBOARD_FILE = path.join(BASE_DIR, "copilot-cost-dashboard.html");
const rootCaches = new Map();
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
  return path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage");
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

  for (const rawLine of chatSessionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (!row || row.kind !== 0 || !row.v) continue;

    const customTitle = String(row.v.customTitle || "").trim();
    if (customTitle) return customTitle;

    const requests = Array.isArray(row.v.requests) ? row.v.requests : [];
    for (const req of requests) {
      const messageText = String(req && req.message && req.message.text || "").trim();
      if (messageText) return messageText.slice(0, 120);
    }
  }

  return null;
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

function analyzeSession(sessionId, rows, priceMap, title = null) {
  let minTs = Number.POSITIVE_INFINITY;
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
      if (ts < minTs) minTs = ts;
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
    startTs: Number.isFinite(minTs) ? minTs : null,
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
  const titleFromChatSession = extractTitleFromChatSessionText(chatSessionText);

  const primary = analyzeSession(sessionId, allRows, priceMap, sessionTitle || titleFromChatSession);
  if (primary.modelTurns > 0) return primary;

  if (!chatSessionText) return primary;

  const fallbackTurns = extractChatSessionTurns(chatSessionText);
  if (!fallbackTurns.length) return primary;

  return buildSessionFromFallbackTurns(sessionId, primary, fallbackTurns, priceMap);
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

  return [
    Number(mainStat.mtimeMs || 0),
    Number(mainStat.size || 0),
    modelsMtime,
    modelsSize,
    titleCount,
    titleMtime,
    titleSize
  ].join("|");
}

async function refreshSessionsFromRoot(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  if (!(await exists(resolvedRoot))) {
    throw new Error(`Percorso non trovato: ${resolvedRoot}`);
  }

  const debugDirs = await findDebugLogsDirectories(resolvedRoot);
  if (!debugDirs.length) {
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
      discovered.set(entry.name, path.join(debugDir, entry.name));
    }
  }

  const changed = [];
  let unchangedCount = 0;

  for (const [sessionId, sessionDir] of discovered.entries()) {
    const fingerprint = await buildSessionFingerprint(sessionDir);
    if (!fingerprint) continue;

    const prevFingerprint = cache.fingerprints.get(sessionId);
    if (prevFingerprint === fingerprint && cache.sessionsById.has(sessionId)) {
      unchangedCount += 1;
      continue;
    }

    const analyzed = await readSessionFromDirectory(sessionDir, sessionId);
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

  if (baseName === "github.copilot-chat") {
    const candidate = path.join(resolved, "debug-logs");
    if (await exists(candidate)) found.push(candidate);
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
          ws["!cols"] = [ { wch: 25 }, { wch: 40 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 12 } ];
          const wb = xlsx.utils.book_new();
          xlsx.utils.book_append_sheet(wb, ws, "Sessioni");
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
