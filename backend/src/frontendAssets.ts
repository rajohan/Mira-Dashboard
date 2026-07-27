import fs from "node:fs";
import path from "node:path";

import { getProcessReleaseRoot } from "./releaseManifest.ts";

export function resolveFrontendPath(
    environment: Record<string, string | undefined> = process.env,
    releaseRoot = getProcessReleaseRoot()
): string {
    const releaseFrontendPath = path.join(releaseRoot, "dist");
    if (environment.NODE_ENV === "production") {
        return releaseFrontendPath;
    }
    const configuredPath = environment.MIRA_DASHBOARD_FRONTEND_PATH?.trim();
    return configuredPath || releaseFrontendPath;
}

export function isFrontendIndexReady(): boolean {
    try {
        const indexStat = fs.statSync(path.join(resolveFrontendPath(), "index.html"));
        return indexStat.isFile();
    } catch {
        return false;
    }
}
