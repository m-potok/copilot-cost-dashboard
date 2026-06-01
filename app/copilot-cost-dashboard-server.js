const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");

const HOST = "127.0.0.1";
const PORT = 4781;
const BASE_DIR = __dirname;
const DASHBOARD_FILE = path.join(BASE_DIR, "copilot-cost-dashboard.html");
const rootCaches = new Map();

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
      if (!item || !item.id || !prices) continue;
      const normalized = {
        input_price: Number(prices.input_price || 0),
        output_price: Number(prices.output_price || 0),
        cache_price: Number(prices.cache_price || 0)
      };
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
        turnAic = ((uncached * prices.input_price) + (cached * prices.cache_price) + (output * prices.output_price)) / 1000000;
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

  return analyzeSession(sessionId, rows, priceMap, sessionTitle);
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

    if (reqUrl.pathname === "/") {
      await serveDashboard(res);
      return;
    }

    if (reqUrl.pathname === "/api/default-root") {
      sendJson(res, 200, { root: getDefaultRoot() });
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

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  const dashboardUrl = `http://${HOST}:${PORT}`;
  console.log(`Copilot Cost Dashboard server running on ${dashboardUrl}`);
  console.log(`Default root: ${getDefaultRoot()}`);

  const shouldAutoOpen = process.env.NO_AUTO_OPEN_BROWSER !== "1";
  if (shouldAutoOpen) {
    const opened = openBrowser(dashboardUrl);
    if (!opened) {
      console.log(`Open browser manually: ${dashboardUrl}`);
    }
  }
});
