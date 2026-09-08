const path = require("path");
const { spawn } = require("child_process");
const { safeReadText } = require("../infrastructure/fs-reader");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
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
    child.stdout.on("data", (chunk) => { stdout += String(chunk || ""); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", (error) => reject(new Error(error.message || "Errore apertura folder picker.")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || "Errore esecuzione folder picker.").trim()));
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}

function createControllers({ dashboardFile, apiClientFile, sessionCatalog, sessionRepository, syncService, xlsx, getDefaultRoot, preferencesStore, closeDatabases }) {
  function registerRoot(root) {
    if (!root || !syncService) return null;
    return syncService.registerRoot(root);
  }

  function statusFor(root) {
    return syncService ? syncService.getStatus(root) : null;
  }

  function validatePreferences(payload) {
    const preferences = payload && typeof payload === "object" ? payload : {};
    const allowed = preferencesStore.DEFAULT_PREFERENCES;
    const result = { ...allowed };
    const stringFields = ["rootPath", "autoRefreshEnabled", "refreshInterval", "fromDate", "toDate", "groupBy", "projectFilter", "activePreset"];
    for (const field of stringFields) {
      if (preferences[field] !== undefined && typeof preferences[field] === "string" && preferences[field].length <= 1024) {
        result[field] = preferences[field];
      }
    }
    if (preferences.aicValueEuro !== undefined && Number.isFinite(Number(preferences.aicValueEuro)) && Number(preferences.aicValueEuro) >= 0) {
      result.aicValueEuro = Number(preferences.aicValueEuro);
    }
    for (const field of ["configPanelOpen", "filtersPanelOpen"]) {
      if (preferences[field] !== undefined && typeof preferences[field] === "boolean") result[field] = preferences[field];
    }
    if (preferences.sort && typeof preferences.sort === "object") {
      for (const table of ["projects", "sessions"]) {
        const sort = preferences.sort[table];
        if (!sort || typeof sort !== "object") continue;
        const defaultSort = allowed.sort[table];
        if (typeof sort.key === "string" && sort.key.length <= 64 &&
            (sort.direction === "asc" || sort.direction === "desc") &&
            typeof sort.isDefault === "boolean") {
          result.sort = { ...result.sort, [table]: { key: sort.key, direction: sort.direction, isDefault: sort.isDefault } };
        } else {
          result.sort = { ...result.sort, [table]: defaultSort };
        }
      }
    }
    return result;
  }

  return {
    async dashboard(_req, res) {
      const html = await safeReadText(dashboardFile);
      if (!html) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Dashboard file not found.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    },

    async apiClient(_req, res) {
      const script = await safeReadText(apiClientFile);
      if (!script) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("API client file not found.");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(script);
    },

    health(_req, res, context) {
      sendJson(res, 200, { status: "ok", requestId: context.requestId });
    },

    defaultRoot(_req, res, context) {
      sendJson(res, 200, { root: getDefaultRoot(), requestId: context.requestId });
    },

    syncStatus(req, res, context) {
      const root = context.url.searchParams.get("root") || null;
      sendJson(res, 200, { ...statusFor(root), requestId: context.requestId });
    },

    syncInterval(_req, res, context, body) {
      try {
        const payload = body || {};
        const status = syncService.setIntervalSeconds(payload.intervalSeconds ?? payload.seconds);
        sendJson(res, 200, { ...status, requestId: context.requestId });
      } catch (error) {
        sendJson(res, 400, { error: error.message, requestId: context.requestId });
      }
    },

    async syncNow(_req, res, context, body) {
      const root = String(body && body.root || context.url.searchParams.get("root") || "").trim();
      try {
        if (root) registerRoot(root);
        const result = root
          ? await syncService.syncRoot(root)
          : await syncService.syncAll();
        sendJson(res, 200, { root: root || null, result, status: statusFor(root || null), requestId: context.requestId });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore sincronizzazione.", requestId: context.requestId });
      }
    },

    preferences(_req, res, context, body) {
      try {
        if (_req.method === "GET") {
          sendJson(res, 200, { preferences: preferencesStore.readPreferences(), requestId: context.requestId });
          return;
        }
        if (_req.method !== "PUT") {
          sendJson(res, 405, { error: "Method not allowed", requestId: context.requestId });
          return;
        }
        const preferences = preferencesStore.savePreferences(validatePreferences(body));
        sendJson(res, 200, { preferences, requestId: context.requestId });
      } catch (error) {
        sendJson(res, 500, { error: error.message || "Errore salvataggio preferenze.", requestId: context.requestId });
      }
    },

    async pickRoot(req, res, context) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed", requestId: context.requestId });
        return;
      }
      try {
        const selectedPath = await pickDirectoryNative();
        sendJson(res, 200, {
          canceled: !selectedPath,
          path: selectedPath || null,
          requestId: context.requestId
        });
        context.server.on("close", closeDatabases);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore apertura folder picker.", requestId: context.requestId });
      }
    },

    async sessions(_req, res, context) {
      const root = context.url.searchParams.get("root") || getDefaultRoot();
      try {
        const registeredRoot = registerRoot(root);
        const sessions = sessionRepository.getSessions(registeredRoot || root);
        const syncStatus = statusFor(registeredRoot || root);
        sendJson(res, 200, {
          root: registeredRoot || path.resolve(root),
          inspectedFolders: syncStatus && syncStatus.root ? syncStatus.root.inspectedFolders : 0,
          sessions,
          source: "sqlite",
          syncStatus,
          requestId: context.requestId
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore lettura sessioni.", requestId: context.requestId });
      }
    },

    async sessionsDelta(_req, res, context) {
      const root = context.url.searchParams.get("root") || getDefaultRoot();
      try {
        const registeredRoot = registerRoot(root);
        const payload = sessionRepository.getDelta(registeredRoot || root) || {
          root: registeredRoot || path.resolve(root),
          inspectedFolders: 0,
          changed: [],
          removedSessionIds: [],
          unchangedCount: 0,
          totalSessions: 0,
          fullRebuild: false,
          lastSyncTs: null
        };
        sendJson(res, 200, {
          root: payload.root,
          inspectedFolders: payload.inspectedFolders,
          changed: payload.changed,
          removedSessionIds: payload.removedSessionIds,
          unchangedCount: payload.unchangedCount,
          totalSessions: payload.totalSessions,
          fullRebuild: payload.fullRebuild,
          lastSyncTs: payload.lastSyncTs,
          source: "sqlite",
          syncStatus: statusFor(registeredRoot || root),
          requestId: context.requestId
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore refresh sessioni.", requestId: context.requestId });
      }
    },

    async exportExcel(_req, res, context, body) {
      try {
        const payload = body || {};
        const root = String(payload.root || "").trim();
        if (!root || !path.isAbsolute(root)) {
          throw new Error("A valid absolute root path is required.");
        }
        registerRoot(root);
        const sessions = sessionRepository.getSessions(root);
        const aicValueEuro = Number(payload.aicValueEuro || 0.01);
        const excelBuffer = require("../infrastructure/excel-exporter").createExcelBuffer(xlsx, sessions, aicValueEuro);
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=copilot-sessions.xlsx",
          "Content-Length": excelBuffer.length
        });
        res.end(excelBuffer);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore generazione Excel", requestId: context.requestId });
      }
    }
  };
}

module.exports = { createControllers, pickDirectoryNative, sendJson };
