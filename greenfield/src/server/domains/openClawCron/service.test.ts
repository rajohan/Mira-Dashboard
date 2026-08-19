import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createInMemoryOpenClawCronIntentStore,
    type OpenClawCronIntentStore,
} from "./intentStore.ts";
import type {
    OpenClawCronAuditContext,
    OpenClawCronOperationAuditInput,
} from "./operationAudit.ts";
import { projectOpenClawCronRun } from "./projection.ts";
import {
    type OpenClawCronProvider,
    OpenClawCronProviderError,
    type OpenClawCronProviderJob,
} from "./provider.ts";
import {
    OpenClawCronServiceError,
    createOpenClawCronService,
    openClawCronHeartbeatFailureBackoffMs,
    openClawCronHeartbeatInventoryMaximumBytes,
    openClawCronHeartbeatRefreshIntervalMs,
} from "./service.ts";

const operator = {
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user",
} as const;
const auditContext = {
    actor: {
        authenticatorId: "a".repeat(32),
        id: operator.id,
        kind: "user",
    },
    requestId: "request-1",
} as const satisfies OpenClawCronAuditContext;

test("keeps synthesized run identities unique for maximum-length job IDs", () => {
    const jobId = "j".repeat(256);
    const first = projectOpenClawCronRun({ jobId, runAtMs: 1000, ts: 2000 });
    const second = projectOpenClawCronRun({ jobId, runAtMs: 2000, ts: 3000 });

    expect(first.runId).toHaveLength(74);
    expect(second.runId).toHaveLength(74);
    expect(first.runId).not.toBe(second.runId);
});

test("keeps indistinguishable legacy run identities unique within a source page", () => {
    const entry = { jobId: "legacy-job", ts: 2000 } as const;
    const first = projectOpenClawCronRun(entry, 10);
    const second = projectOpenClawCronRun(entry, 11);

    expect(first.runId).not.toBe(second.runId);
});

function providerJob(
    overrides: Partial<OpenClawCronProviderJob> = {}
): OpenClawCronProviderJob {
    return {
        configRevision: "revision-1",
        createdAtMs: 100,
        delivery: {
            accountId: "operations",
            bestEffort: true,
            channel: "slack",
            completionDestination: {
                mode: "webhook",
                to: "https://example.test/completed",
            },
            failureDestination: {
                accountId: "alerts",
                mode: "webhook",
                to: "https://example.test/failed",
            },
            mode: "announce",
            threadId: 42,
            to: "C012345",
        },
        enabled: true,
        id: "nightly-report",
        name: "Nightly report",
        payload: {
            kind: "agentTurn",
            message: "Produce the nightly report.",
            model: "openai/gpt-5.6-sol",
        },
        schedule: { expr: "0 7 * * *", kind: "cron", tz: "Europe/Oslo" },
        sessionTarget: "isolated",
        state: { nextRunAtMs: 2000 },
        updatedAtMs: 200,
        wakeMode: "now",
        ...overrides,
    };
}

function fakeProviderError(value: unknown): Error {
    return value instanceof Error ? value : new Error("Fake provider failure");
}

class FakeProvider implements OpenClawCronProvider {
    currentJob: OpenClawCronProviderJob | undefined = providerJob();
    readonly getCalls: Parameters<OpenClawCronProvider["get"]>[0][] = [];
    getError: unknown;
    holdUpdateReadback = false;
    readonly listCalls: Parameters<OpenClawCronProvider["list"]>[0][] = [];
    listError: unknown;
    readonly listRunsCalls: Parameters<OpenClawCronProvider["listRuns"]>[0][] = [];
    readonly removeCalls: Parameters<OpenClawCronProvider["remove"]>[0][] = [];
    onRemoveAcknowledged?: () => void;
    onUpdateAcknowledged?: () => void;
    removeDeletesBeforeError = false;
    removeError: unknown;
    readonly runCalls: Parameters<OpenClawCronProvider["run"]>[0][] = [];
    readonly setScratchCalls: Parameters<OpenClawCronProvider["setScratch"]>[0][] = [];
    readonly updateCalls: Parameters<OpenClawCronProvider["update"]>[0][] = [];
    updateError: unknown;
    updateErrorAppliesPatch = false;

    currentProcessInstanceId() {
        return "gateway-process-1";
    }

    get(input: Parameters<OpenClawCronProvider["get"]>[0]) {
        this.getCalls.push(input);
        if (this.getError !== undefined) {
            return Promise.reject(fakeProviderError(this.getError));
        }
        return Promise.resolve(this.currentJob);
    }

    list(
        input: Parameters<OpenClawCronProvider["list"]>[0]
    ): ReturnType<OpenClawCronProvider["list"]> {
        this.listCalls.push(input);
        if (this.listError !== undefined) {
            return Promise.reject(fakeProviderError(this.listError));
        }
        const jobs = this.currentJob === undefined ? [] : [this.currentJob];
        return Promise.resolve({
            hasMore: false,
            jobs,
            limit: input.limit,
            nextOffset: null,
            offset: input.offset,
            responseBytes: 1024,
            snapshotRevision: `sha256:${"A".repeat(43)}`,
            total: jobs.length,
        });
    }

    listRuns(input: Parameters<OpenClawCronProvider["listRuns"]>[0]) {
        this.listRunsCalls.push(input);
        return Promise.resolve({
            entries: [
                {
                    deliveryStatus: "delivered" as const,
                    durationMs: 500,
                    errorReason: "timeout" as const,
                    jobId: input.id,
                    model: "model/" + "m".repeat(300),
                    provider: "provider-" + "p".repeat(200),
                    runAtMs: 3000,
                    runId: "run-1",
                    status: "error" as const,
                    summary: "x".repeat(5000),
                    ts: 3500,
                    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
                },
            ],
            hasMore: false,
            limit: input.limit,
            nextOffset: null,
            offset: input.offset,
            total: 1,
        });
    }

    remove(input: Parameters<OpenClawCronProvider["remove"]>[0]) {
        this.removeCalls.push(input);
        if (this.removeError !== undefined) {
            if (this.removeDeletesBeforeError) this.currentJob = undefined;
            return Promise.reject(fakeProviderError(this.removeError));
        }
        this.currentJob = undefined;
        this.onRemoveAcknowledged?.();
        return Promise.resolve({ removed: true });
    }

    run(input: Parameters<OpenClawCronProvider["run"]>[0]) {
        this.runCalls.push(input);
        return Promise.resolve({ processInstanceId: "gateway-process-1", ran: true });
    }

    setScratch(input: Parameters<OpenClawCronProvider["setScratch"]>[0]) {
        this.setScratchCalls.push(input);
        if (this.currentJob?.scratch === undefined) {
            return Promise.reject(new OpenClawCronProviderError("not-found"));
        }
        this.currentJob = {
            ...this.currentJob,
            scratch: {
                content: input.content,
                revision: this.currentJob.scratch.revision + 1,
            },
        };
        return Promise.resolve({ revision: this.currentJob.scratch!.revision });
    }

    update(input: Parameters<OpenClawCronProvider["update"]>[0]) {
        this.updateCalls.push(input);
        if (this.updateError !== undefined) {
            if (this.updateErrorAppliesPatch && this.currentJob !== undefined) {
                this.currentJob = {
                    ...this.currentJob,
                    configRevision: `revision-${this.updateCalls.length + 1}`,
                    ...(input.patch.enabled === undefined
                        ? {}
                        : { enabled: input.patch.enabled }),
                    updatedAtMs: this.currentJob.updatedAtMs + 1,
                };
            }
            return Promise.reject(fakeProviderError(this.updateError));
        }
        const current = this.currentJob;
        if (current === undefined) {
            return Promise.reject(new OpenClawCronProviderError("not-found"));
        }
        const payload = input.patch.payload;
        let projectedPayload: OpenClawCronProviderJob["payload"] | undefined;
        if (payload?.kind === "agentTurn") {
            const { model, thinking, ...rest } = payload;
            projectedPayload = {
                ...rest,
                ...(typeof model === "string" ? { model } : {}),
                ...(typeof thinking === "string" ? { thinking } : {}),
            };
        } else {
            projectedPayload = payload;
        }
        const { description: _description, ...withoutDescription } = current;
        const description =
            input.patch.description === undefined
                ? current.description
                : (input.patch.description ?? undefined);
        const updated: OpenClawCronProviderJob = {
            ...withoutDescription,
            configRevision: `revision-${this.updateCalls.length + 1}`,
            ...(description === undefined ? {} : { description }),
            ...(input.patch.enabled === undefined
                ? {}
                : { enabled: input.patch.enabled }),
            ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
            ...(projectedPayload === undefined ? {} : { payload: projectedPayload }),
            ...(input.patch.schedule === undefined
                ? {}
                : { schedule: input.patch.schedule }),
            updatedAtMs: current.updatedAtMs + 1,
            ...(input.patch.wakeMode === undefined
                ? {}
                : { wakeMode: input.patch.wakeMode }),
        };
        if (!this.holdUpdateReadback) this.currentJob = updated;
        this.onUpdateAcknowledged?.();
        return Promise.resolve(updated);
    }
}

