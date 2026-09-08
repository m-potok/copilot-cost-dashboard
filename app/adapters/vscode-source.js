const fs = require("fs/promises");
const path = require("path");
const { exists, safeReadText, statSafe } = require("../infrastructure/fs-reader");
const { buildModelPriceMap } = require("../domain/pricing");
const { parseJsonl, extractChatSessionTurns, buildSessionFromFallbackTurns, analyzeSession } = require("../domain/session-metrics");
const { decodeFileUri, buildEditingSignalMap, summarizeEditingOperations } = require("../domain/editing-metrics");

function isSafeChildPath(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(parent, child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
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
  if (titleLogFile && isSafeChildPath(sessionDir, titleLogFile)) {
    const titleText = await safeReadText(path.join(sessionDir, titleLogFile));
    if (titleText) {
      const titleRows = parseJsonl(titleText);
      sessionTitle = extractTitleFromTitleRows(titleRows);
    }
  }

  let allRows = [...rows];
  const childLogFiles = findChildSessionLogFiles(rows);
  for (const childLogFile of childLogFiles) {
    if (!isSafeChildPath(sessionDir, childLogFile)) continue;
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


module.exports = { readSessionFromDirectory, buildSessionFingerprint };
