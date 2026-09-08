const { createExcelBuffer } = require("./infrastructure/excel-exporter");
const { server, sessionCatalog, closeCopilotDatabases, startServer } = require("./bootstrap");
const { parseJsonl, extractChatSessionTurns, buildSessionFromFallbackTurns, analyzeSession } = require("./domain/session-metrics");
const { buildModelPriceMap } = require("./domain/pricing");
const { summarizeEditingOperations } = require("./domain/editing-metrics");
const { readSessionsFromRoot, refreshSessionsFromRoot } = require("./infrastructure/session-discovery");

module.exports = {
  server,
  sessionCatalog,
  createExcelBuffer,
  closeCopilotDatabases,
  startServer,
  parseJsonl,
  buildModelPriceMap,
  extractChatSessionTurns,
  buildSessionFromFallbackTurns,
  analyzeSession,
  summarizeEditingOperations,
  readSessionsFromRoot,
  refreshSessionsFromRoot
};

if (require.main === module) {
  startServer();
}