function fixture(clock = () => 1000, monotonicClock?: () => number) {
    const provider = new FakeProvider();
    const intentStore = createInMemoryOpenClawCronIntentStore();
    const service = createOpenClawCronService({
        auditRequired: false,
        clock,
        intentStore,
        ...(monotonicClock === undefined ? {} : { monotonicClock }),
        provider,
    });
    return { intentStore, provider, service };
}

function inventoryInput() {
    return {
        enabled: "all" as const,
        lastRunStatus: "all" as const,
        limit: 50,
        offset: 0,
        scheduleKind: "all" as const,
        sortBy: "nextRunAtMs" as const,
        sortDir: "asc" as const,
    };
}

function heartbeatJobs(count: number): OpenClawCronProviderJob[] {
    return Array.from({ length: count }, (_, index) =>
        providerJob({
            id: `heartbeat-job-${String(index).padStart(4, "0")}`,
            name: `Heartbeat job ${index}`,
        })
    );
}

function installHeartbeatPages(
    provider: FakeProvider,
    jobs: readonly OpenClawCronProviderJob[],
    snapshotRevision = `sha256:${"A".repeat(43)}`,
    total = jobs.length
): void {
    provider.list = (input) => {
        provider.listCalls.push(input);
        if (provider.listError !== undefined) {
            return Promise.reject(fakeProviderError(provider.listError));
        }
        const pageJobs = jobs.slice(input.offset, input.offset + input.limit);
        const nextOffset = input.offset + pageJobs.length;
        const hasMore = nextOffset < total;
        return Promise.resolve({
            hasMore,
            jobs: pageJobs,
            limit: input.limit,
            nextOffset: hasMore ? nextOffset : null,
            offset: input.offset,
            responseBytes: Math.max(
                1,
                Buffer.byteLength(JSON.stringify(pageJobs), "utf8")
            ),
            snapshotRevision,
            total,
        });
    };
}

