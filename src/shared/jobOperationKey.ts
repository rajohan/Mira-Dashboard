import type { JsonObject } from "./json.ts";

function stringField(payload: JsonObject, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" ? value : undefined;
}

function booleanField(payload: JsonObject, key: string): boolean | undefined {
    const value = payload[key];
    return typeof value === "boolean" ? value : undefined;
}

const serviceActionIdByActionKey = Object.freeze({
    "host.dashboard-stack.restart": "dashboard-stack-restart",
    "host.dashboard.restart": "dashboard-restart",
    "host.system.cleanup": "system-cleanup",
    "host.system.restart": "system-restart",
    "host.system.update": "system-update",
    "host.worker.restart": "worker-restart",
    "openclaw.gateway.restart": "openclaw-restart",
    "openclaw.installation.update": "openclaw-update",
    "openclaw.sessions.cleanup": "openclaw-cleanup",
} satisfies Readonly<Record<string, string>>) as Readonly<Record<string, string>>;

/**
 * Projects one stable browser operation identity from reviewed run metadata.
 * @param actionKey Durable action identity.
 * @param payload Validated durable action payload.
 * @returns Exact button/tray identity without exposing the payload.
 */
export function jobOperationKey(actionKey: string, payload: JsonObject): string {
    const serviceActionId = serviceActionIdByActionKey[actionKey];
    if (serviceActionId !== undefined) return `service-action:${serviceActionId}`;

    if (actionKey.startsWith("cache.refresh.")) {
        const key = stringField(payload, "key");
        if (key !== undefined) return `cache-refresh:${key}`;
    }
    if (actionKey === "maintenance.rotate-logs") {
        const policyId = stringField(payload, "policyId");
        const dryRun = booleanField(payload, "dryRun");
        if (policyId !== undefined && dryRun !== undefined) {
            return `log-maintenance:${policyId}:${dryRun ? "preview" : "run"}`;
        }
    }
    if (actionKey === "docker.updater") {
        const operation = stringField(payload, "operation");
        if (operation === "updater-run") return "job:docker.updater:run";
        if (operation === "updater-scan") return "job:docker.updater:scan";
        if (operation === "updater-update-service") {
            const serviceId = stringField(payload, "serviceId");
            if (serviceId !== undefined) {
                return `job:docker.updater:service:${serviceId}`;
            }
        }
    }
    if (actionKey === "docker.operation") return "job:docker.operation";
    if (actionKey.startsWith("backup.")) {
        const type = stringField(payload, "type");
        const operation = stringField(payload, "operation");
        if (type !== undefined && operation !== undefined) {
            return `backup:${type}:${operation}`;
        }
    }
    if (actionKey.startsWith("delivery.")) {
        const operation = stringField(payload, "operation");
        if (operation !== undefined) return `delivery:${operation}`;
    }
    if (actionKey === "workspace-files.apply-write") return "workspace-file-write";
    return `job:${actionKey}`;
}
