const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const xlsx = require("xlsx");
const { createControllers } = require("./http/controllers");
const { createRouter } = require("./http/router");
const { sessionCatalog, setSessionReadObserver } = require("./infrastructure/session-discovery");
const { closeCopilotDatabases } = require("./adapters/copilot-app/store");
const { SqliteSessionRepository } = require("./infrastructure/sqlite-session-repository");
const { SessionSyncService } = require("./application/session-sync-service");

const HOST = "127.0.0.1";
const PORT = 4781;
const BASE_DIR = __dirname;
const DASHBOARD_FILE = path.join(BASE_DIR, "copilot-cost-dashboard.html");
const API_CLIENT_FILE = path.join(BASE_DIR, "frontend", "api-client.js");
let hasLoggedFirstRequest = false;

function color(text, code) {
  if (!process.stdout || !process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
function logInfo(text) { console.log(color(text, "96")); }
function logSuccess(text) { console.log(color(text, "92")); }
function logTitle(text) { console.log(color(text, "97;1")); }
function getDefaultRoot() { return os.homedir(); }

const sessionRepository = new SqliteSessionRepository();
const syncService = new SessionSyncService({ repository: sessionRepository });
syncService.registerRoot(getDefaultRoot());
setSessionReadObserver((result) => sessionRepository.saveSyncResult(result.root, result));

function openBrowser(url) {
  try {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function createServer({ repository = sessionRepository, sync = syncService } = {}) {
  const controllers = createControllers({
    dashboardFile: DASHBOARD_FILE,
    apiClientFile: API_CLIENT_FILE,
    sessionCatalog,
    sessionRepository: repository,
    syncService: sync,
    xlsx,
    getDefaultRoot,
    closeDatabases
  });
  const router = createRouter({
    controllers,
    host: HOST,
    port: PORT,
    onFirstRequest(req, url) {
      if (hasLoggedFirstRequest) return;
      hasLoggedFirstRequest = true;
      logInfo(`[INFO] First request received: ${req.method || "GET"} ${url.pathname}`);
    }
  });
  return http.createServer((req, res) => router(req, res, server));
}

const server = createServer();
server.on("close", closeDatabases);
syncService.start();

function startServer() {
  syncService.start();
  server.listen(PORT, HOST, () => {
    const dashboardUrl = `http://${HOST}:${PORT}`;
    logTitle("============================================================");
    logTitle(" Copilot Cost Dashboard");
    logTitle("============================================================");
    logSuccess(`Copilot Cost Dashboard server running on ${dashboardUrl}`);
    logInfo(`Default root: ${getDefaultRoot()}`);
    logSuccess("Status: READY");
    logInfo("Press CTRL+C to stop the server.");
    if (process.env.NO_AUTO_OPEN_BROWSER !== "1") {
      const opened = openBrowser(dashboardUrl);
      logInfo(opened
        ? `[INFO] Browser opened automatically: ${dashboardUrl}`
        : `Open browser manually: ${dashboardUrl}`);
    }
  });
}

function closeDatabases() {
  syncService.close();
  closeCopilotDatabases();
}

module.exports = {
  HOST,
  PORT,
  server,
  sessionCatalog,
  sessionRepository,
  syncService,
  closeCopilotDatabases: closeDatabases,
  startServer,
  createServer
};
