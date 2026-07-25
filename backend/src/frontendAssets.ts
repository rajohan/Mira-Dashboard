import fs from "node:fs";
import path from "node:path";

import { getProcessReleaseRoot } from "./releaseManifest.ts";

export function resolveFrontendPath(): string {
    return (
        process.env.MIRA_DASHBOARD_FRONTEND_PATH ||
        path.join(getProcessReleaseRoot(), "dist")
    );
}

export function isFrontendIndexReady(): boolean {
    try {
        const indexStat = fs.statSync(path.join(resolveFrontendPath(), "index.html"));
        return indexStat.isFile();
    } catch {
        return false;
    }
}
