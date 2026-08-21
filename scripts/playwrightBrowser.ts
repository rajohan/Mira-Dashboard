import { access } from "node:fs/promises";
import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

/**
 * Ensures the repository-local Playwright Chromium shell exists before browser-backed checks.
 * @param projectRoot Canonical repository package root.
 * @returns Zero when Chromium exists or the installer exit code.
 */
export async function ensurePlaywrightChromium(projectRoot: string): Promise<number> {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "node_modules/.cache/playwright";
    const { chromium } = await import("playwright");
    try {
        await access(chromium.executablePath());
        return 0;
    } catch {
        // Install the repository-pinned shell below.
    }
    return runCommandProcess(
        {
            name: "playwright:install",
            arguments: [
                path.join(projectRoot, "node_modules", ".bin", "playwright"),
                "install",
                "chromium",
                "--only-shell",
            ],
            environment: {
                PLAYWRIGHT_BROWSERS_PATH: "node_modules/.cache/playwright",
            },
        },
        { cwd: projectRoot, environment: process.env }
    );
}
