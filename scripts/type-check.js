const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const result = spawnSync(process.execPath, ["--check", path.join(root, "app", "copilot-cost-dashboard-server.js")], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
