import "dotenv/config";

import { pathToFileURL } from "node:url";

import { shouldStartOnImport, startBackendServer } from "./serverStart.js";

const isDirectEntrypoint = Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (shouldStartOnImport(process.env.MIRA_DASHBOARD_START_ON_IMPORT, isDirectEntrypoint)) {
    startBackendServer();
}
