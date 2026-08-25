import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import { createManagedLogManifest } from "../../shared/managedLogManifest.ts";

const maintenanceGroupName = "mira-dashboard-log-maintenance";

function resolveMaintenanceGroupId(): number | undefined {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(
            "/etc/group",
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const status = fstatSync(descriptor);
        if (
            !status.isFile() ||
            status.nlink !== 1 ||
            status.uid !== 0 ||
            (status.mode & 0o022) !== 0 ||
            status.size === 0 ||
            status.size > 1024 * 1024
        ) {
            return undefined;
        }
        const matches = readFileSync(descriptor, "utf8")
            .split("\n")
            .filter((line) => line.startsWith(`${maintenanceGroupName}:`));
        if (matches.length !== 1) return undefined;
        const fields = matches[0]?.split(":");
        const groupId = fields?.[2];
        if (fields?.length !== 4 || !/^(?:0|[1-9]\d{0,9})$/u.test(groupId ?? "")) {
            return undefined;
        }
        const parsed = Number(groupId);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

const runtimeOwnerId = typeof process.getuid === "function" ? process.getuid() : 0;

export const managedLogManifest = createManagedLogManifest(
    runtimeOwnerId,
    resolveMaintenanceGroupId()
);

export type {
    ManagedArchiveTarget,
    ManagedLogFileTarget,
    ManagedLogManifest,
    ManagedLogRotationStrategy,
} from "../../shared/managedLogManifest.ts";
export { validateManagedLogManifest } from "../../shared/managedLogManifest.ts";
