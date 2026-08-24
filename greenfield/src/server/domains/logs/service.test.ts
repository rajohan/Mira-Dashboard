import { describe, expect, test } from "bun:test";

import type {
    LogMaintenancePolicyId,
    RequestLogMaintenanceInput,
} from "../../../contracts/logs.ts";
import type { SafeLogReader } from "../../platform/logs/safeLogReader.ts";
import type { LogSourceCatalog } from "../../platform/logs/sourceCatalog.ts";
import type { LogMaintenanceAuditEvent } from "./operationAudit.ts";
import { createLogsService, LogsServiceError } from "./service.ts";

const digest = "a".repeat(64);
const jobRunId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const input: RequestLogMaintenanceInput = {
    idempotencyKey: "log-maintenance:019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    policyId: "host-rsyslog",
};
const auditContext = {
    actor: {
        authenticatorId: "a".repeat(32),
        id: jobRunId,
        kind: "user" as const,
    },
    requestId: "request-1",
};

function dependencies(
    options: {
        readonly auditEvents?: LogMaintenanceAuditEvent[];
        readonly auditFailure?: "attempted" | "queued";
        readonly enqueueFailure?: boolean;
        readonly settlements?: string[];
    } = {}
) {
    const auditEvents = options.auditEvents ?? [];
    const settlements = options.settlements ?? [];
    const catalog: LogSourceCatalog = {
        list: () => Promise.resolve({ observedAtMs: 100, sources: [] }),
        resolve: () => Promise.resolve(undefined),
    };
    const reader: SafeLogReader = {
        search: (request) =>
            Promise.resolve({
                hasEarlier: false,
                lines: [],
                observedAtMs: 100,
                revision: digest,
                scannedBytes: 0,
                sourceId: request.sourceId,
            }),
        tail: (request) =>
            Promise.resolve({
                hasEarlier: false,
                lines: [],
                observedAtMs: 100,
                revision: digest,
                scannedBytes: 0,
                sourceId: request.sourceId,
            }),
    };
    return {
        auditEvents,
        service: createLogsService({
            auditWriter: {
                record: (event) => {
                    if (options.auditFailure === event.settlement) {
                        return Promise.reject(new Error("private audit failure"));
                    }
                    auditEvents.push(event);
                    return Promise.resolve();
                },
            },
            catalog,
            maintenanceQueue: {
                queueablePolicies: () =>
                    Promise.resolve([
                        "docker-managed",
                        "host-rsyslog",
                    ] satisfies LogMaintenancePolicyId[]),
                enqueue: () =>
                    options.enqueueFailure
                        ? Promise.reject(new Error("private queue failure"))
                        : Promise.resolve({ jobRunId }),
            },
            now: () => 200,
            onAuditSettlementFailure: ({ settlement }) => settlements.push(settlement),
            reader,
        }),
        settlements,
    };
}

async function captureFailure(work: () => Promise<unknown>) {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected failure");
}

describe("logs service", () => {
    test("projects fixed queueability without dynamic policy identities", async () => {
        const status = await dependencies().service.maintenanceStatus();
        expect(status.observedAtMs).toBe(200);
        expect(status.policies).toHaveLength(5);
        expect(status.policies.find(({ id }) => id === "host-rsyslog")?.state).toBe(
            "queueable"
        );
        expect(status.policies.find(({ id }) => id === "host-apport")?.state).toBe(
            "unavailable"
        );
    });

    test("durably records attempted before worker queue dispatch and a sanitized settlement", async () => {
        const fixture = dependencies();
        expect(await fixture.service.requestMaintenance(input, auditContext)).toEqual({
            jobRunId,
            policyId: "host-rsyslog",
            queued: true,
        });
        expect(fixture.auditEvents).toMatchObject([
            { policyId: "host-rsyslog", settlement: "attempted" },
            { jobRunId, policyId: "host-rsyslog", settlement: "queued" },
        ]);
    });

    test("fails closed before dispatch when the attempted audit append fails", async () => {
        let enqueued = false;
        const service = createLogsService({
            ...dependencies({ auditFailure: "attempted" }).service,
            auditWriter: { record: () => Promise.reject(new Error("private")) },
            catalog: {
                list: () => Promise.resolve({ observedAtMs: 1, sources: [] }),
                resolve: () => Promise.resolve(undefined),
            },
            maintenanceQueue: {
                queueablePolicies: () => Promise.resolve([]),
                enqueue: () => {
                    enqueued = true;
                    return Promise.resolve({ jobRunId });
                },
            },
            reader: {
                search: () => Promise.reject(new Error("unused")),
                tail: () => Promise.reject(new Error("unused")),
            },
        });
        expect(
            await captureFailure(() => service.requestMaintenance(input, auditContext))
        ).toMatchObject({
            reason: "audit-unavailable",
        });
        expect(enqueued).toBe(false);
    });

    test("preserves a confirmed queued result when terminal audit settlement fails", async () => {
        const fixture = dependencies({ auditFailure: "queued" });
        expect(
            await fixture.service.requestMaintenance(input, auditContext)
        ).toMatchObject({
            queued: true,
        });
        expect(fixture.settlements).toEqual(["queued"]);
    });

    test("sanitizes queue failures after recording a failed terminal outcome", async () => {
        const fixture = dependencies({ enqueueFailure: true });
        const error = await captureFailure(() =>
            fixture.service.requestMaintenance(input, auditContext)
        );
        expect(error).toBeInstanceOf(LogsServiceError);
        expect(error).toMatchObject({ reason: "unavailable" });
        expect(JSON.stringify(error)).not.toContain("private queue failure");
        expect(fixture.auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "failed",
        ]);
    });
});
