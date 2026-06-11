import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mira-dashboard-test-"));
fs.mkdirSync(path.join(testRoot, "data"), { recursive: true });

process.env.MIRA_DASHBOARD_DB_PATH = path.join(testRoot, "data", "mira-dashboard.db");
globalThis.process.env.NODE_ENV = "test";
