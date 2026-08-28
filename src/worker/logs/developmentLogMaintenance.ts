import path from "node:path";

import type {
    ManagedLogFileTarget,
    ManagedLogManifest,
} from "../../shared/managedLogManifest.ts";
import type { FixedSystemLogrotateBroker } from "./fixedSystemLogrotateBroker.ts";
import {
    createLogMaintenanceExecutor,
    type LogMaintenanceExecutor,
} from "./logMaintenanceExecutor.ts";
import { createManagedLogRotationEngine } from "./managedLogRotation.ts";

const mebibyte = 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;

interface DevelopmentLogLayout {
    readonly production: {
        readonly state: {
            readonly logMaintenance: string;
            readonly logs: string;
        };
    };
}

function runtimeOwnerId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw new Error(
            "Development log maintenance requires Linux with process.getuid support"
        );
    }
    return process.getuid();
}

function developmentLogTarget(
    logsDirectory: string,
    id: string,
    fileName: string,
    ownerId: number
): ManagedLogFileTarget {
    return Object.freeze({
        cadenceMs: dayMs,
        compress: true,
        filePath: path.join(logsDirectory, fileName),
        id,
        maximumSizeBytes: 10 * mebibyte,
        maximumSourceBytes: 128 * mebibyte,
        retentionAgeMs: 14 * dayMs,
        retentionCount: 7,
        strategy: "copytruncate",
        trustedOwnerIds: Object.freeze([ownerId]),
    });
}

/**
 * Builds the development-only managed log inventory. No host, container, OpenClaw,
 * systemd, or path supplied by a browser is reachable through this manifest.
 * @param layout Synthetic project layout rooted in marked development state.
 * @returns A frozen manifest containing only the web and worker dev log files.
 */
export function developmentManagedLogManifest(
    layout: DevelopmentLogLayout
): ManagedLogManifest {
    const ownerId = runtimeOwnerId();
    const logsDirectory = layout.production.state.logs;
    return Object.freeze({
        archiveTargets: Object.freeze([]),
        fileTargets: Object.freeze([
            developmentLogTarget(
                logsDirectory,
                "dashboard.web.primary",
                "web.ndjson",
                ownerId
            ),
            developmentLogTarget(
                logsDirectory,
                "dashboard.web.fallback",
                "web-fallback.ndjson",
                ownerId
            ),
            developmentLogTarget(
                logsDirectory,
                "dashboard.worker.primary",
                "worker.ndjson",
                ownerId
            ),
            developmentLogTarget(
                logsDirectory,
                "dashboard.worker.fallback",
                "worker-fallback.ndjson",
                ownerId
            ),
        ]),
        lockPath: path.join(
            layout.production.state.logMaintenance,
            "development-managed.lock"
        ),
        statePath: path.join(
            layout.production.state.logMaintenance,
            "development-managed-state.json"
        ),
    });
}

const unavailableHostBroker: FixedSystemLogrotateBroker = Object.freeze({
    availablePolicies: () => Promise.resolve([]),
    ensureManagedAccess: () => Promise.resolve(),
    run: () => Promise.reject(new Error("Host log maintenance is unavailable")),
});

/**
 * Creates worker log maintenance constrained to synthetic development state.
 * @param layout Synthetic project layout rooted in marked development state.
 * @returns The fixed-policy executor with no host policy authority.
 */
export function createDevelopmentLogMaintenanceExecutor(
    layout: DevelopmentLogLayout
): LogMaintenanceExecutor {
    return createLogMaintenanceExecutor({
        managed: createManagedLogRotationEngine({
            manifest: developmentManagedLogManifest(layout),
        }),
        system: unavailableHostBroker,
    });
}
