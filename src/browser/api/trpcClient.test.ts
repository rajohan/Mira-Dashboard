import { describe, expect, test } from "bun:test";

import { createSecurityVerificationCoordinator } from "../security/securityVerificationCoordinator.ts";
import {
    createDashboardTrpcClient,
    DashboardProtocolError,
    type DashboardTrpcTransport,
} from "./trpcClient.ts";

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

function createRecordingTransport(
    output: unknown,
    calls: TransportCall[]
): DashboardTrpcTransport {
    return {
        mutation(path, input) {
            calls.push({ input, kind: "mutation", path });
            return Promise.resolve(output);
        },
        query(path, input) {
            calls.push({ input, kind: "query", path });
            return Promise.resolve(output);
        },
    };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error: unknown) {
        return error;
    }
    throw new TypeError("Expected promise to reject");
}

describe("Dashboard browser tRPC client", () => {
    test("validates an exact registered query at both contract boundaries", async () => {
        const calls: TransportCall[] = [];
        const client = createDashboardTrpcClient(
            createRecordingTransport({ state: "anonymous" }, calls)
        );

        expect(await client.query("auth.status", {})).toEqual({
            state: "anonymous",
        });
        expect(calls).toEqual([{ input: {}, kind: "query", path: "auth.status" }]);
    });

    test("sends security mutations individually without a batch path", async () => {
        const calls: TransportCall[] = [];
        const client = createDashboardTrpcClient(
            createRecordingTransport({ isOk: true }, calls)
        );

        expect(await client.mutation("auth.logout", {})).toEqual({
            isOk: true,
        });
        expect(calls).toEqual([{ input: {}, kind: "mutation", path: "auth.logout" }]);
    });

    test("loads monitoring reader contracts on demand", async () => {
        const reportCalls: TransportCall[] = [];
        const incidentCalls: TransportCall[] = [];
        const notificationCalls: TransportCall[] = [];
        const reportClient = createDashboardTrpcClient(
            createRecordingTransport({ reports: [] }, reportCalls)
        );
        const incidentClient = createDashboardTrpcClient(
            createRecordingTransport({ incidents: [] }, incidentCalls)
        );
        const notificationClient = createDashboardTrpcClient(
            createRecordingTransport(
                { notifications: [], readCount: 0, unreadCount: 0 },
                notificationCalls
            )
        );

        expect(await reportClient.query("reports.list", { limit: 50 })).toEqual({
            reports: [],
        });
        expect(await incidentClient.query("incidents.list", { limit: 50 })).toEqual({
            incidents: [],
        });
        expect(
            await notificationClient.query("notifications.list", { limit: 100 })
        ).toEqual({ notifications: [], readCount: 0, unreadCount: 0 });
        expect(reportCalls).toEqual([
            { input: { limit: 50 }, kind: "query", path: "reports.list" },
        ]);
        expect(incidentCalls).toEqual([
            { input: { limit: 50 }, kind: "query", path: "incidents.list" },
        ]);
        expect(notificationCalls).toEqual([
            { input: { limit: 100 }, kind: "query", path: "notifications.list" },
        ]);
    });

    test("loads durable job and schedule contracts on demand", async () => {
        const jobCalls: TransportCall[] = [];
        const scheduleCalls: TransportCall[] = [];
        const jobClient = createDashboardTrpcClient(
            createRecordingTransport(
                {
                    runs: [],
                    summary: {
                        activeResourceClasses: [],
                        control: {
                            claimingPaused: false,
                            updatedAtMs: 0,
                            version: 1,
                        },
                        stateCounts: {
                            cancelled: 0,
                            failed: 0,
                            queued: 0,
                            running: 0,
                            succeeded: 0,
                            "timed-out": 0,
                        },
                        workers: [],
                    },
                },
                jobCalls
            )
        );
        const scheduleClient = createDashboardTrpcClient(
            createRecordingTransport({ schedules: [] }, scheduleCalls)
        );

        expect(await jobClient.query("jobs.listRuns", { limit: 50 })).toEqual({
            runs: [],
            summary: {
                activeResourceClasses: [],
                control: {
                    claimingPaused: false,
                    updatedAtMs: 0,
                    version: 1,
                },
                stateCounts: {
                    cancelled: 0,
                    failed: 0,
                    queued: 0,
                    running: 0,
                    succeeded: 0,
                    "timed-out": 0,
                },
                workers: [],
            },
        });
        expect(
            await scheduleClient.query("schedules.list", {
                enabled: "all",
                limit: 50,
            })
        ).toEqual({ schedules: [] });
        expect(jobCalls).toEqual([
            { input: { limit: 50 }, kind: "query", path: "jobs.listRuns" },
        ]);
        expect(scheduleCalls).toEqual([
            {
                input: { enabled: "all", limit: 50 },
                kind: "query",
                path: "schedules.list",
            },
        ]);
    });

    test("requests global verification for a contract-declared conditional step-up", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        const transport: DashboardTrpcTransport = {
            mutation: () =>
                Promise.reject(
                    Object.assign(new Error("Step-up required"), {
                        data: { code: "FORBIDDEN", reason: "step_up_required" },
                    })
                ),
            query: () => Promise.reject(new Error("Unexpected query")),
        };
        const client = createDashboardTrpcClient(transport, {
            securityVerification: coordinator,
        });
        const pending = client.mutation("schedules.run", {
            id: "system.worker-smoke",
            idempotencyKey: "A".repeat(32),
        });

        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (coordinator.getSnapshot().phase !== "idle") break;
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        expect(coordinator.getSnapshot()).toMatchObject({
            phase: "prompting",
            reason: "step_up_required",
        });
        coordinator.dismiss();
        expect(pending).rejects.toThrow("Security verification was cancelled");
    });

    test("replays the exact protected mutation after successful global verification", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        const calls: TransportCall[] = [];
        const input = {
            id: "system.worker-smoke",
            idempotencyKey: "A".repeat(32),
        };
        const output = {
            actionKey: "system.worker-smoke",
            attemptCount: 0,
            attemptLimit: 3,
            availableAtMs: 1000,
            cancellationPolicy: "cooperative",
            displayName: "Worker smoke manual run",
            eventCount: 1,
            id: "019fdf90-0000-7000-8000-000000000004",
            priority: 0,
            queuedAtMs: 1000,
            resourceClass: "light",
            resourceKeys: [],
            retrySafe: true,
            scheduledJobId: "system.worker-smoke",
            scheduledJobVersion: 1,
            state: "queued",
            stateVersion: 1,
            timeoutMs: 60_000,
            triggerType: "manual",
            updatedAtMs: 1000,
        } as const;
        const transport: DashboardTrpcTransport = {
            mutation(path, mutationInput) {
                calls.push({ input: mutationInput, kind: "mutation", path });
                return calls.length === 1
                    ? Promise.reject(
                          Object.assign(new Error("Step-up required"), {
                              data: {
                                  code: "FORBIDDEN",
                                  reason: "step_up_required",
                              },
                          })
                      )
                    : Promise.resolve(output);
            },
            query: () => Promise.reject(new Error("Unexpected query")),
        };
        const client = createDashboardTrpcClient(transport, {
            securityVerification: coordinator,
        });
        const pending = client.mutation("schedules.run", input);

        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (coordinator.getSnapshot().phase !== "idle") break;
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        expect(coordinator.beginProof()).toBeTrue();
        const replay = coordinator.completeProof();

        expect(await pending).toEqual(output);
        expect(await replay).toBeTrue();
        expect(calls).toEqual([
            { input, kind: "mutation", path: "schedules.run" },
            { input, kind: "mutation", path: "schedules.run" },
        ]);
        coordinator.abortActiveFlow();
    });

    test("loads cache contracts on demand", async () => {
        const calls: TransportCall[] = [];
        const client = createDashboardTrpcClient(
            createRecordingTransport(
                {
                    entries: [],
                    generatedAtMs: 0,
                    totalCount: 0,
                    truncated: false,
                },
                calls
            )
        );

        expect(await client.query("cache.getStatus", {})).toEqual({
            entries: [],
            generatedAtMs: 0,
            totalCount: 0,
            truncated: false,
        });
        expect(calls).toEqual([{ input: {}, kind: "query", path: "cache.getStatus" }]);
    });

    test("loads the Gateway connection contract on demand", async () => {
        const calls: TransportCall[] = [];
        const output = {
            checkedAtMs: 1000,
            connectionGeneration: 0,
            freshness: "unavailable",
            phase: "stopped",
            reconnectAttempt: 0,
        } as const;
        const client = createDashboardTrpcClient(createRecordingTransport(output, calls));

        expect(await client.query("gateway.connection.get", {})).toEqual(output);
        expect(calls).toEqual([
            { input: {}, kind: "query", path: "gateway.connection.get" },
        ]);
    });

    test("loads Chat and OpenClaw task contracts on demand", async () => {
        const chatCalls: TransportCall[] = [];
        const taskCalls: TransportCall[] = [];
        const chatClient = createDashboardTrpcClient(
            createRecordingTransport({ models: [] }, chatCalls)
        );
        const taskClient = createDashboardTrpcClient(
            createRecordingTransport({ tasks: [] }, taskCalls)
        );

        expect(await chatClient.query("chat.listModels", { agentId: "main" })).toEqual({
            models: [],
        });
        expect(await taskClient.query("openClawTasks.list", { limit: 100 })).toEqual({
            tasks: [],
        });
        expect(chatCalls).toEqual([
            { input: { agentId: "main" }, kind: "query", path: "chat.listModels" },
        ]);
        expect(taskCalls).toEqual([
            { input: { limit: 100 }, kind: "query", path: "openClawTasks.list" },
        ]);
    });

    test("loads workspace operation contracts on demand", async () => {
        const filesCalls: TransportCall[] = [];
        const logsCalls: TransportCall[] = [];
        const terminalCalls: TransportCall[] = [];
        const filesOutput = {
            roots: [
                {
                    id: "workspace",
                    label: "Workspace",
                    resourceId: "00000000-0000-4000-8000-000000000001",
                    writable: true,
                },
            ],
        } as const;
        const logsOutput = { observedAtMs: 0, sources: [] } as const;
        const terminalOutput = {
            clientMessageMaximumBytes: 16 * 1024,
            defaultLocation: { path: "/", rootId: "workspace" },
            idleTimeoutMs: 30 * 60 * 1000,
            mode: "pty",
            outputReplayMaximumBytes: 256 * 1024,
            reconnectGraceMs: 15 * 1000,
            roots: [{ defaultPath: "/", id: "workspace", label: "Workspace" }],
            serverMessageMaximumBytes: 32 * 1024,
            sessionMaximumDurationMs: 8 * 60 * 60 * 1000,
            supportsInput: true,
            supportsPty: true,
            supportsResize: true,
            supportsSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
            webSocketProtocol: "mira-terminal-v1",
        } as const;
        const filesClient = createDashboardTrpcClient(
            createRecordingTransport(filesOutput, filesCalls)
        );
        const logsClient = createDashboardTrpcClient(
            createRecordingTransport(logsOutput, logsCalls)
        );
        const terminalClient = createDashboardTrpcClient(
            createRecordingTransport(terminalOutput, terminalCalls)
        );

        expect(await filesClient.query("files.listRoots", {})).toEqual(filesOutput);
        expect(await logsClient.query("logs.listSources", {})).toEqual(logsOutput);
        expect(await terminalClient.query("terminal.getRuntime", {})).toEqual(
            terminalOutput
        );
        expect(filesCalls).toEqual([
            { input: {}, kind: "query", path: "files.listRoots" },
        ]);
        expect(logsCalls).toEqual([
            { input: {}, kind: "query", path: "logs.listSources" },
        ]);
        expect(terminalCalls).toEqual([
            { input: {}, kind: "query", path: "terminal.getRuntime" },
        ]);
    });

    test("rejects invalid input before transport access", async () => {
        const calls: TransportCall[] = [];
        const client = createDashboardTrpcClient(
            createRecordingTransport({ status: "authenticated" }, calls)
        );

        expect(
            await rejectionOf(
                client.mutation("auth.login", {
                    password: "short",
                    username: "x",
                })
            )
        ).toBeInstanceOf(DashboardProtocolError);
        expect(calls).toEqual([]);
    });

    test("redacts a response contract violation", async () => {
        const privateSentinel = "private-response-sentinel";
        const client = createDashboardTrpcClient(
            createRecordingTransport({ privateSentinel, state: "not-a-real-state" }, [])
        );

        const rejection = await rejectionOf(client.query("auth.status", {}));
        expect(rejection).toBeInstanceOf(DashboardProtocolError);
        expect(String(rejection)).not.toContain(privateSentinel);
    });
});
