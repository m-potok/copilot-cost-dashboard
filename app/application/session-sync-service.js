const path = require("path");
const { refreshSessionsFromRoot } = require("../infrastructure/session-discovery");

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 86400;

function parseIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`Sync interval must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`);
  }
  return seconds;
}

function initialIntervalSeconds(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_INTERVAL_SECONDS;
  try { return parseIntervalSeconds(value); } catch { return DEFAULT_INTERVAL_SECONDS; }
}

class SessionSyncService {
  constructor({ repository, discover = refreshSessionsFromRoot, clock = () => Date.now(), scheduler = globalThis } = {}) {
    if (!repository) throw new Error("A SQLite session repository is required.");
    this.repository = repository;
    this.discover = discover;
    this.clock = clock;
    this.scheduler = scheduler;
    this.cacheStore = new Map();
    this.runningRoots = new Set();
    this.inFlightRoots = new Map();
    this.pendingRoots = new Set();
    this.intervalSeconds = initialIntervalSeconds(process.env.COPILOT_COST_SYNC_INTERVAL_SECONDS);
    this.timer = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduleTimer();
    for (const root of this.repository.getRoots()) this.syncRoot(root.root_path).catch(() => {});
  }

  scheduleTimer() {
    if (this.timer) this.scheduler.clearInterval(this.timer);
    if (!this.started) return;
    this.timer = this.scheduler.setInterval(() => {
      this.syncAll().catch(() => {});
    }, this.intervalSeconds * 1000);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  registerRoot(rootPath) {
    const root = this.repository.registerRoot(path.resolve(String(rootPath)), this.clock());
    return root;
  }

  enqueueRoot(rootPath) {
    const root = this.registerRoot(rootPath);
    if (this.pendingRoots.has(root) || this.runningRoots.has(root)) return root;
    this.pendingRoots.add(root);
    const enqueue = () => {
      this.pendingRoots.delete(root);
      this.syncRoot(root).catch(() => {});
    };
    if (typeof this.scheduler.setImmediate === "function") this.scheduler.setImmediate(enqueue);
    else this.scheduler.setTimeout(enqueue, 0);
    return root;
  }

  async syncRoot(rootPath) {
    const root = this.registerRoot(rootPath);
    const inFlight = this.inFlightRoots.get(root);
    if (inFlight) return inFlight;

    const syncPromise = this.performSync(root);
    this.inFlightRoots.set(root, syncPromise);
    try {
      return await syncPromise;
    } finally {
      this.inFlightRoots.delete(root);
    }
  }

  async performSync(root) {
    this.runningRoots.add(root);
    const startedAt = this.clock();
    this.repository.markSyncStarted(root, startedAt);
    try {
      const result = await this.discover(root, this.cacheStore);
      this.repository.saveSyncResult(root, result, this.clock());
      return result;
    } catch (error) {
      this.repository.saveSyncError(root, error, this.clock());
      throw error;
    } finally {
      this.runningRoots.delete(root);
    }
  }

  async syncAll() {
    const roots = this.repository.getRoots().map((row) => row.root_path);
    return Promise.allSettled(roots.map((root) => this.syncRoot(root)));
  }

  setIntervalSeconds(value) {
    const seconds = parseIntervalSeconds(value);
    this.intervalSeconds = seconds;
    this.scheduleTimer();
    return this.getStatus();
  }

  getStatus(rootPath = null) {
    const roots = this.repository.getRoots()
      .filter((root) => !rootPath || root.root_path === path.resolve(String(rootPath)))
      .map((root) => ({
        root: root.root_path,
        status: this.runningRoots.has(root.root_path) ? "syncing" : root.status,
        error: root.error,
        registeredAt: root.registered_at,
        lastSyncStartedAt: root.last_sync_started_at,
        lastSyncFinishedAt: root.last_sync_finished_at,
        lastSuccessAt: root.last_success_at,
        lastSyncTs: root.last_sync_ts,
        inspectedFolders: root.inspected_folders,
        changedCount: root.changed_count,
        removedCount: root.removed_count,
        unchangedCount: root.unchanged_count
      }));
    const selected = rootPath ? roots[0] || null : null;
    return {
      intervalSeconds: this.intervalSeconds,
      running: this.runningRoots.size > 0,
      started: this.started,
      root: selected,
      roots
    };
  }

  close() {
    this.stop();
    this.repository.close();
  }
}

module.exports = {
  SessionSyncService,
  parseIntervalSeconds,
  initialIntervalSeconds,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS
};
