import fs from "node:fs";
import path from "node:path";

import { getProcessReleaseRoot } from "./releaseManifest.ts";

export function resolveFrontendPath(
    environment: Record<string, string | undefined> = process.env,
    releaseRoot = getProcessReleaseRoot()
): string {
    const releaseFrontendPath = path.join(releaseRoot, "dist");
    const configuredPath = environment.MIRA_DASHBOARD_FRONTEND_PATH?.trim();
    if (!configuredPath) {
        return releaseFrontendPath;
    }
    if (
        environment.NODE_ENV === "production" &&
        path.resolve(configuredPath) !== path.resolve(releaseFrontendPath)
    ) {
        throw new Error(
            "MIRA_DASHBOARD_FRONTEND_PATH cannot override the checksummed release frontend in production"
        );
    }
    return configuredPath;
}

export function isFrontendIndexReady(): boolean {
    try {
        const indexStat = fs.statSync(path.join(resolveFrontendPath(), "index.html"));
        return indexStat.isFile();
    } catch {
        return false;
    }
}
