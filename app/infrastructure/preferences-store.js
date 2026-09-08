const os = require("os");
const path = require("path");
const fs = require("fs");

let Database = null;
let databaseHandle = null;

const DEFAULT_PREFERENCES = Object.freeze({
  rootPath: "",
  aicValueEuro: 0.01,
  autoRefreshEnabled: "on",
  refreshInterval: "30",
  fromDate: "",
  toDate: "",
  groupBy: "day",
  projectFilter: "*",
  activePreset: "day",
  sort: {
    projects: { key: "aic", direction: "desc", isDefault: true },
    sessions: { key: "startTs", direction: "desc", isDefault: true }
  },
  configPanelOpen: false,
  filtersPanelOpen: true
});

function getDatabase() {
  if (!Database) Database = require("better-sqlite3");
  return Database;
}

function getDatabasePath() {
  return process.env.COPILOT_COST_DASHBOARD_DB
    ? path.resolve(process.env.COPILOT_COST_DASHBOARD_DB)
    : path.join(os.homedir(), ".copilot", "cost-dashboard.db");
}

function getDatabaseHandle() {
  if (databaseHandle) return databaseHandle;
  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  databaseHandle = new (getDatabase())(dbPath);
  databaseHandle.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      preferences TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return databaseHandle;
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
}

function readPreferences() {
  const row = getDatabaseHandle().prepare(
    "SELECT preferences FROM dashboard_preferences WHERE id = 1"
  ).get();
  if (!row) return cloneDefaults();
  try {
    const stored = JSON.parse(row.preferences);
    return {
      ...cloneDefaults(),
      ...stored,
      sort: {
        ...cloneDefaults().sort,
        ...(stored.sort || {})
      }
    };
  } catch {
    return cloneDefaults();
  }
}

function savePreferences(preferences) {
  const payload = JSON.stringify(preferences);
  getDatabaseHandle().prepare(`
    INSERT INTO dashboard_preferences (id, preferences, updated_at)
    VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at
  `).run(payload);
  return preferences;
}

function closePreferencesDatabase() {
  if (databaseHandle && databaseHandle.open) databaseHandle.close();
  databaseHandle = null;
}

module.exports = {
  DEFAULT_PREFERENCES,
  getDatabasePath,
  readPreferences,
  savePreferences,
  closePreferencesDatabase
};
