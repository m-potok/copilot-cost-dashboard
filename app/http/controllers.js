const path = require("path");
const { spawn } = require("child_process");
const { exists, safeReadText } = require("../infrastructure/fs-reader");

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

function createControllers({ dashboardFile, apiClientFile, sessionCatalog, xlsx, getDefaultRoot, closeDatabases }) {
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
        const payload = await sessionCatalog.read(root);
        sendJson(res, 200, { root: payload.root, inspectedFolders: payload.inspectedFolders, sessions: payload.sessions, requestId: context.requestId });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "Errore lettura sessioni.", requestId: context.requestId });
      }
    },

    async sessionsDelta(_req, res, context) {
      const root = context.url.searchParams.get("root") || getDefaultRoot();
      try {
        const payload = await sessionCatalog.read(root);
        sendJson(res, 200, {
          root: payload.root,
          inspectedFolders: payload.inspectedFolders,
          changed: payload.changed,
          removedSessionIds: payload.removedSessionIds,
          unchangedCount: payload.unchangedCount,
          totalSessions: payload.sessions.length,
          fullRebuild: payload.fullRebuild,
          lastSyncTs: payload.lastSyncTs,
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
        if (!root || !path.isAbsolute(root) || !(await exists(root))) {
          throw new Error("A valid absolute root path is required.");
        }
        const sessions = (await sessionCatalog.read(root)).sessions;
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
