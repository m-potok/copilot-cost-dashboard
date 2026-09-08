const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { exists } = require("./fs-reader");
const { SessionCatalog } = require("../application/session-catalog");
const { SessionSource } = require("../domain/session-source");
const { readSessionFromDirectory, buildSessionFingerprint } = require("../adapters/vscode-source");
const { readSessionFromStateDirectory, buildStateFingerprint } = require("../adapters/copilot-app/source");
const sessionSources = new Map([["debug", new SessionSource("debug", readSessionFromDirectory, buildSessionFingerprint)],["state", new SessionSource("state", readSessionFromStateDirectory, buildStateFingerprint)]]);
async function refreshSessionsFromRoot(rootPath, cacheStore = new Map()) {
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
    cacheStore.set(resolvedRoot, {
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

  const cache = cacheStore.get(resolvedRoot) || {
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
    const adapter = sessionSources.get(source.kind);
    if (!adapter) continue;
    const fingerprint = await adapter.fingerprint(sessionDir);
    if (!fingerprint) continue;

    const prevFingerprint = cache.fingerprints.get(sessionId);
    if (prevFingerprint === fingerprint && cache.sessionsById.has(sessionId)) {
      unchangedCount += 1;
      continue;
    }

    const analyzed = await adapter.read(sessionDir, sessionId);
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
  cacheStore.set(resolvedRoot, cache);

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
  const refreshed = await sessionCatalog.read(rootPath);
  return {
    root: refreshed.root,
    inspectedFolders: refreshed.inspectedFolders,
    sessions: refreshed.sessions
  };
}

const sessionCatalog = new SessionCatalog((rootPath, cacheStore) => refreshSessionsFromRoot(rootPath, cacheStore));
module.exports = { sessionCatalog, refreshSessionsFromRoot, findDebugLogsDirectories, readSessionsFromRoot };