describe("OpenClaw cron service", () => {
    test("fails closed before provider dispatch when required audit is unavailable", async () => {
        const provider = new FakeProvider();
        const service = createOpenClawCronService({
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });

        expect(
            await captureFailure(() =>
                service.run({ id: "nightly-report" }, undefined, auditContext)
            )
        ).toMatchObject({ reason: "audit-unavailable" });
        expect(provider.runCalls).toEqual([]);
    });

    test("fails closed before dispatch when required audit context is missing", async () => {
        const provider = new FakeProvider();
        const service = createOpenClawCronService({
            auditWriter: { record: () => Promise.resolve() },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });

        expect(
            await captureFailure(() => service.run({ id: "nightly-report" }))
        ).toMatchObject({ reason: "audit-unavailable" });
        expect(provider.runCalls).toEqual([]);
    });

    test("records attempted before dispatch and a sanitized known outcome", async () => {
        const provider = new FakeProvider();
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    if (input.settlement === "attempted") {
                        expect(provider.runCalls).toEqual([]);
                    }
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });

        const result = await service.run(
            { id: "nightly-report" },
            undefined,
            auditContext
        );

        expect(result.outcome).toBe("accepted");
        expect(
            auditEvents.map(({ operation, settlement }) => ({ operation, settlement }))
        ).toEqual([
            { operation: "run", settlement: "attempted" },
            { operation: "run", settlement: "succeeded" },
        ]);
    });

    test("audits every browser control with attempted and terminal records", async () => {
        const controls = ["delete", "set-enabled", "update"] as const;
        for (const control of controls) {
            const provider = new FakeProvider();
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                intentStore: createInMemoryOpenClawCronIntentStore(),
                provider,
            });

            if (control === "delete") {
                await service.delete(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    undefined,
                    auditContext
                );
            } else if (control === "set-enabled") {
                await service.setEnabled(
                    {
                        disableIntent: { reason: "Maintenance" },
                        enabled: false,
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    undefined,
                    auditContext
                );
            } else {
                await service.update(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                        patch: { name: "Morning report" },
                    },
                    undefined,
                    auditContext
                );
            }

            expect(
                auditEvents.map(({ operation, settlement }) => ({
                    operation,
                    settlement,
                }))
            ).toEqual([
                { operation: control, settlement: "attempted" },
                { operation: control, settlement: "succeeded" },
            ]);
        }
    });

    test("does not replace a known provider success when terminal audit append fails", async () => {
        const provider = new FakeProvider();
        let records = 0;
        const settlementFailures: string[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record() {
                    records += 1;
                    return records === 1
                        ? Promise.resolve()
                        : Promise.reject(new Error("audit storage unavailable"));
                },
            },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            onAuditSettlementFailure: ({ settlement }) => {
                settlementFailures.push(settlement);
                throw new Error("observability hook defect");
            },
            provider,
        });

        const result = await service.run(
            { id: "nightly-report" },
            undefined,
            auditContext
        );
        expect(result.outcome).toBe("accepted");
        expect(provider.runCalls).toHaveLength(1);
        expect(settlementFailures).toEqual(["succeeded"]);
    });

    test("preserves provider failure and reports partial settlement when audit append fails", async () => {
        const provider = new FakeProvider();
        provider.run = (input) => {
            provider.runCalls.push(input);
            return Promise.reject(new OpenClawCronProviderError("unknown-outcome"));
        };
        let records = 0;
        const settlementFailures: string[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record() {
                    records += 1;
                    return records === 1
                        ? Promise.resolve()
                        : Promise.reject(new Error("audit storage unavailable"));
                },
            },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            onAuditSettlementFailure: ({ settlement }) => {
                settlementFailures.push(settlement);
                throw new Error("observability hook defect");
            },
            provider,
        });

        expect(
            await captureFailure(() =>
                service.run({ id: "nightly-report" }, undefined, auditContext)
            )
        ).toMatchObject({ reason: "unknown-outcome" });
        expect(settlementFailures).toEqual(["partial"]);
    });
    test("returns a strict inventory and falls back to the same-query LKG snapshot", async () => {
        let nowMs = 1000;
        const { provider, service } = fixture(() => nowMs);
        const secret = "token=must-not-enter-browser";
        const longDeliveryTarget = `https://example.test/private?${secret}&padding=${"x".repeat(5000)}`;
        const longSessionTarget = `agent:${secret}:${"session".repeat(50)}`;
        provider.currentJob = providerJob({
            agentId: `agent:${secret}:${"identity".repeat(40)}`,
            delivery: {
                accountId: `account:${secret}:${"a".repeat(300)}`,
                bestEffort: true,
                channel: `channel:${secret}:${"c".repeat(300)}`,
                completionDestination: {
                    mode: "webhook",
                    to: longDeliveryTarget,
                },
                failureDestination: {
                    accountId: `failure:${secret}:${"a".repeat(300)}`,
                    channel: `failure-channel:${secret}:${"c".repeat(300)}`,
                    mode: "webhook",
                    to: longDeliveryTarget,
                },
                mode: "announce",
                threadId: `thread:${secret}:${"t".repeat(600)}`,
                to: longDeliveryTarget,
            },
            payload: { kind: "script", script: `run --${secret}` },
            schedule: {
                command: ["watch", secret],
                cwd: `/private/${secret}`,
                kind: "stream",
                match: secret,
                mode: "match",
            },
            sessionTarget: longSessionTarget,
        });

        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
        expect(provider.listCalls).toEqual([]);
        const fresh = await service.list({
            enabled: "all",
            lastRunStatus: "all",
            limit: 50,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        });
        expect(fresh.freshness).toEqual({ kind: "fresh", observedAtMs: 1000 });
        expect(fresh.jobs[0]).toMatchObject({
            agentIdTruncated: true,
            sessionTarget: "named-session",
        });
        expect(fresh.jobs[0]).not.toHaveProperty("agentId");
        expect(fresh.jobs[0]?.payload).toMatchObject({
            contentRedacted: true,
            kind: "script",
        });
        expect(fresh.jobs[0]?.delivery).toEqual({
            bestEffort: true,
            completionDestinationConfigured: true,
            failureDestination: {
                mode: "webhook",
                targetConfigured: true,
            },
            metadataTruncated: true,
            mode: "announce",
            targetConfigured: true,
        });
        expect(fresh.jobs[0]?.schedule).toEqual({
            argumentCount: 2,
            commandRedacted: true,
            kind: "stream",
            matchConfigured: true,
            mode: "match",
            workingDirectoryConfigured: true,
        });
        expect(JSON.stringify(fresh)).not.toContain(secret);
        expect(provider.listCalls[0]).toMatchObject({
            compact: false,
            includeDeliveryPreviews: false,
            limit: 50,
            offset: 0,
        });
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
        await service.refreshHeartbeatProjection();
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 1,
            health: { inspectedCount: 1, truncated: false },
            observedAtMs: 1000,
            pendingSync: "none",
            state: "fresh",
        });

        nowMs = 2000;
        provider.listError = new OpenClawCronProviderError("unavailable");
        const stale = await service.list({
            enabled: "all",
            lastRunStatus: "all",
            limit: 50,
            offset: 0,
            scheduleKind: "all",
            sortBy: "nextRunAtMs",
            sortDir: "asc",
        });
        expect(stale.freshness).toEqual({
            kind: "last-known-good",
            observedAtMs: 1000,
            staleSinceMs: 2000,
        });
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 1,
            observedAtMs: 1000,
            pendingSync: "none",
            state: "fresh",
        });
        try {
            await service.list({
                enabled: "enabled",
                lastRunStatus: "all",
                limit: 50,
                offset: 0,
                scheduleKind: "all",
                sortBy: "nextRunAtMs",
                sortDir: "asc",
            });
            throw new Error("Expected the uncached query to fail");
        } catch (error) {
            expect(error).toMatchObject({ reason: "provider-unavailable" });
        }
    });

    test("redacts command payload and on-exit schedule values from reads", async () => {
        const { provider, service } = fixture();
        const secret = "bearer-must-not-enter-browser";
        provider.currentJob = providerJob({
            payload: { argv: ["notify", `--token=${secret}`], kind: "command" },
            schedule: {
                command: `wait-for-exit --token=${secret}`,
                cwd: `/private/${secret}`,
                kind: "on-exit",
            },
        });

        const result = await service.list(inventoryInput());

        expect(result.jobs[0]?.payload).toEqual({
            argumentCount: 2,
            contentRedacted: true,
            kind: "command",
        });
        expect(result.jobs[0]?.schedule).toEqual({
            commandRedacted: true,
            kind: "on-exit",
            workingDirectoryConfigured: true,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    test("marks oversized editable definitions incomplete before browser editing", async () => {
        const { provider, service } = fixture();
        provider.currentJob = providerJob({
            description: "d".repeat(5000),
            name: "n".repeat(300),
            payload: {
                kind: "agentTurn",
                message: "m".repeat(17_000),
                model: "model/" + "x".repeat(300),
                thinking: "t".repeat(200),
            },
            schedule: {
                expr: "e".repeat(300),
                kind: "cron",
                tz: "z".repeat(200),
            },
        });

        const cron = await service.list(inventoryInput());

        expect(cron.jobs[0]).toMatchObject({
            descriptionTruncated: true,
            nameTruncated: true,
            payload: { kind: "agent-turn", truncated: true },
            schedule: { kind: "cron", truncated: true },
        });
        provider.currentJob = providerJob({
            schedule: {
                at: `${"2".repeat(140)}Z`,
                kind: "at",
            },
        });
        const at = await service.list(inventoryInput());
        expect(at.jobs[0]?.schedule).toMatchObject({
            kind: "at",
            truncated: true,
        });
    });

    test("does not let a truncated UI inventory prime the owned heartbeat", async () => {
        const { provider, service } = fixture();
        provider.list = (input) => {
            provider.listCalls.push(input);
            return Promise.resolve({
                hasMore: true,
                jobs: [providerJob()],
                limit: input.limit,
                nextOffset: 1,
                offset: 0,
                responseBytes: 1024,
                snapshotRevision: `sha256:${"A".repeat(43)}`,
                total: 2,
            });
        };

        await service.list({ ...inventoryInput(), limit: 1 });
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
    });

    test("owns cold refresh, success TTL, LKG fallback, and failure backoff", async () => {
        let wallClockMs = 1000;
        let monotonicClockMs = 0;
        const { provider, service } = fixture(
            () => wallClockMs,
            () => monotonicClockMs
        );

        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(1);
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 1,
            health: { inspectedCount: 1, truncated: false },
            observedAtMs: 1000,
            state: "fresh",
        });
        expect(service.readHeartbeatJobProjection("nightly-report")).toMatchObject({
            enabled: true,
            state: "present",
        });
        expect(service.readHeartbeatJobProjection("absent-job")).toEqual({
            state: "missing",
        });

        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(1);

        monotonicClockMs = openClawCronHeartbeatRefreshIntervalMs;
        wallClockMs = 2000;
        provider.listError = new OpenClawCronProviderError("unavailable");
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(2);
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 1,
            observedAtMs: 1000,
            staleSinceMs: 2000,
            state: "last-known-good",
        });
        expect(service.readHeartbeatJobProjection("nightly-report")).toEqual({
            state: "unavailable",
        });

        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(2);
        monotonicClockMs += openClawCronHeartbeatFailureBackoffMs;
        wallClockMs = 3000;
        provider.listError = undefined;
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(3);
        expect(service.readHeartbeatProjection()).toMatchObject({
            observedAtMs: 3000,
            state: "fresh",
        });
    });

    test("starts failure backoff when the failed refresh settles", async () => {
        let monotonicClockMs = 0;
        const { provider, service } = fixture(
            () => 1000,
            () => monotonicClockMs
        );
        await service.refreshHeartbeatProjection();
        const defaultList = provider.list.bind(provider);
        let failNext = true;
        provider.list = (input) => {
            if (!failNext) return defaultList(input);
            failNext = false;
            provider.listCalls.push(input);
            monotonicClockMs += 8000;
            return Promise.reject(new OpenClawCronProviderError("unavailable"));
        };

        monotonicClockMs = openClawCronHeartbeatRefreshIntervalMs;
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(2);
        expect(service.readHeartbeatProjection()).toMatchObject({
            state: "last-known-good",
        });

        monotonicClockMs += openClawCronHeartbeatFailureBackoffMs - 1;
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(2);
        monotonicClockMs += 1;
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(3);
        expect(service.readHeartbeatProjection()).toMatchObject({ state: "fresh" });
    });

    test("walks only coherent bounded inventories and keeps truncation truthful", async () => {
        for (const count of [0, 100, 101, 1000, 1001]) {
            const { provider, service } = fixture();
            const jobs = heartbeatJobs(count);
            installHeartbeatPages(provider, jobs);

            await service.refreshHeartbeatProjection();

            const inspectedCount = Math.min(count, 1000);
            expect(provider.listCalls).toHaveLength(
                Math.max(1, Math.ceil(inspectedCount / 100))
            );
            expect(service.readHeartbeatProjection()).toMatchObject({
                count,
                health: {
                    inspectedCount,
                    truncated: count > inspectedCount,
                },
                state: "fresh",
            });
            if (count > 0) {
                expect(
                    service.readHeartbeatJobProjection("heartbeat-job-0000")
                ).toMatchObject({ state: "present" });
            }
            expect(
                service.readHeartbeatJobProjection(
                    `heartbeat-job-${String(count).padStart(4, "0")}`
                )
            ).toEqual({ state: count > 1000 ? "unavailable" : "missing" });
        }
    });

    test("retries one revision race and never commits a mixed inventory", async () => {
        const { provider, service } = fixture();
        const jobs = heartbeatJobs(101);
        let walk = 0;
        provider.list = (input) => {
            provider.listCalls.push(input);
            if (input.offset === 0) walk += 1;
            const pageJobs = jobs.slice(input.offset, input.offset + input.limit);
            const nextOffset = input.offset + pageJobs.length;
            return Promise.resolve({
                hasMore: nextOffset < jobs.length,
                jobs: pageJobs,
                limit: input.limit,
                nextOffset: nextOffset < jobs.length ? nextOffset : null,
                offset: input.offset,
                responseBytes: 1024,
                snapshotRevision: `sha256:${(walk === 1 && input.offset > 0
                    ? "B"
                    : "A"
                ).repeat(43)}`,
                total: jobs.length,
            });
        };

        await service.refreshHeartbeatProjection();

        expect(provider.listCalls.map(({ offset }) => offset)).toEqual([0, 100, 0, 100]);
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 101,
            health: { inspectedCount: 101, truncated: false },
            state: "fresh",
        });
    });

    test("retains the whole prior snapshot when every pagination attempt is invalid", async () => {
        let wallClockMs = 1000;
        let monotonicClockMs = 0;
        const { provider, service } = fixture(
            () => wallClockMs,
            () => monotonicClockMs
        );
        await service.refreshHeartbeatProjection();
        const oldProjection = service.readHeartbeatProjection();
        if (oldProjection.state === "unavailable") {
            throw new Error("Expected the first heartbeat refresh to commit");
        }
        const jobs = heartbeatJobs(101);
        monotonicClockMs = openClawCronHeartbeatRefreshIntervalMs;
        wallClockMs = 2000;
        provider.list = (input) => {
            provider.listCalls.push(input);
            const pageJobs = jobs.slice(input.offset, input.offset + input.limit);
            const nextOffset = input.offset + pageJobs.length;
            return Promise.resolve({
                hasMore: nextOffset < jobs.length,
                jobs: pageJobs,
                limit: input.limit,
                nextOffset: nextOffset < jobs.length ? nextOffset : null,
                offset: input.offset,
                responseBytes: 1024,
                snapshotRevision: `sha256:${(input.offset === 0 ? "A" : "B").repeat(43)}`,
                total: jobs.length,
            });
        };

        await service.refreshHeartbeatProjection();

        expect(service.readHeartbeatProjection()).toMatchObject({
            count: oldProjection.count,
            observedAtMs: oldProjection.observedAtMs,
            staleSinceMs: 2000,
            state: "last-known-good",
        });
        expect(service.readHeartbeatJobProjection("heartbeat-job-0000")).toEqual({
            state: "unavailable",
        });
    });

    test("rejects duplicate, total, offset, and zero-progress page walks", async () => {
        for (const defect of ["duplicate", "total", "offset", "zero-progress"] as const) {
            const { provider, service } = fixture();
            const jobs = heartbeatJobs(101);
            provider.list = (input) => {
                provider.listCalls.push(input);
                const sourceJobs = jobs.slice(input.offset, input.offset + input.limit);
                let pageJobs = sourceJobs;
                if (input.offset === 100 && defect === "duplicate") {
                    pageJobs = [jobs[0]!];
                } else if (input.offset === 100 && defect === "zero-progress") {
                    pageJobs = [];
                }
                const nextOffset = input.offset + pageJobs.length;
                const hasMore = nextOffset < jobs.length;
                return Promise.resolve({
                    hasMore,
                    jobs: pageJobs,
                    limit: input.limit,
                    nextOffset: hasMore ? nextOffset : null,
                    offset:
                        input.offset === 100 && defect === "offset" ? 99 : input.offset,
                    responseBytes: 1024,
                    snapshotRevision: `sha256:${"A".repeat(43)}`,
                    total:
                        input.offset === 100 && defect === "total"
                            ? jobs.length + 1
                            : jobs.length,
                });
            };

            await service.refreshHeartbeatProjection();

            expect(service.readHeartbeatProjection()).toEqual({
                pendingSync: "unknown",
                state: "unavailable",
            });
            expect(provider.listCalls.map(({ offset }) => offset)).toEqual([
                0, 100, 0, 100,
            ]);
        }
    });

    test("walks pages sequentially and never starts unread siblings after failure", async () => {
        const { provider, service } = fixture();
        const jobs = heartbeatJobs(201);
        let activeReads = 0;
        let peakActiveReads = 0;
        provider.list = async (input) => {
            provider.listCalls.push(input);
            activeReads += 1;
            peakActiveReads = Math.max(peakActiveReads, activeReads);
            try {
                await Promise.resolve();
                if (input.offset === 100) {
                    throw new OpenClawCronProviderError("unavailable");
                }
                const pageJobs = jobs.slice(input.offset, input.offset + input.limit);
                const nextOffset = input.offset + pageJobs.length;
                return {
                    hasMore: nextOffset < jobs.length,
                    jobs: pageJobs,
                    limit: input.limit,
                    nextOffset: nextOffset < jobs.length ? nextOffset : null,
                    offset: input.offset,
                    responseBytes: 1024,
                    snapshotRevision: `sha256:${"A".repeat(43)}`,
                    total: jobs.length,
                };
            } finally {
                activeReads -= 1;
            }
        };

        await service.refreshHeartbeatProjection();

        expect(provider.listCalls.map(({ offset }) => offset)).toEqual([0, 100]);
        expect(peakActiveReads).toBe(1);
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
    });

    test("rejects an aggregate inventory byte overflow without retrying it", async () => {
        const { provider, service } = fixture();
        const message = "x".repeat(256 * 1024);
        const jobs = heartbeatJobs(130).map((job) =>
            providerJob({
                ...job,
                payload: { kind: "agentTurn", message },
            })
        );
        expect(message.length * jobs.length).toBeGreaterThan(
            openClawCronHeartbeatInventoryMaximumBytes
        );
        installHeartbeatPages(provider, jobs);

        await service.refreshHeartbeatProjection();

        expect(provider.listCalls.map(({ offset }) => offset)).toEqual([0, 100]);
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
    });

    test("single-flights refresh and aborts the process-owned flight on disposal", async () => {
        const { provider, service } = fixture();
        const deferred =
            Promise.withResolvers<Awaited<ReturnType<OpenClawCronProvider["list"]>>>();
        provider.list = (input) => {
            provider.listCalls.push(input);
            return deferred.promise;
        };
        const first = service.refreshHeartbeatProjection();
        const second = service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(1);
        deferred.resolve({
            hasMore: false,
            jobs: [providerJob()],
            limit: 100,
            nextOffset: null,
            offset: 0,
            responseBytes: 1024,
            snapshotRevision: `sha256:${"A".repeat(43)}`,
            total: 1,
        });
        await Promise.all([first, second]);
        expect(service.readHeartbeatProjection()).toMatchObject({ state: "fresh" });

        const disposable = fixture();
        let refreshSignal: AbortSignal | undefined;
        disposable.provider.list = (input) => {
            disposable.provider.listCalls.push(input);
            refreshSignal = input.signal;
            return new Promise((_resolve, reject) => {
                input.signal?.addEventListener(
                    "abort",
                    () => reject(new Error("disposed")),
                    { once: true }
                );
            });
        };
        const pending = disposable.service.refreshHeartbeatProjection();
        await Promise.resolve();
        await disposable.service.disposeHeartbeat();
        await pending;
        expect(refreshSignal?.aborted).toBeTrue();
        expect(disposable.service.readHeartbeatProjection()).toEqual({
            pendingSync: "unknown",
            state: "unavailable",
        });
    });

    test("classifies aggregate disabled, conflict, failure, and stuck health", async () => {
        const provider = new FakeProvider();
        const intentStore = createInMemoryOpenClawCronIntentStore();
        await intentStore.replaceActive({
            actor: operator,
            externalJobId: "intended-disabled",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        await intentStore.replaceActive({
            actor: operator,
            externalJobId: "enable-conflict",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        await intentStore.replaceActive({
            actor: operator,
            expiresAtMs: 1500,
            externalJobId: "expired-pending",
            reason: "Short freeze",
            recordedAtMs: 100,
        });
        const jobs = [
            providerJob({ enabled: false, id: "intended-disabled" }),
            providerJob({ enabled: false, id: "unexpected-disabled" }),
            providerJob({ enabled: true, id: "enable-conflict" }),
            providerJob({ enabled: false, id: "expired-pending" }),
            providerJob({
                id: "stuck-failure",
                state: {
                    lastRunStatus: "error",
                    runningAtMs: 1000,
                },
            }),
        ];
        installHeartbeatPages(provider, jobs);
        const service = createOpenClawCronService({
            auditRequired: false,
            clock: () => 2_000_000,
            intentStore,
            provider,
        });

        await service.refreshHeartbeatProjection();

        expect(service.readHeartbeatProjection()).toMatchObject({
            health: {
                disabledCount: 3,
                enabledCount: 2,
                inspectedCount: 5,
                intendedDisabledCount: 1,
                lastRunErrorCount: 1,
                runningCount: 1,
                staleRunningCount: 1,
                synchronizationConflictCount: 1,
                synchronizationPendingCount: 1,
                truncated: false,
                unexpectedDisabledCount: 2,
            },
            pendingSync: "present",
            state: "fresh",
        });
    });

    test("invalidates a successful TTL immediately after a cron mutation", async () => {
        let monotonicClockMs = 0;
        const { provider, service } = fixture(
            () => 1000,
            () => monotonicClockMs
        );
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(1);

        await service.update({
            expectedConfigRevision: "revision-1",
            id: "nightly-report",
            patch: { name: "Morning report" },
        });
        expect(service.readHeartbeatProjection()).toMatchObject({
            state: "last-known-good",
        });
        await service.refreshHeartbeatProjection();
        expect(provider.listCalls).toHaveLength(2);
        expect(service.readHeartbeatProjection()).toMatchObject({ state: "fresh" });
        monotonicClockMs += 1;
    });

    test("discards an in-flight pre-mutation candidate and refreshes waiting callers", async () => {
        let monotonicClockMs = 0;
        const { provider, service } = fixture(
            () => 1000,
            () => monotonicClockMs
        );
        await service.refreshHeartbeatProjection();
        const defaultList = provider.list.bind(provider);
        const heldPage =
            Promise.withResolvers<Awaited<ReturnType<OpenClawCronProvider["list"]>>>();
        let holdPage = true;
        provider.list = (input) => {
            if (!holdPage) return defaultList(input);
            provider.listCalls.push(input);
            return heldPage.promise;
        };

        monotonicClockMs = openClawCronHeartbeatRefreshIntervalMs;
        const staleFlight = service.refreshHeartbeatProjection();
        await Promise.resolve();
        await service.update({
            expectedConfigRevision: "revision-1",
            id: "nightly-report",
            patch: { name: "Morning report" },
        });
        const waitingRefresh = service.refreshHeartbeatProjection();
        holdPage = false;
        heldPage.resolve({
            hasMore: false,
            jobs: [providerJob()],
            limit: 100,
            nextOffset: null,
            offset: 0,
            responseBytes: 1024,
            snapshotRevision: `sha256:${"A".repeat(43)}`,
            total: 1,
        });

        await Promise.all([staleFlight, waitingRefresh]);
        expect(provider.listCalls).toHaveLength(3);
        expect(service.readHeartbeatProjection()).toMatchObject({ state: "fresh" });
    });

    test("invalidates TTL for pending, conflicting, absent, and expired state changes", async () => {
        {
            const { provider, service } = fixture();
            await service.refreshHeartbeatProjection();
            provider.updateError = new OpenClawCronProviderError("unavailable");
            await service.setEnabled(
                {
                    disableIntent: { reason: "Maintenance" },
                    enabled: false,
                    expectedConfigRevision: "revision-1",
                    id: "nightly-report",
                },
                operator
            );
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: "present",
                state: "last-known-good",
            });
            provider.updateError = undefined;
            await service.refreshHeartbeatProjection();
            expect(provider.listCalls).toHaveLength(2);
        }

        {
            const { intentStore, provider, service } = fixture();
            provider.currentJob = providerJob({ enabled: false });
            await intentStore.replaceActive({
                actor: operator,
                externalJobId: "nightly-report",
                reason: "Maintenance",
                recordedAtMs: 100,
            });
            await service.refreshHeartbeatProjection();
            provider.holdUpdateReadback = true;
            const failure = await captureFailure(() =>
                service.setEnabled(
                    {
                        disableIntent: null,
                        enabled: true,
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator
                )
            );
            expect(failure).toMatchObject({ reason: "conflict" });
            await service.refreshHeartbeatProjection();
            expect(provider.listCalls).toHaveLength(2);
        }

        {
            const { provider, service } = fixture();
            await service.refreshHeartbeatProjection();
            provider.currentJob = undefined;
            await service.delete(
                {
                    expectedConfigRevision: "revision-1",
                    id: "nightly-report",
                },
                operator
            );
            await service.refreshHeartbeatProjection();
            expect(provider.listCalls).toHaveLength(2);
            expect(service.readHeartbeatProjection()).toMatchObject({
                count: 0,
                state: "fresh",
            });
        }

        {
            let wallClockMs = 1000;
            const { intentStore, provider, service } = fixture(() => wallClockMs);
            await intentStore.replaceActive({
                actor: operator,
                expiresAtMs: 1500,
                externalJobId: "nightly-report",
                reason: "Short freeze",
                recordedAtMs: 500,
            });
            await service.refreshHeartbeatProjection();
            wallClockMs = 2000;
            await service.get({ id: "nightly-report" });
            expect(await intentStore.getActive("nightly-report")).toBeUndefined();
            await service.refreshHeartbeatProjection();
            expect(provider.listCalls).toHaveLength(2);
        }
    });

    test("enriches fresh and LKG provider pages from the exact open Dashboard task projection", async () => {
        const provider = new FakeProvider();
        const intentStore = createInMemoryOpenClawCronIntentStore();
        const calls: string[][] = [];
        let linked = true;
        const service = createOpenClawCronService({
            auditRequired: false,
            intentStore,
            linkedTaskReader: {
                listOpenLinkedTasks(cronJobIds) {
                    calls.push([...cronJobIds]);
                    return linked
                        ? [
                              {
                                  cronJobId: "nightly-report",
                                  task: {
                                      id: "019fd984-63e8-7404-a7da-80c6f243794f",
                                      status: "in-progress",
                                      title: "Ship nightly automation",
                                  },
                              },
                          ]
                        : [];
                },
            },
            provider,
        });

        const fresh = await service.list(inventoryInput());
        expect(fresh.jobs[0]?.dashboardOpenLinkedTask).toEqual({
            id: "019fd984-63e8-7404-a7da-80c6f243794f",
            status: "in-progress",
            title: "Ship nightly automation",
        });

        linked = false;
        provider.listError = new OpenClawCronProviderError("unavailable");
        const stale = await service.list(inventoryInput());
        expect(stale.freshness.kind).toBe("last-known-good");
        expect(stale.jobs[0]).not.toHaveProperty("dashboardOpenLinkedTask");
        expect(calls).toEqual([["nightly-report"], ["nightly-report"]]);
    });

    test("records disable intent, sends an exact enabled patch, and confirms readback", async () => {
        const { intentStore, provider, service } = fixture();
        const result = await service.setEnabled(
            {
                disableIntent: { expiresAtMs: 5000, reason: "Maintenance" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );

        expect(provider.updateCalls).toEqual([
            {
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
                patch: { enabled: false },
            },
        ]);
        expect(result.job).toMatchObject({
            enabled: false,
            synchronization: {
                desiredEnabled: false,
                disableIntent: { expiresAtMs: 5000, reason: "Maintenance" },
                state: "confirmed",
            },
        });
        expect(await intentStore.getActive("nightly-report")).toMatchObject({
            createdBy: operator,
            reason: "Maintenance",
        });
    });

    test("updates heartbeat scratch with its independent revision fence", async () => {
        const { provider, service } = fixture();
        provider.currentJob = providerJob({
            payload: { kind: "heartbeat" },
            scratch: { content: "Check services", revision: 4 },
        });

        const result = await service.update({
            expectedConfigRevision: "revision-1",
            expectedScratchRevision: 4,
            id: "nightly-report",
            patch: { scratch: "Check services and disk" },
        });

        expect(provider.setScratchCalls).toEqual([
            {
                content: "Check services and disk",
                expectedRevision: 4,
                id: "nightly-report",
            },
        ]);
        expect(provider.updateCalls).toHaveLength(0);
        expect(result.job.scratch).toEqual({
            content: "Check services and disk",
            revision: 5,
            truncated: false,
        });
    });

    test("preserves replacement and re-enable history instead of mutating intent rows", async () => {
        let nowMs = 1000;
        const { intentStore, provider, service } = fixture(() => nowMs);
        await service.setEnabled(
            {
                disableIntent: { reason: "First reason" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );

        nowMs = 2000;
        await service.setEnabled(
            {
                disableIntent: { reason: "Replacement reason" },
                enabled: false,
                expectedConfigRevision: "revision-2",
                id: "nightly-report",
            },
            operator
        );
        expect(intentStore.history("nightly-report")).toMatchObject([
            { closedReason: "replaced", reason: "First reason" },
            { reason: "Replacement reason" },
        ]);

        nowMs = 3000;
        const enabled = await service.setEnabled(
            {
                disableIntent: null,
                enabled: true,
                expectedConfigRevision: "revision-3",
                id: "nightly-report",
            },
            operator
        );
        expect(enabled.job).toMatchObject({
            enabled: true,
            synchronization: { state: "confirmed" },
        });
        expect(await intentStore.getActive("nightly-report")).toBeUndefined();
        expect(intentStore.history("nightly-report")).toMatchObject([
            { closedReason: "replaced", reason: "First reason" },
            { closedReason: "re-enabled", reason: "Replacement reason" },
        ]);
        expect(provider.currentJob?.enabled).toBeTrue();
    });

    test("closes a disable intent when conflict readback proves re-enable already settled", async () => {
        const { intentStore, provider, service } = fixture();
        await service.setEnabled(
            {
                disableIntent: { reason: "Maintenance" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        provider.updateErrorAppliesPatch = true;
        provider.updateError = new OpenClawCronProviderError("conflict");

        const result = await service.setEnabled(
            {
                disableIntent: null,
                enabled: true,
                expectedConfigRevision: "revision-2",
                id: "nightly-report",
            },
            operator
        );

        expect(result.job).toMatchObject({
            enabled: true,
            synchronization: { state: "confirmed" },
        });
        expect(await intentStore.getActive("nightly-report")).toBeUndefined();
        expect(intentStore.history("nightly-report")).toMatchObject([
            { closedReason: "re-enabled", reason: "Maintenance" },
        ]);
    });

    test("keeps a replacement intent open when a stale closure fence arrives", async () => {
        const { intentStore } = fixture();
        const first = await intentStore.replaceActive({
            actor: operator,
            externalJobId: "nightly-report",
            reason: "First reason",
            recordedAtMs: 100,
        });
        const replacement = await intentStore.replaceActive({
            actor: operator,
            externalJobId: "nightly-report",
            reason: "Replacement reason",
            recordedAtMs: 200,
        });

        const closed = await intentStore.closeActive({
            actor: operator,
            atMs: 300,
            expectedRevision: first.revision,
            externalJobId: "nightly-report",
            reason: "re-enabled",
        });

        expect(closed).toBeFalse();
        expect(await intentStore.getActive("nightly-report")).toEqual(replacement);
        expect(intentStore.history("nightly-report")).toMatchObject([
            { closedReason: "replaced", reason: "First reason" },
            { reason: "Replacement reason" },
        ]);
    });

    test("closes an expired intent only after authoritative upstream enable readback", async () => {
        let nowMs = 1000;
        const { intentStore, provider, service } = fixture(() => nowMs);
        await service.setEnabled(
            {
                disableIntent: { expiresAtMs: 2000, reason: "Short freeze" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        expect(intentStore.history("nightly-report")[0]).not.toHaveProperty(
            "closedReason"
        );

        nowMs = 2500;
        const reconciled = await service.reconcileExpired({ id: "nightly-report" });
        expect(reconciled.job).toMatchObject({
            enabled: true,
            synchronization: { state: "confirmed" },
        });
        expect(provider.currentJob?.enabled).toBeTrue();
        expect(await intentStore.getActive("nightly-report")).toBeUndefined();
        expect(intentStore.history("nightly-report")).toMatchObject([
            {
                closedBy: { id: "openclaw-cron-expiry", kind: "system" },
                closedReason: "expired",
            },
        ]);
    });

    test("audits automatic expiry reconciliation as a system mutation before dispatch", async () => {
        const provider = new FakeProvider();
        provider.currentJob = providerJob({ enabled: false });
        const intentStore = createInMemoryOpenClawCronIntentStore();
        await intentStore.replaceActive({
            actor: operator,
            expiresAtMs: 2000,
            externalJobId: "nightly-report",
            reason: "Short freeze",
            recordedAtMs: 1000,
        });
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    if (input.settlement === "attempted") {
                        expect(provider.updateCalls).toEqual([]);
                    }
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            clock: () => 2500,
            intentStore,
            provider,
        });

        const result = await service.reconcileExpired({ id: "nightly-report" });

        expect(result.job).toMatchObject({
            enabled: true,
            synchronization: { state: "confirmed" },
        });
        expect(
            auditEvents.map(({ actor, operation, settlement }) => ({
                actor,
                operation,
                settlement,
            }))
        ).toEqual([
            {
                actor: {
                    authenticatorId: null,
                    id: "openclaw-cron-expiry",
                    kind: "system",
                },
                operation: "reconcile-expired",
                settlement: "attempted",
            },
            {
                actor: {
                    authenticatorId: null,
                    id: "openclaw-cron-expiry",
                    kind: "system",
                },
                operation: "reconcile-expired",
                settlement: "succeeded",
            },
        ]);
    });

    test("keeps expired desired state pending after indeterminate reconciliation", async () => {
        const provider = new FakeProvider();
        provider.currentJob = providerJob({ enabled: false });
        provider.updateError = new OpenClawCronProviderError("unknown-outcome");
        const intentStore = createInMemoryOpenClawCronIntentStore();
        await intentStore.replaceActive({
            actor: operator,
            expiresAtMs: 2000,
            externalJobId: "nightly-report",
            reason: "Short freeze",
            recordedAtMs: 1000,
        });
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            clock: () => 2500,
            intentStore,
            provider,
        });
        await service.refreshHeartbeatProjection();

        expect(
            await captureFailure(() => service.reconcileExpired({ id: "nightly-report" }))
        ).toMatchObject({ reason: "unknown-outcome" });
        expect(await intentStore.getActive("nightly-report")).toMatchObject({
            reason: "Short freeze",
        });
        expect(service.readHeartbeatProjection()).toMatchObject({
            pendingSync: "present",
            state: "last-known-good",
        });
        expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "partial",
        ]);
    });

    test("returns pending LKG after an unavailable desired-state update", async () => {
        const { provider, service } = fixture();
        provider.updateError = new OpenClawCronProviderError("unavailable");
        const result = await service.setEnabled(
            {
                disableIntent: { reason: "Investigating" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        expect(result).toMatchObject({
            freshness: { kind: "last-known-good" },
            job: {
                enabled: true,
                synchronization: { desiredEnabled: false, state: "pending" },
            },
        });
        expect(service.readHeartbeatProjection()).toEqual({
            pendingSync: "present",
            state: "unavailable",
        });
    });

    test("settles abort after a new or replacement intent commit as pending without dispatch", async () => {
        for (const replacement of [false, true]) {
            const controller = new AbortController();
            const provider = new FakeProvider();
            const baseIntentStore = createInMemoryOpenClawCronIntentStore();
            const previous = replacement
                ? await baseIntentStore.replaceActive({
                      actor: operator,
                      externalJobId: "nightly-report",
                      reason: "Previous maintenance",
                      recordedAtMs: 500,
                  })
                : undefined;
            const intentStore: OpenClawCronIntentStore = {
                closeActive: (input) => baseIntentStore.closeActive(input),
                getActive: (id) => baseIntentStore.getActive(id),
                listExpired: (atMs, limit) => baseIntentStore.listExpired(atMs, limit),
                replaceActive: async (input) => {
                    const stored = await baseIntentStore.replaceActive(input);
                    controller.abort();
                    return stored;
                },
            };
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                clock: () => 1000,
                intentStore,
                provider,
            });
            await service.refreshHeartbeatProjection();

            const result = await service.setEnabled(
                {
                    disableIntent: { reason: "New maintenance" },
                    enabled: false,
                    expectedConfigRevision: "revision-1",
                    id: "nightly-report",
                },
                operator,
                controller.signal,
                auditContext
            );

            expect(result).toMatchObject({
                freshness: { kind: "last-known-good" },
                job: {
                    enabled: true,
                    synchronization: { desiredEnabled: false, state: "pending" },
                },
            });
            const active = await baseIntentStore.getActive("nightly-report");
            expect(active?.reason).toBe("New maintenance");
            expect(active?.revision).not.toBe(previous?.revision);
            expect(provider.updateCalls).toEqual([]);
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: "present",
                state: "last-known-good",
            });
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "partial",
            ]);
        }
    });

    test("keeps a new or replacement intent pending after definitive provider validation failure", async () => {
        for (const replacement of [false, true]) {
            const provider = new FakeProvider();
            provider.updateError = new OpenClawCronProviderError("invalid-data");
            const intentStore = createInMemoryOpenClawCronIntentStore();
            const previous = replacement
                ? await intentStore.replaceActive({
                      actor: operator,
                      externalJobId: "nightly-report",
                      reason: "Previous maintenance",
                      recordedAtMs: 500,
                  })
                : undefined;
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                clock: () => 1000,
                intentStore,
                provider,
            });
            await service.refreshHeartbeatProjection();

            const result = await service.setEnabled(
                {
                    disableIntent: { reason: "New maintenance" },
                    enabled: false,
                    expectedConfigRevision: "revision-1",
                    id: "nightly-report",
                },
                operator,
                undefined,
                auditContext
            );

            expect(result).toMatchObject({
                freshness: { kind: "last-known-good" },
                job: { synchronization: { desiredEnabled: false, state: "pending" } },
            });
            const active = await intentStore.getActive("nightly-report");
            expect(active?.reason).toBe("New maintenance");
            expect(active?.revision).not.toBe(previous?.revision);
            expect(provider.updateCalls).toHaveLength(1);
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: "present",
                state: "last-known-good",
            });
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "partial",
            ]);
        }
    });

    test("rejects provider ids outside the persisted external-id boundary", async () => {
        const { provider, service } = fixture();
        provider.currentJob = providerJob({ id: "x".repeat(257) });
        try {
            await service.list(inventoryInput());
            throw new Error("Expected the overlong provider id to fail");
        } catch (error) {
            expect(error).toMatchObject({ reason: "provider-data-invalid" });
        }
    });

    test("keeps an acknowledged disable mismatch pending instead of claiming success", async () => {
        const { provider, service } = fixture();
        provider.holdUpdateReadback = true;
        const result = await service.setEnabled(
            {
                disableIntent: { reason: "Investigating" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        expect(result.job.synchronization).toMatchObject({
            desiredEnabled: false,
            state: "pending",
        });
    });

    test("fails an acknowledged enable mismatch without a prior disable intent", async () => {
        const provider = new FakeProvider();
        provider.currentJob = providerJob({ enabled: false });
        provider.holdUpdateReadback = true;
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });

        expect(
            await captureFailure(() =>
                service.setEnabled(
                    {
                        disableIntent: null,
                        enabled: true,
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    undefined,
                    auditContext
                )
            )
        ).toMatchObject({ reason: "conflict" });
        expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "failed",
        ]);
    });

    test("marks an indeterminate enable pending only when a prior disable intent exists", async () => {
        for (const withPriorIntent of [false, true]) {
            const provider = new FakeProvider();
            provider.currentJob = providerJob({ enabled: false });
            provider.updateError = new OpenClawCronProviderError("unknown-outcome");
            const intentStore = createInMemoryOpenClawCronIntentStore();
            if (withPriorIntent) {
                await intentStore.replaceActive({
                    actor: operator,
                    externalJobId: "nightly-report",
                    reason: "Maintenance",
                    recordedAtMs: 500,
                });
            }
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                clock: () => 1000,
                intentStore,
                provider,
            });
            await service.refreshHeartbeatProjection();

            expect(
                await captureFailure(() =>
                    service.setEnabled(
                        {
                            disableIntent: null,
                            enabled: true,
                            expectedConfigRevision: "revision-1",
                            id: "nightly-report",
                        },
                        operator,
                        undefined,
                        auditContext
                    )
                )
            ).toMatchObject({ reason: "unknown-outcome" });
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: withPriorIntent ? "present" : "none",
                state: "last-known-good",
            });
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "partial",
            ]);
        }
    });

    test("maps only reviewed update fields and returns authoritative readback", async () => {
        const { provider, service } = fixture();
        const result = await service.update({
            expectedConfigRevision: "revision-1",
            id: "nightly-report",
            patch: {
                delivery: {
                    accountId: null,
                    bestEffort: false,
                    channel: null,
                    completionDestination: null,
                    failureDestination: {
                        accountId: null,
                        channel: null,
                        mode: null,
                        to: null,
                    },
                    mode: "announce",
                    threadId: null,
                    to: null,
                },
                description: null,
                name: "Morning report",
                payload: {
                    kind: "agent-turn",
                    message: "Produce the report.",
                    model: null,
                    timeoutSeconds: 60,
                },
                schedule: { everyMs: 60_000, kind: "every" },
                wakeMode: "next-heartbeat",
            },
        });
        expect(provider.updateCalls[0]?.patch).toEqual({
            delivery: {
                accountId: null,
                bestEffort: false,
                channel: null,
                completionDestination: null,
                failureDestination: {
                    accountId: null,
                    channel: null,
                    mode: null,
                    to: null,
                },
                mode: "announce",
                threadId: null,
                to: null,
            },
            description: null,
            name: "Morning report",
            payload: {
                kind: "agentTurn",
                message: "Produce the report.",
                model: null,
                timeoutSeconds: 60,
            },
            schedule: { everyMs: 60_000, kind: "every" },
            wakeMode: "next-heartbeat",
        });
        expect(result.job).toMatchObject({
            name: "Morning report",
            schedule: { everyMs: 60_000, kind: "every" },
        });
    });

    test("settles an acknowledged update with failed readback as partial", async () => {
        const provider = new FakeProvider();
        const originalGet = provider.get.bind(provider);
        provider.get = (input) =>
            provider.updateCalls.length === 0
                ? originalGet(input)
                : Promise.reject(new OpenClawCronProviderError("unavailable"));
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            intentStore: createInMemoryOpenClawCronIntentStore(),
            provider,
        });
        await service.refreshHeartbeatProjection();

        expect(
            await captureFailure(() =>
                service.update(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                        patch: { name: "Morning report" },
                    },
                    undefined,
                    auditContext
                )
            )
        ).toMatchObject({ reason: "unknown-outcome" });
        expect(provider.currentJob?.name).toBe("Morning report");
        expect(service.readHeartbeatProjection()).toMatchObject({
            pendingSync: "none",
            state: "last-known-good",
        });
        expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "partial",
        ]);
    });

    test("demotes fresh inventory after indeterminate update and run dispatch", async () => {
        for (const operation of ["update", "run"] as const) {
            const provider = new FakeProvider();
            const controller = new AbortController();
            if (operation === "update") {
                provider.updateError = new OpenClawCronProviderError("unknown-outcome");
            } else {
                provider.run = (input) => {
                    provider.runCalls.push(input);
                    controller.abort();
                    return Promise.reject(
                        new OpenClawCronProviderError("unknown-outcome")
                    );
                };
            }
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                clock: () => 1000,
                intentStore: createInMemoryOpenClawCronIntentStore(),
                provider,
            });
            await service.refreshHeartbeatProjection();
            await service.list(inventoryInput());

            const work =
                operation === "update"
                    ? () =>
                          service.update(
                              {
                                  expectedConfigRevision: "revision-1",
                                  id: "nightly-report",
                                  patch: { name: "Morning report" },
                              },
                              undefined,
                              auditContext
                          )
                    : () =>
                          service.run(
                              { id: "nightly-report" },
                              controller.signal,
                              auditContext
                          );

            expect(await captureFailure(work)).toMatchObject({
                reason: "unknown-outcome",
            });
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: "none",
                state: "last-known-good",
            });
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "partial",
            ]);

            provider.listError = new OpenClawCronProviderError("unavailable");
            expect(await service.list(inventoryInput())).toMatchObject({
                freshness: { kind: "last-known-good" },
            });
        }
    });

    test("process-fences manual runs and bounds run history without raw errors", async () => {
        const { provider, service } = fixture();
        const run = await service.run({ id: "nightly-report" });
        expect(provider.runCalls).toEqual([
            {
                expectedProcessInstanceId: "gateway-process-1",
                id: "nightly-report",
                mode: "force",
            },
        ]);
        expect(run.outcome).toBe("accepted");

        const history = await service.listRuns({
            id: "nightly-report",
            limit: 50,
            offset: 0,
            sortDir: "desc",
        });
        expect(history.runs[0]).toMatchObject({
            deliveryStatus: "delivered",
            errorReason: "timeout",
            modelTruncated: true,
            providerTruncated: true,
            status: "error",
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        });
        expect(history.runs[0]?.summary).toHaveLength(4000);
        expect(history.runs[0]?.model).toHaveLength(256);
        expect(history.runs[0]?.provider).toHaveLength(128);
        expect(history.runs[0]?.summaryTruncated).toBeTrue();
        expect(history.runs[0]).not.toHaveProperty("error");
    });

    test("keeps accepted run truth when detail refresh and later intent reads fail", async () => {
        const provider = new FakeProvider();
        const originalGet = provider.get.bind(provider);
        provider.get = (input) =>
            provider.runCalls.length === 0
                ? originalGet(input)
                : Promise.reject(new OpenClawCronProviderError("unavailable"));
        const baseIntentStore = createInMemoryOpenClawCronIntentStore();
        await baseIntentStore.replaceActive({
            actor: operator,
            externalJobId: "nightly-report",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        let intentReads = 0;
        const intentStore = {
            ...baseIntentStore,
            getActive(externalJobId: string) {
                intentReads += 1;
                return intentReads === 1
                    ? baseIntentStore.getActive(externalJobId)
                    : Promise.reject(new Error("late local database failure"));
            },
        };
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            clock: () => 1000,
            intentStore,
            provider,
        });

        const result = await service.run(
            { id: "nightly-report" },
            undefined,
            auditContext
        );

        expect(result).toMatchObject({
            job: {
                synchronization: { desiredEnabled: false, state: "pending" },
            },
            outcome: "accepted",
        });
        expect(intentReads).toBe(1);
        expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "succeeded",
        ]);
    });

    test("confirms authoritative absence before completing deletion", async () => {
        const { intentStore, provider, service } = fixture();
        await intentStore.replaceActive({
            actor: operator,
            externalJobId: "nightly-report",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        const deleted = await service.delete(
            {
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        expect(deleted).toEqual({
            deleted: true,
            id: "nightly-report",
            observedAtMs: 1000,
        });
        expect(provider.currentJob).toBeUndefined();
        expect(await intentStore.getActive("nightly-report")).toBeUndefined();
        expect(intentStore.history("nightly-report")).toMatchObject([
            { closedReason: "target-deleted", reason: "Maintenance" },
        ]);
    });

    test("resolves a concurrent remove rejection through authoritative absence", async () => {
        const { provider, service } = fixture();
        provider.removeDeletesBeforeError = true;
        provider.removeError = new OpenClawCronProviderError("not-found");
        const deleted = await service.delete(
            {
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator
        );
        expect(deleted.deleted).toBeTrue();
        expect(provider.currentJob).toBeUndefined();
        expect(provider.getCalls).toHaveLength(2);
    });

    test("keeps active intent visible after an indeterminate delete", async () => {
        const provider = new FakeProvider();
        provider.removeError = new OpenClawCronProviderError("unknown-outcome");
        const intentStore = createInMemoryOpenClawCronIntentStore();
        await intentStore.replaceActive({
            actor: operator,
            externalJobId: "nightly-report",
            reason: "Maintenance",
            recordedAtMs: 500,
        });
        const auditEvents: OpenClawCronOperationAuditInput[] = [];
        const service = createOpenClawCronService({
            auditWriter: {
                record(input) {
                    auditEvents.push(input);
                    return Promise.resolve();
                },
            },
            clock: () => 1000,
            intentStore,
            provider,
        });
        await service.refreshHeartbeatProjection();

        expect(
            await captureFailure(() =>
                service.delete(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    undefined,
                    auditContext
                )
            )
        ).toMatchObject({ reason: "unknown-outcome" });
        expect(await intentStore.getActive("nightly-report")).toMatchObject({
            reason: "Maintenance",
        });
        expect(service.readHeartbeatProjection()).toMatchObject({
            pendingSync: "present",
            state: "last-known-good",
        });
        expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "partial",
        ]);
    });

    test("demotes heartbeat when confirmed enable or delete cannot close local intent", async () => {
        for (const operation of ["enable", "delete"] as const) {
            const provider = new FakeProvider();
            if (operation === "enable") {
                provider.currentJob = providerJob({ enabled: false });
            }
            const baseIntentStore = createInMemoryOpenClawCronIntentStore();
            await baseIntentStore.replaceActive({
                actor: operator,
                externalJobId: "nightly-report",
                reason: "Maintenance",
                recordedAtMs: 500,
            });
            const intentStore: OpenClawCronIntentStore = {
                closeActive: (input) =>
                    input.reason ===
                    (operation === "enable" ? "re-enabled" : "target-deleted")
                        ? Promise.reject(new Error("Local settlement unavailable"))
                        : baseIntentStore.closeActive(input),
                getActive: (id) => baseIntentStore.getActive(id),
                listExpired: (atMs, limit) => baseIntentStore.listExpired(atMs, limit),
                replaceActive: (input) => baseIntentStore.replaceActive(input),
            };
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                clock: () => 1000,
                intentStore,
                provider,
            });
            await service.refreshHeartbeatProjection();

            const work =
                operation === "enable"
                    ? () =>
                          service.setEnabled(
                              {
                                  disableIntent: null,
                                  enabled: true,
                                  expectedConfigRevision: "revision-1",
                                  id: "nightly-report",
                              },
                              operator,
                              undefined,
                              auditContext
                          )
                    : () =>
                          service.delete(
                              {
                                  expectedConfigRevision: "revision-1",
                                  id: "nightly-report",
                              },
                              operator,
                              undefined,
                              auditContext
                          );

            expect(await captureFailure(work)).toMatchObject({
                reason: "unknown-outcome",
            });
            expect(service.readHeartbeatProjection()).toMatchObject({
                pendingSync: "present",
                state: "last-known-good",
            });
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "partial",
            ]);
        }
    });

    test("fails closed on stale configuration revisions", async () => {
        const { provider, service } = fixture();
        try {
            await service.update({
                expectedConfigRevision: "stale-revision",
                id: "nightly-report",
                patch: { name: "Wrong" },
            });
            throw new Error("Expected the stale revision to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(OpenClawCronServiceError);
        }
        expect(provider.updateCalls).toHaveLength(0);
    });

    test("finishes confirmed update, toggle, and delete reconciliation after late abort", async () => {
        for (const operation of ["update", "set-enabled", "delete"] as const) {
            const controller = new AbortController();
            const provider = new FakeProvider();
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            if (operation === "delete") {
                provider.onRemoveAcknowledged = () => controller.abort();
            } else {
                provider.onUpdateAcknowledged = () => controller.abort();
            }
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                intentStore: createInMemoryOpenClawCronIntentStore(),
                provider,
            });

            if (operation === "update") {
                const result = await service.update(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                        patch: { name: "Morning report" },
                    },
                    controller.signal,
                    auditContext
                );
                expect(result.job.name).toBe("Morning report");
            } else if (operation === "set-enabled") {
                const result = await service.setEnabled(
                    {
                        disableIntent: { reason: "Maintenance" },
                        enabled: false,
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    controller.signal,
                    auditContext
                );
                expect(result.job).toMatchObject({
                    enabled: false,
                    synchronization: { desiredEnabled: false, state: "confirmed" },
                });
            } else {
                const result = await service.delete(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    controller.signal,
                    auditContext
                );
                expect(result.deleted).toBeTrue();
            }
            expect(controller.signal.aborted).toBeTrue();
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "succeeded",
            ]);
        }
    });

    test("does not dispatch an already-aborted control", async () => {
        for (const operation of ["update", "set-enabled", "delete"] as const) {
            const controller = new AbortController();
            controller.abort();
            const provider = new FakeProvider();
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                intentStore: createInMemoryOpenClawCronIntentStore(),
                provider,
            });
            const work = () => {
                if (operation === "update") {
                    return service.update(
                        {
                            expectedConfigRevision: "revision-1",
                            id: "nightly-report",
                            patch: { name: "Morning report" },
                        },
                        controller.signal,
                        auditContext
                    );
                }
                if (operation === "set-enabled") {
                    return service.setEnabled(
                        {
                            disableIntent: { reason: "Maintenance" },
                            enabled: false,
                            expectedConfigRevision: "revision-1",
                            id: "nightly-report",
                        },
                        operator,
                        controller.signal,
                        auditContext
                    );
                }
                return service.delete(
                    {
                        expectedConfigRevision: "revision-1",
                        id: "nightly-report",
                    },
                    operator,
                    controller.signal,
                    auditContext
                );
            };

            expect(await captureFailure(work)).toBe(controller.signal.reason);
            expect(provider.getCalls).toEqual([]);
            expect(provider.updateCalls).toEqual([]);
            expect(provider.removeCalls).toEqual([]);
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "failed",
            ]);
        }
    });

    test("does not let abort before or after confirmed intent closure mask re-enable", async () => {
        for (const abortAt of ["before-close", "after-close"] as const) {
            const controller = new AbortController();
            const provider = new FakeProvider();
            provider.currentJob = providerJob({ enabled: false });
            const baseIntentStore = createInMemoryOpenClawCronIntentStore();
            await baseIntentStore.replaceActive({
                actor: operator,
                externalJobId: "nightly-report",
                reason: "Maintenance",
                recordedAtMs: 100,
            });
            const intentStore: OpenClawCronIntentStore = {
                closeActive: async (input) => {
                    if (abortAt === "before-close") controller.abort();
                    const closed = await baseIntentStore.closeActive(input);
                    if (abortAt === "after-close") controller.abort();
                    return closed;
                },
                getActive: (id) => baseIntentStore.getActive(id),
                listExpired: (atMs, limit) => baseIntentStore.listExpired(atMs, limit),
                replaceActive: (input) => baseIntentStore.replaceActive(input),
            };
            const auditEvents: OpenClawCronOperationAuditInput[] = [];
            const service = createOpenClawCronService({
                auditWriter: {
                    record(input) {
                        auditEvents.push(input);
                        return Promise.resolve();
                    },
                },
                intentStore,
                provider,
            });

            const result = await service.setEnabled(
                {
                    disableIntent: null,
                    enabled: true,
                    expectedConfigRevision: "revision-1",
                    id: "nightly-report",
                },
                operator,
                controller.signal,
                auditContext
            );

            expect(result.job).toMatchObject({
                enabled: true,
                synchronization: { state: "confirmed" },
            });
            expect(await baseIntentStore.getActive("nightly-report")).toBeUndefined();
            expect(auditEvents.map(({ settlement }) => settlement)).toEqual([
                "attempted",
                "succeeded",
            ]);
        }
    });

    test("forwards request cancellation to every Gateway provider operation", async () => {
        const controller = new AbortController();
        const signal = controller.signal;
        const first = fixture();
        await first.service.list(inventoryInput(), signal);
        await first.service.listRuns(
            { id: "nightly-report", limit: 50, offset: 0, sortDir: "desc" },
            signal
        );
        await first.service.run({ id: "nightly-report" }, signal);
        expect(first.provider.listCalls[0]?.signal).toBe(signal);
        expect(first.provider.listRunsCalls[0]?.signal).toBe(signal);
        expect(first.provider.runCalls[0]?.signal).toBe(signal);
        expect(first.provider.getCalls.map((call) => call.signal)).toEqual([
            signal,
            undefined,
        ]);

        const second = fixture();
        await second.service.setEnabled(
            {
                disableIntent: { reason: "Signal test" },
                enabled: false,
                expectedConfigRevision: "revision-1",
                id: "nightly-report",
            },
            operator,
            signal
        );
        await second.service.update(
            {
                expectedConfigRevision: "revision-2",
                id: "nightly-report",
                patch: { name: "Signal report" },
            },
            signal
        );
        await second.service.delete(
            {
                expectedConfigRevision: "revision-3",
                id: "nightly-report",
            },
            operator,
            signal
        );
        expect(
            second.provider.updateCalls.every((call) => call.signal === signal)
        ).toBeTrue();
        expect(second.provider.removeCalls).toEqual([{ id: "nightly-report", signal }]);
        expect(second.provider.getCalls.map((call) => call.signal)).toEqual([
            signal,
            undefined,
            signal,
            undefined,
            signal,
            undefined,
        ]);
    });
});
