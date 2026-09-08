const path = require("path");
const os = require("os");
let Database = null;
const copilotDbHandles = new Map();
function getDatabase() { if (!Database) Database = require("better-sqlite3"); return Database; }
function readCopilotSessionInfo(sessionId) {
  const dbPath = path.join(os.homedir(), ".copilot", "session-store.db");
  try {
    let db = copilotDbHandles.get(dbPath);
    if (!db) {
      db = new (getDatabase())(dbPath, { readonly: true, fileMustExist: true });
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
      db = new (getDatabase())(dbPath, { readonly: true, fileMustExist: true });
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


function closeCopilotDatabases() { for (const db of copilotDbHandles.values()) { if (db && db.open) db.close(); } copilotDbHandles.clear(); }
module.exports = { readCopilotSessionInfo, readCopilotStoreUsage, closeCopilotDatabases };
