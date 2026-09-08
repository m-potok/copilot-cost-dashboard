const path = require("path");
const { safeReadText, statSafe } = require("../../infrastructure/fs-reader");
const { readCopilotSessionInfo, readCopilotStoreUsage } = require("./store");
const { parseJsonl } = require("../../domain/session-metrics");
const { summarizeStateEditingOperations } = require("../../domain/editing-metrics");
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

module.exports = { readSessionFromStateDirectory, buildStateFingerprint };
