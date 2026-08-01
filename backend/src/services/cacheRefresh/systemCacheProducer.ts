import os from "node:os";

import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { evaluateOpenClawNotifications } from "../openclawNotifications.ts";
import { writeCacheFailure } from "./cacheEntryFailure.ts";
import {
    asRecord,
    errorMessage,
    type JsonRecord,
    nowIso,
    runCacheCommand,
    stripAnsi,
    toNumber,
    toOptionalString,
} from "./cacheProducerSupport.ts";

const logger = createStructuredLogger("cache-refresh");

function latestOpenClawVersionFromUpdateStatus(value: unknown): string | undefined {
    const updateStatus = asRecord(value);
    const availability = asRecord(updateStatus.availability);
    const update = asRecord(updateStatus.update);
    const registry = asRecord(update.registry);
    return (
        toOptionalString(availability.latestVersion) ||
        toOptionalString(registry.latestVersion)
    );
}

function getOpenclawBin() {
    return nonEmptyEnvironmentFallback(
        "OPENCLAW_BIN",
        "/home/ubuntu/.npm-global/bin/openclaw"
    );
}

async function getHostSummary() {
    let disk = {
        totalBytes: 0,
        usedBytes: 0,
        percent: 0,
    };
    try {
        const output = await runCacheCommand("df", ["-B1", "/"]);
        const line = output.trim().split("\n").at(-1)!;
        const parts = line.trim().split(/\s+/u);
        disk = {
            totalBytes: toNumber(parts[1]),
            usedBytes: toNumber(parts[2]),
            percent: toNumber(String(parts[4] ?? "0").replace("%", "")),
        };
    } catch (error) {
        logger.warn("cache_refresh.host_disk_summary_failed", { error });
    }

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        disk,
        memory: {
            totalBytes: totalMemory,
            usedBytes: totalMemory - freeMemory,
            freeBytes: freeMemory,
            freeMb: Math.round(freeMemory / 1024 / 1024),
        },
        checkedAt: nowIso(),
    };
}

function buildFallbackHostSummary(checkedAt: string) {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        disk: { totalBytes: 0, usedBytes: 0, percent: 0 },
        memory: {
            totalBytes: os.totalmem(),
            usedBytes: os.totalmem() - os.freemem(),
            freeBytes: os.freemem(),
            freeMb: Math.round(os.freemem() / 1024 / 1024),
        },
        checkedAt,
    };
}

export async function refreshSystemCache() {
    const openclawBin = getOpenclawBin();
    const checkedAt = nowIso();
    const [statusResult, updateStatusResult, doctorResult, securityResult, hostResult] =
        await Promise.allSettled([
            runCacheCommand(openclawBin, ["status", "--json"]),
            runCacheCommand(openclawBin, ["update", "status", "--json"]),
            runCacheCommand(openclawBin, ["doctor"]),
            runCacheCommand(openclawBin, ["security", "audit", "--json"]),
            getHostSummary(),
        ]);
    let statusError =
        statusResult.status === "rejected"
            ? errorMessage(statusResult.reason)
            : undefined;
    let statusFailure: unknown =
        statusResult.status === "rejected" ? statusResult.reason : undefined;
    let status: JsonRecord = {};
    if (statusResult.status === "fulfilled") {
        try {
            status = JSON.parse(statusResult.value) as JsonRecord;
        } catch (error) {
            statusError = errorMessage(error);
            statusFailure = error;
            logger.warn("cache_refresh.openclaw_status_parse_failed", { error });
        }
    }
    const doctorError =
        doctorResult.status === "rejected"
            ? errorMessage(doctorResult.reason)
            : undefined;
    let securityError =
        securityResult.status === "rejected"
            ? errorMessage(securityResult.reason)
            : undefined;
    let security: JsonRecord | undefined;
    if (securityResult.status === "fulfilled") {
        try {
            security = JSON.parse(securityResult.value) as JsonRecord;
        } catch (error) {
            securityError = errorMessage(error);
            logger.warn("cache_refresh.security_audit_parse_failed", { error });
        }
    }
    const doctorWarnings =
        doctorResult.status === "fulfilled"
            ? doctorResult.value
                  .split("\n")
                  .map((line) => stripAnsi(line).trim())
                  .filter((line) => line.startsWith("- WARNING:"))
                  .map((line) => line.replace(/^- WARNING:\s*/u, "").trim())
            : [];
    const currentVersion =
        typeof status.runtimeVersion === "string" ? status.runtimeVersion : "unknown";
    const update = asRecord(status.update);
    const registry = asRecord(update.registry);
    let updateStatusError =
        updateStatusResult.status === "rejected"
            ? errorMessage(updateStatusResult.reason)
            : undefined;
    let updateStatus: JsonRecord = {};
    if (updateStatusResult.status === "fulfilled") {
        try {
            updateStatus = JSON.parse(updateStatusResult.value) as JsonRecord;
        } catch (error) {
            updateStatusError = errorMessage(error);
            logger.warn("cache_refresh.update_status_parse_failed", { error });
        }
    }
    const latestVersion =
        latestOpenClawVersionFromUpdateStatus(updateStatus) ||
        toOptionalString(registry.latestVersion);
    const version = {
        current: currentVersion,
        latest: latestVersion,
        updateAvailable: Boolean(
            currentVersion !== "unknown" &&
            latestVersion &&
            currentVersion !== latestVersion
        ),
        checkedAt: Date.now(),
    };
    const host =
        hostResult.status === "fulfilled"
            ? hostResult.value
            : buildFallbackHostSummary(checkedAt);
    const hostPayload = {
        ...host,
        version: {
            ...version,
            hostError:
                hostResult.status === "rejected"
                    ? errorMessage(hostResult.reason)
                    : undefined,
            openclawError: statusError,
            updateStatusError,
        },
        checkedAt,
    };
    if (statusError) {
        writeCacheFailure({
            key: "system.openclaw",
            source: "backend",
            ttl: 15,
            ttlUnit: "minutes",
            error: statusFailure,
            metadata: {
                workflow: "Cache Foundation - System Checks",
                kind: "openclaw",
            },
        });
    } else {
        const openclawPayload = {
            version,
            updateStatus,
            gateway: status.gateway ?? undefined,
            gatewayService: status.gatewayService ?? undefined,
            nodeService: status.nodeService ?? undefined,
            heartbeat: status.heartbeat ?? undefined,
            tasks: status.tasks ?? undefined,
            taskAudit: status.taskAudit ?? undefined,
            doctorWarnings,
            doctorError,
            doctorWarningCount: doctorWarnings.length,
            security,
            securityError,
            updateStatusError,
            checkedAt,
        };
        writeCacheSuccess({
            key: "system.openclaw",
            data: openclawPayload,
            source: "backend",
            ttl: 24,
            ttlUnit: "hours",
            metadata: {
                workflow: "Cache Foundation - System Checks",
                kind: "openclaw",
                summary: {
                    updateAvailable: version.updateAvailable,
                    doctorWarningCount: doctorWarnings.length,
                },
            },
        });
    }
    writeCacheSuccess({
        key: "system.host",
        data: hostPayload,
        source: "backend",
        ttl: 24,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - System Checks",
            kind: "host",
            summary: {
                diskPercent: host.disk.percent,
                memoryFreeMb: host.memory.freeMb,
                uptimeSeconds: host.uptimeSeconds,
            },
        },
    });
    evaluateOpenClawNotifications(hostPayload);
    return { refreshed: ["system.openclaw", "system.host"] };
}
