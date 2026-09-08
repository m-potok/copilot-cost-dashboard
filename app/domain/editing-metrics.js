const path = require("path");
const { URL } = require("url");
const { parseJsonl } = require("./session-metrics");
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


module.exports = { decodeFileUri, buildEditingSignalMap, summarizeEditingOperations, summarizeStateEditingOperations };
