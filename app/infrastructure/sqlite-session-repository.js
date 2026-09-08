const fs = require("fs");
const path = require("path");
const os = require("os");

let Database;

function getDatabase() {
  if (!Database) Database = require("better-sqlite3");
  return Database;
}

function defaultDatabasePath() {
  return process.env.COPILOT_COST_DB_PATH ||
    process.env.COPILOT_DASHBOARD_DB_PATH ||
    path.join(os.homedir(), ".copilot-cost-dashboard", "sessions.sqlite");
}

function asNullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

class SqliteSessionRepository {
  constructor(databasePath = defaultDatabasePath()) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    const DatabaseClass = getDatabase();
    this.db = new DatabaseClass(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.prepareStatements();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const hasMigration = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get();
    if (!hasMigration) this.db.exec(`
      CREATE TABLE session_roots (
        root_path TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'registered',
        error TEXT,
        registered_at INTEGER NOT NULL,
        last_sync_started_at INTEGER,
        last_sync_finished_at INTEGER,
        last_success_at INTEGER,
        last_sync_ts INTEGER,
        inspected_folders INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        removed_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        full_rebuild INTEGER NOT NULL DEFAULT 0,
        last_changed_json TEXT NOT NULL DEFAULT '[]',
        last_removed_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE sessions (
        root_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        start_ts INTEGER,
        end_ts INTEGER,
        project TEXT,
        project_path TEXT,
        project_source TEXT,
        model_turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        aic REAL NOT NULL DEFAULT 0,
        missing_price_turns INTEGER NOT NULL DEFAULT 0,
        auto_discount_turns INTEGER NOT NULL DEFAULT 0,
        auto_discount_amount REAL NOT NULL DEFAULT 0,
        session_json TEXT NOT NULL,
        fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at INTEGER,
        deleted_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (root_path, session_id),
        FOREIGN KEY (root_path) REFERENCES session_roots(root_path) ON DELETE CASCADE
      );
      CREATE INDEX sessions_root_start_idx ON sessions(root_path, start_ts);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, strftime('%s','now') * 1000);
    `);
    const hasSecondMigration = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
    if (!hasSecondMigration) {
      const columns = this.db.prepare("PRAGMA table_info(session_roots)").all();
      if (!columns.some((column) => column.name === "full_rebuild")) {
        this.db.exec("ALTER TABLE session_roots ADD COLUMN full_rebuild INTEGER NOT NULL DEFAULT 0");
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(Date.now());
    }
    const hasThirdMigration = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!hasThirdMigration) {
      const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
      if (!columns.some((column) => column.name === "status")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      }
      if (!columns.some((column) => column.name === "last_seen_at")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER");
      }
      if (!columns.some((column) => column.name === "deleted_at")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN deleted_at INTEGER");
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(Date.now());
    }
  }

  prepareStatements() {
    this.insertRoot = this.db.prepare(`
      INSERT INTO session_roots(root_path, registered_at)
      VALUES (?, ?)
      ON CONFLICT(root_path) DO NOTHING
    `);
    this.selectRoot = this.db.prepare("SELECT * FROM session_roots WHERE root_path = ?");
    this.selectRoots = this.db.prepare("SELECT * FROM session_roots ORDER BY registered_at ASC");
    this.selectSessions = this.db.prepare("SELECT session_json FROM sessions WHERE root_path = ? ORDER BY start_ts ASC, session_id ASC");
    this.upsertSession = this.db.prepare(`
      INSERT INTO sessions(
        root_path, session_id, title, start_ts, end_ts, project, project_path, project_source,
        model_turns, tool_calls, input_tokens, cached_tokens, output_tokens, total_tokens,
        errors, aic, missing_price_turns, auto_discount_turns, auto_discount_amount,
        session_json, fingerprint, status, last_seen_at, deleted_at, updated_at
      ) VALUES (
        @root_path, @session_id, @title, @start_ts, @end_ts, @project, @project_path, @project_source,
        @model_turns, @tool_calls, @input_tokens, @cached_tokens, @output_tokens, @total_tokens,
        @errors, @aic, @missing_price_turns, @auto_discount_turns, @auto_discount_amount,
        @session_json, @fingerprint, 'active', @updated_at, NULL, @updated_at
      )
      ON CONFLICT(root_path, session_id) DO UPDATE SET
        title=excluded.title, start_ts=excluded.start_ts, end_ts=excluded.end_ts,
        project=excluded.project, project_path=excluded.project_path, project_source=excluded.project_source,
        model_turns=excluded.model_turns, tool_calls=excluded.tool_calls, input_tokens=excluded.input_tokens,
        cached_tokens=excluded.cached_tokens, output_tokens=excluded.output_tokens, total_tokens=excluded.total_tokens,
        errors=excluded.errors, aic=excluded.aic, missing_price_turns=excluded.missing_price_turns,
        auto_discount_turns=excluded.auto_discount_turns, auto_discount_amount=excluded.auto_discount_amount,
        session_json=excluded.session_json, fingerprint=excluded.fingerprint,
        status='active', last_seen_at=excluded.last_seen_at, deleted_at=NULL, updated_at=excluded.updated_at
    `);
    this.markSessionDeleted = this.db.prepare(`
      UPDATE sessions
      SET status='deleted', deleted_at=?, updated_at=?
      WHERE root_path=? AND session_id=? AND status <> 'deleted'
    `);
    this.updateRootStarted = this.db.prepare(`
      UPDATE session_roots SET status='syncing', error=NULL, last_sync_started_at=? WHERE root_path=?
    `);
    this.updateRootFinished = this.db.prepare(`
      UPDATE session_roots SET status=?, error=?, last_sync_finished_at=?, last_success_at=?,
        last_sync_ts=?, inspected_folders=?, changed_count=?, removed_count=?, unchanged_count=?,
        full_rebuild=?, last_changed_json=?, last_removed_json=? WHERE root_path=?
    `);
    this.setRootError = this.db.prepare(`
      UPDATE session_roots SET status='error', error=?, last_sync_finished_at=? WHERE root_path=?
    `);
    this.replaceTransaction = this.db.transaction((root, result, now) => {
      this.updateRootStarted.run(now, root);
      for (const session of result.changed || []) {
        this.upsertSession.run(this.toRow(root, session, now));
      }
      const changed = result.changed || [];
      const removed = result.removedSessionIds || [];
      for (const sessionId of removed) {
        this.markSessionDeleted.run(now, now, root, sessionId);
      }
      this.updateRootFinished.run(
        "ready", null, now, now, asNullableNumber(result.lastSyncTs) || now,
        Number(result.inspectedFolders || 0), changed.length, removed.length,
        Number(result.unchangedCount || 0), result.fullRebuild ? 1 : 0,
        JSON.stringify(changed), JSON.stringify(removed), root
      );
    });
  }

  toRow(root, session, now) {
    return {
      root_path: root,
      session_id: String(session.sessionId),
      title: session.title == null ? null : String(session.title),
      start_ts: asNullableNumber(session.startTs),
      end_ts: asNullableNumber(session.endTs),
      project: session.project == null ? null : String(session.project),
      project_path: session.projectPath == null ? null : String(session.projectPath),
      project_source: session.projectSource == null ? null : String(session.projectSource),
      model_turns: Number(session.modelTurns || 0),
      tool_calls: Number(session.toolCalls || 0),
      input_tokens: Number(session.inputTokens || 0),
      cached_tokens: Number(session.cachedTokens || 0),
      output_tokens: Number(session.outputTokens || 0),
      total_tokens: Number(session.totalTokens || 0),
      errors: Number(session.errors || 0),
      aic: Number(session.aic || 0),
      missing_price_turns: Number(session.missingPriceTurns || 0),
      auto_discount_turns: Number(session.autoDiscountTurns || 0),
      auto_discount_amount: Number(session.autoDiscountAmount || 0),
      session_json: JSON.stringify(session),
      fingerprint: session.fingerprint == null ? null : String(session.fingerprint),
      updated_at: now
    };
  }

  registerRoot(rootPath, now = Date.now()) {
    const root = path.resolve(String(rootPath));
    this.insertRoot.run(root, now);
    return root;
  }

  markSyncStarted(rootPath, now = Date.now()) {
    const root = this.registerRoot(rootPath, now);
    this.updateRootStarted.run(now, root);
  }

  saveSyncResult(rootPath, result, now = Date.now()) {
    const root = this.registerRoot(rootPath, now);
    this.replaceTransaction(root, result, now);
    return this.getRoot(root);
  }

  saveSyncError(rootPath, error, now = Date.now()) {
    const root = this.registerRoot(rootPath, now);
    this.setRootError.run(String(error && error.message || error || "Unknown sync error"), now, root);
    return this.getRoot(root);
  }

  getRoot(rootPath) {
    return this.selectRoot.get(path.resolve(String(rootPath))) || null;
  }

  getRoots() {
    return this.selectRoots.all();
  }

  getSessions(rootPath) {
    const root = path.resolve(String(rootPath));
    return this.selectSessions.all(root).map((row) => {
      try { return JSON.parse(row.session_json); } catch { return null; }
    }).filter(Boolean);
  }

  getSessionRecord(rootPath, sessionId) {
    return this.db.prepare(`
      SELECT root_path, session_id, status, last_seen_at, deleted_at, updated_at
      FROM sessions
      WHERE root_path = ? AND session_id = ?
    `).get(path.resolve(String(rootPath)), String(sessionId)) || null;
  }

  getDelta(rootPath) {
    const root = this.getRoot(rootPath);
    if (!root) return null;
    let changed = [];
    try { changed = JSON.parse(root.last_changed_json || "[]"); } catch { /* migration-safe */ }
    return {
      root: root.root_path,
      inspectedFolders: root.inspected_folders,
      changed,
      removedSessionIds: [],
      unchangedCount: root.unchanged_count,
      totalSessions: this.getSessions(root.root_path).length,
      fullRebuild: root.full_rebuild === 1,
      lastSyncTs: root.last_sync_ts
    };
  }

  close() {
    if (this.db && this.db.open) this.db.close();
  }
}

module.exports = { SqliteSessionRepository, defaultDatabasePath };
