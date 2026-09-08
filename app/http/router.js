const crypto = require("crypto");
const { URL } = require("url");
const { sendJson } = require("./controllers");

const MAX_BODY_BYTES = 1024 * 1024;

function getRequestId(req) {
  const supplied = String(req.headers["x-request-id"] || "").trim();
  return /^[A-Za-z0-9._-]{1,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function normalizeApiPath(pathname) {
  return pathname.startsWith("/api/v1/") ? `/api${pathname.slice("/api/v1".length)}` : pathname;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function createRouter({ controllers, host, port, onFirstRequest }) {
  const routes = new Map([
    ["/api/health", "health"],
    ["/api/default-root", "defaultRoot"],
    ["/api/pick-root", "pickRoot"],
    ["/api/sessions", "sessions"],
    ["/api/sessions-delta", "sessionsDelta"],
    ["/api/export-excel", "exportExcel"],
    ["/api/sync-status", "syncStatus"],
    ["/api/sync-interval", "syncInterval"],
    ["/api/sync", "syncNow"]
  ]);

  return async function router(req, res, server) {
    const requestId = getRequestId(req);
    res.setHeader("X-Request-Id", requestId);
    const origin = String(req.headers.origin || "");
    if (origin && origin !== `http://${host}:${port}`) {
      sendJson(res, 403, { error: "Origin not allowed", requestId });
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const apiPath = normalizeApiPath(url.pathname);
      onFirstRequest(req, url);
      const context = { requestId, url, server };

      if (url.pathname === "/") return controllers.dashboard(req, res, context);
      if (url.pathname === "/api-client.js") return controllers.apiClient(req, res, context);

      const controllerName = routes.get(apiPath);
      if (!controllerName) {
        sendJson(res, 404, { error: "Not found", requestId });
        return;
      }
      if (["exportExcel", "syncInterval", "syncNow"].includes(controllerName)) {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed", requestId });
          return;
        }
        let body;
        try {
          body = JSON.parse(await readRequestBody(req));
        } catch (error) {
          sendJson(res, error.message === "Request body too large." ? 413 : 400, { error: error.message, requestId });
          return;
        }
        return controllers[controllerName](req, res, context, body);
      }
      return controllers[controllerName](req, res, context);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Server error", requestId });
    }
  };
}

module.exports = { createRouter, getRequestId, normalizeApiPath, readRequestBody };
