const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  server,
  parseJsonl,
  buildModelPriceMap,
  extractChatSessionTurns,
  buildSessionFromFallbackTurns,
  analyzeSession,
  readSessionsFromRoot
} = require("../app/copilot-cost-dashboard-server");
const { createControllers } = require("../app/http/controllers");

const fixtureRoot = path.join(__dirname, "fixtures");

test("parses valid JSONL rows and ignores malformed lines", () => {
  assert.deepEqual(parseJsonl('{"ok":1}\nnot-json\n{"ok":2}\n'), [{ ok: 1 }, { ok: 2 }]);
});

test("calculates token pricing, cache pricing, errors, and auto discount", () => {
  const prices = buildModelPriceMap(JSON.stringify([
    { id: "gpt-test", billing: { token_prices: { default: { input_price: 2, output_price: 4, cache_price: 1 } } } }
  ]));
  const result = analyzeSession("session", [
    { type: "session_start", ts: 1000 },
    { type: "llm_request", ts: 2000, attrs: { model: "gpt-test", inputTokens: 100, cachedTokens: 20, outputTokens: 40 } },
    { type: "llm_request", ts: 3000, name: "chat:auto", attrs: { model: "gpt-test", inputTokens: 10, outputTokens: 10 } },
    { type: "tool_call", ts: 4000, status: "error" }
  ], prices, "Fixture session");

  assert.equal(result.startTs, 1000);
  assert.equal(result.modelTurns, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.inputTokens, 110);
  assert.equal(result.cachedTokens, 20);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.aic, 0.00039400000000000004);
  assert.equal(result.autoDiscountTurns, 1);
});

test("preserves fallback transcript turns when primary events have no usage", () => {
  const turns = extractChatSessionTurns('{"kind":0,"v":{"requests":[{"promptTokens":8,"completionTokens":3,"modelId":"gpt-fallback"}]}}');
  const result = buildSessionFromFallbackTurns("fallback", { title: "Fallback" }, turns, new Map());
  assert.deepEqual(turns, [{ modelId: "gpt-fallback", input: 8, output: 3 }]);
  assert.equal(result.modelTurns, 1);
  assert.equal(result.inputTokens, 8);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.missingPriceTurns, 1);
  assert.equal(result.aic, 0);
});

test("loads anonymized VS Code and Copilot App fixtures", async () => {
  const result = await readSessionsFromRoot(fixtureRoot);
  assert.equal(result.sessions.length, 2);

  const debug = result.sessions.find((session) => session.sessionId === "debug-session");
  assert.equal(debug.project, "project-a");
  assert.equal(debug.modelTurns, 1);
  assert.equal(debug.inputTokens, 100);
  assert.equal(debug.outputTokens, 40);
  assert.equal(debug.errors, 1);
  assert.equal(debug.editing.files, 1);
  assert.equal(debug.editing.addedAccepted, 1);

  const state = result.sessions.find((session) => session.sessionId === "state-session");
  assert.equal(state.project, "project-b");
  assert.equal(state.modelTurns, 2);
  assert.equal(state.inputTokens, 80);
  assert.equal(state.outputTokens, 12);
  assert.equal(state.aic, 0.25);
});

function request(port, requestPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const requestOptions = { host: "127.0.0.1", port, path: requestPath, method };
    if (body !== null) requestOptions.headers = { "Content-Type": "application/json" };
    const request = http.request(requestOptions, (response) => {
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk.toString("utf8"); });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: responseBody }));
    });
    request.on("error", reject);
    request.end(body === null ? undefined : JSON.stringify(body));
  });
}

function requestJson(port, requestPath, method = "GET") {
  return request(port, requestPath, method).then((response) => ({
    ...response,
    body: JSON.parse(response.body)
  }));
}

test("serves API smoke endpoints", async (t) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;

  const root = await requestJson(port, `/api/sessions?root=${encodeURIComponent(fixtureRoot)}`);
  assert.equal(root.statusCode, 200);
  assert.equal(root.body.sessions.length, 2);

  const delta = await requestJson(port, `/api/sessions-delta?root=${encodeURIComponent(fixtureRoot)}`);
  assert.equal(delta.statusCode, 200);
  assert.equal(delta.body.totalSessions, 2);
  assert.equal(typeof delta.body.unchangedCount, "number");

  const defaultRoot = await requestJson(port, "/api/default-root");
  assert.equal(defaultRoot.statusCode, 200);
  assert.equal(typeof defaultRoot.body.root, "string");
  assert.equal(defaultRoot.body.requestId.length > 0, true);
  const health = await requestJson(port, "/api/v1/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.status, "ok");

  const apiClient = await request(port, "/api-client.js");
  assert.equal(apiClient.statusCode, 200);
  assert.match(apiClient.body, /dashboardApi/);

  const exported = await request(port, "/api/export-excel", "POST", {
    root: fixtureRoot,
    aicValueEuro: 0.01
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.body.slice(0, 2), "PK");
});

test("returns cached sessions while the first root sync runs in background", async () => {
  let synced = false;
  let syncStarted = false;
  let releaseSync;
  const syncPromise = new Promise((resolve) => {
    releaseSync = () => {
      synced = true;
      resolve();
    };
  });
  const root = path.resolve("fixture-root");
  const controllers = createControllers({
    dashboardFile: "",
    apiClientFile: "",
    sessionCatalog: null,
    sessionRepository: {
      registerRoot: () => root,
      getSessions: () => [{ sessionId: "cached" }],
      getRoots: () => []
    },
    syncService: {
      registerRoot: () => root,
      getStatus: () => ({ root: { status: synced ? "ready" : "registered", inspectedFolders: 1 } }),
      syncRoot: () => {
        syncStarted = true;
        return syncPromise;
      }
    },
    xlsx: null,
    getDefaultRoot: () => root,
    preferencesStore: { DEFAULT_PREFERENCES: {}, readPreferences: () => ({}), savePreferences: (value) => value },
    closeDatabases: () => {}
  });
  let responseBody = "";
  const response = {
    writeHead() {},
    end(body) { responseBody = body; }
  };

  await controllers.sessions({}, response, {
    url: new URL(`http://127.0.0.1/api/sessions?root=${encodeURIComponent(root)}`),
    requestId: "test-request"
  });

  assert.deepEqual(JSON.parse(responseBody).sessions, [{ sessionId: "cached" }]);
  assert.equal(syncStarted, true);
  releaseSync();
  await syncPromise;
});
