const assert = require("node:assert/strict");
const test = require("node:test");
const { SqliteSessionRepository } = require("../app/infrastructure/sqlite-session-repository");
const { SessionSyncService, parseIntervalSeconds } = require("../app/application/session-sync-service");

function session(sessionId, inputTokens = 10) {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    startTs: 1000,
    endTs: 2000,
    modelTurns: 1,
    toolCalls: 0,
    inputTokens,
    cachedTokens: 0,
    outputTokens: 5,
    totalTokens: inputTokens + 5,
    errors: 0,
    aic: 0.1,
    modelAgg: [{ model: "fixture", turns: 1, aic: 0.1 }],
    editing: { files: 0, details: [] }
  };
}

function discoverySequence(results) {
  let index = 0;
  return async (root) => ({ root, ...(results[Math.min(index++, results.length - 1)]) });
}

test("SQLite repository persists complete session payloads and sync metadata", () => {
  const repository = new SqliteSessionRepository(":memory:");
  const root = repository.registerRoot("fixture-root");
  repository.saveSyncResult(root, {
    root,
    inspectedFolders: 2,
    sessions: [session("one")],
    changed: [session("one")],
    removedSessionIds: [],
    unchangedCount: 0,
    fullRebuild: true,
    lastSyncTs: 123
  }, 123);

  assert.deepEqual(repository.getSessions(root), [session("one")]);
  assert.equal(repository.getDelta(root).fullRebuild, true);
  assert.equal(repository.getRoot(root).last_success_at, 123);
  repository.close();
});

test("sync service handles incremental changes, removals, and interval validation", async () => {
  const repository = new SqliteSessionRepository(":memory:");
  const root = repository.registerRoot("fixture-root");
  const service = new SessionSyncService({
    repository,
    discover: discoverySequence([
      { inspectedFolders: 1, sessions: [session("one"), session("two")], changed: [session("one"), session("two")], removedSessionIds: [], unchangedCount: 0, fullRebuild: true, lastSyncTs: 1 },
      { inspectedFolders: 1, sessions: [session("one", 20)], changed: [session("one", 20)], removedSessionIds: ["two"], unchangedCount: 0, fullRebuild: false, lastSyncTs: 2 }
    ])
  });

  await service.syncRoot(root);
  assert.equal(repository.getSessions(root).length, 2);
  assert.equal(repository.getSessionRecord(root, "one").status, "active");
  await service.syncRoot(root);
  assert.deepEqual(repository.getSessions(root).map((item) => item.sessionId), ["one", "two"]);
  assert.equal(repository.getSessions(root)[0].inputTokens, 20);
  assert.deepEqual(repository.getDelta(root).removedSessionIds, []);
  assert.equal(repository.getRoot(root).removed_count, 1);
  assert.equal(repository.getSessionRecord(root, "two").status, "deleted");
  assert.equal(typeof repository.getSessionRecord(root, "two").deleted_at, "number");

  assert.equal(service.setIntervalSeconds(15).intervalSeconds, 15);
  assert.throws(() => parseIntervalSeconds(0), /between/);
  assert.throws(() => service.setIntervalSeconds("invalid"), /between/);
  service.close();
});

test("concurrent sync requests share the initial filesystem scan", async () => {
  const repository = new SqliteSessionRepository(":memory:");
  let releaseDiscovery;
  let discoveryCalls = 0;
  const discovery = () => new Promise((resolve) => {
    discoveryCalls += 1;
    releaseDiscovery = () => resolve({
      inspectedFolders: 1,
      sessions: [session("initial")],
      changed: [session("initial")],
      removedSessionIds: [],
      unchangedCount: 0,
      fullRebuild: true,
      lastSyncTs: 1
    });
  });
  const service = new SessionSyncService({ repository, discover: discovery });
  const root = service.registerRoot("fixture-root");

  const first = service.syncRoot(root);
  const second = service.syncRoot(root);
  assert.equal(discoveryCalls, 1);

  releaseDiscovery();
  await Promise.all([first, second]);

  assert.deepEqual(repository.getSessions(root).map((item) => item.sessionId), ["initial"]);
  service.close();
});
