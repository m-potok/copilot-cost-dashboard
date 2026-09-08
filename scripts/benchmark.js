const path = require("path");
const { performance } = require("node:perf_hooks");
const { sessionCatalog } = require("../app/copilot-cost-dashboard-server");

const root = path.join(__dirname, "..", "test", "fixtures");
const maxInitialMs = Number(process.env.BENCHMARK_MAX_INITIAL_MS || 1000);
const maxRefreshMs = Number(process.env.BENCHMARK_MAX_REFRESH_MS || 1000);

async function run() {
  const initialStart = performance.now();
  const initial = await sessionCatalog.read(root);
  const initialMs = performance.now() - initialStart;

  const refreshStart = performance.now();
  const delta = await sessionCatalog.read(root);
  const refreshMs = performance.now() - refreshStart;

  const result = {
    root,
    sessions: initial.sessions.length,
    initialMs: Number(initialMs.toFixed(2)),
    refreshMs: Number(refreshMs.toFixed(2)),
    unchangedCount: delta.unchangedCount
  };
  console.log(JSON.stringify(result, null, 2));

  if (initialMs > maxInitialMs || refreshMs > maxRefreshMs) {
    throw new Error(`Benchmark thresholds exceeded: initial <= ${maxInitialMs}ms, refresh <= ${maxRefreshMs}ms`);
  }
  if (delta.unchangedCount !== initial.sessions.length) {
    throw new Error("Incremental refresh did not reuse unchanged sessions");
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
