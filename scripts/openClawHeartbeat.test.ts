import { describe, expect, test } from "bun:test";

import {
    openClawHeartbeatAutomationProfile,
    runOpenClawHeartbeatCommand,
} from "./openClawHeartbeat.ts";

const token = `${"a".repeat(32)}.${"b".repeat(64)}`;
const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";

const heartbeat = Object.freeze({
    cache: {
        entries: [],
        generatedAtMs: 2000,
        totalCount: 0,
        truncated: false,
    },
    dashboardJobs: { items: [], state: "available" as const },
    gateway: {
        connection: {
            checkedAtMs: 2000,
            freshness: "fresh" as const,
            phase: "connected" as const,
        },
        sessions: {
            count: 0,
            observedAtMs: 2000,
            state: "fresh" as const,
            truncated: false,
        },
    },
    generatedAtMs: 2000,
    openClawCron: {
        count: 0,
        health: {
            disabledCount: 0,
            enabledCount: 0,
            inspectedCount: 0,
            intendedDisabledCount: 0,
            lastRunErrorCount: 0,
            runningCount: 0,
            staleRunningCount: 0,
            synchronizationConflictCount: 0,
            synchronizationPendingCount: 0,
            truncated: false,
            unexpectedDisabledCount: 0,
        },
        observedAtMs: 2000,
        pendingSync: "none" as const,
        state: "fresh" as const,
    },
    operationalSignals: {
        backups: {
            kopia: {
                condition: "healthy" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
            walg: {
                condition: "healthy" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
        },
        database: {
            postgresqlMaintenance: {
                condition: "healthy" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
            sqliteMaintenance: {
                condition: "healthy" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
        },
        docker: {
            health: {
                condition: "healthy" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
            updates: {
                condition: "current" as const,
                observedAtMs: 2000,
                state: "fresh" as const,
            },
        },
        git: { condition: "clean" as const, observedAtMs: 2000, state: "fresh" as const },
        hostCapacity: {
            condition: "healthy" as const,
            observedAtMs: 2000,
            state: "fresh" as const,
        },
        logs: {
            condition: "healthy" as const,
            observedAtMs: 2000,
            state: "fresh" as const,
        },
        quota: {
            condition: "healthy" as const,
            observedAtMs: 2000,
            state: "fresh" as const,
        },
        weather: {
            condition: "available" as const,
            observedAtMs: 2000,
            state: "fresh" as const,
        },
    },
    schemaVersion: 5 as const,
    tasks: {
        items: [],
        state: "available" as const,
        totalCount: 0,
        truncated: false,
    },
});

const snapshot = Object.freeze({
    completedAtMs: 3000,
    monitorKey: "openclaw-heartbeat",
    problems: [],
    report: {
        bodyMarkdown: "HEARTBEAT_OK",
        kind: "heartbeat",
        metadata: {},
        source: "openclaw",
        sourceJobId: "ops-check",
        summary: "HEARTBEAT_OK",
        title: "HEARTBEAT_OK",
    },
    runId,
    startedAtMs: 2000,
});

function response(json: unknown, status = 200): Response {
    return Response.json(json, { status });
}

function requestUrl(input: string | URL | Request): URL {
    return input instanceof Request ? new URL(input.url) : new URL(input);
}

function requestBody(init: RequestInit | undefined): string {
    return typeof init?.body === "string" ? init.body : "";
}

describe("OpenClaw heartbeat automation wrapper", () => {
    test("performs exactly one schema-v5 collection followed by one complete report", async () => {
        const calls: { readonly init?: RequestInit; readonly url: URL }[] = [];
        const output: string[] = [];
        const fetch = (input: string | URL | Request, init?: RequestInit) => {
            const url = requestUrl(input);
            calls.push({ init, url });
            return Promise.resolve(
                calls.length === 1
                    ? response({ result: { data: { json: heartbeat } } })
                    : response({
                          result: {
                              data: {
                                  json: {
                                      createdIncidents: 0,
                                      duplicateRunId: false,
                                      observedIncidents: 0,
                                      reopenedIncidents: 0,
                                      reportId: null,
                                      resolvedIncidents: 0,
                                      realtimeEvents: 0,
                                      runId,
                                      status: "accepted",
                                  },
                              },
                          },
                      })
            );
        };
        const dependencies = {
            fetch,
            readCredential: () => Promise.resolve(token),
            writeStandardOutput: (value: string) => output.push(value),
        } as const;

        await runOpenClawHeartbeatCommand(["collect"], dependencies);
        await runOpenClawHeartbeatCommand(["report"], {
            ...dependencies,
            readStandardInput: () => Promise.resolve(JSON.stringify(snapshot)),
        });

        expect(calls).toHaveLength(2);
        expect(calls.map(({ url }) => url.pathname)).toEqual([
            "/trpc/cache.getHeartbeat",
            "/trpc/monitoring.submitCompleteSnapshot",
        ]);
        expect(calls.every(({ url }) => url.origin === "http://127.0.0.1:3100")).toBe(
            true
        );
        expect(calls[0]?.url.searchParams.get("input")).toBe('{"json":{}}');
        expect(calls[0]?.init?.method).toBe("GET");
        expect(calls[1]?.url.search).toBe("");
        expect(calls[1]?.init?.method).toBe("POST");
        expect(JSON.parse(requestBody(calls[1]?.init))).toEqual({ json: snapshot });
        for (const call of calls) {
            expect(new Headers(call.init?.headers).get("authorization")).toBe(
                `Bearer ${token}`
            );
            expect(call.init?.redirect).toBe("error");
        }
        expect(JSON.parse(output[0]!)).toEqual(heartbeat);
        expect(JSON.parse(output[1]!)).toMatchObject({ runId, status: "accepted" });
        expect(openClawHeartbeatAutomationProfile).toEqual({
            capabilities: ["cache:read", "monitoring:write"],
            credentialFile: "openclaw-heartbeat.token",
            id: "openclaw-heartbeat",
        });
    });

    test("rejects fanout-shaped commands and invalid report input before transport", async () => {
        let calls = 0;
        const dependencies = {
            fetch: () => {
                calls += 1;
                return Promise.resolve(response({}));
            },
            readCredential: () => Promise.resolve(token),
            writeStandardOutput: () => {},
        } as const;

        const rejectedCommands = [
            runOpenClawHeartbeatCommand(["collect", "system.metrics"], dependencies),
            runOpenClawHeartbeatCommand(["cache.getHeartbeat"], dependencies),
            runOpenClawHeartbeatCommand(["report"], {
                ...dependencies,
                readStandardInput: () => Promise.resolve('{"monitorKey":"incomplete"}'),
            }),
        ];
        for (const command of rejectedCommands) {
            expect(command).rejects.toThrow("OpenClaw heartbeat automation failed");
        }
        await Promise.allSettled(rejectedCommands);
        expect(calls).toBe(0);
    });

    test("rejects the legacy credential format before transport", async () => {
        let calls = 0;
        const legacyToken = `openclaw-heartbeat.${"c".repeat(64)}`;

        const failure = runOpenClawHeartbeatCommand(["collect"], {
            fetch: () => {
                calls += 1;
                return Promise.resolve(response({}));
            },
            readCredential: () => Promise.resolve(legacyToken),
            writeStandardOutput: () => {},
        });

        expect(failure).rejects.toThrow("OpenClaw heartbeat automation failed");
        await Promise.allSettled([failure]);

        expect(calls).toBe(0);
    });

    test("does not retry or expose upstream data when one response fails", async () => {
        let calls = 0;
        const upstreamSecret = "upstream-secret-must-not-escape";
        const failure = runOpenClawHeartbeatCommand(["collect"], {
            fetch: () => {
                calls += 1;
                return Promise.resolve(response({ error: upstreamSecret }, 503));
            },
            readCredential: () => Promise.resolve(token),
            writeStandardOutput: () => {},
        });

        expect(failure).rejects.toThrow("OpenClaw heartbeat automation failed");
        try {
            await failure;
        } catch (error) {
            expect(String(error)).not.toContain(upstreamSecret);
            expect(String(error)).not.toContain(token);
        }
        expect(calls).toBe(1);
    });
});
