import os from "node:os";
import path from "node:path";

import { runProcess } from "../lib/processes.ts";
import { registerScheduledJobAction } from "./scheduledJobs.ts";

export const OPENCLAW_GATEWAY_RESTART_ACTION = "openclaw.gateway.restart";

function getOpenClawBin(): string {
    const homeDirectory = process.env.HOME?.trim() || os.homedir();
    return (
        process.env.OPENCLAW_BIN?.trim() ||
        path.join(homeDirectory, ".npm-global/bin/openclaw")
    );
}

export function registerOpenClawExecutionActions(): void {
    registerScheduledJobAction(
        OPENCLAW_GATEWAY_RESTART_ACTION,
        async (_job, signal) => {
            const result = await runProcess(getOpenClawBin(), ["gateway", "restart"], {
                signal,
                timeoutMs: 30_000,
            });
            if (result.code !== 0) {
                throw new Error(
                    result.stderr.trim() ||
                        result.stdout.trim() ||
                        `openclaw exited ${result.code}`
                );
            }
            return {
                code: result.code,
                stderr: result.stderr,
                stdout: result.stdout,
            };
        },
        { timeoutMs: 60_000 }
    );
}
