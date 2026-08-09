import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type {
    GetOpenClawCronResult,
    ListOpenClawCronResult,
    ListOpenClawCronRunsResult,
} from "../../../contracts/openClawCron.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { router } from "../../trpc/trpc.ts";
import type { OpenClawCronMutationAccess } from "./mutationAccess.ts";
import { openClawCronRouter } from "./procedures.ts";
import type { OpenClawCronService } from "./service.ts";
import { OpenClawCronServiceError } from "./service.ts";

const timestampMs = 1_800_000_000_000;
const userId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const job = {
    agentIdTruncated: false,
    configRevision: "revision-1",
    createdAtMs: timestampMs - 1000,
    delivery: {
        completionDestinationConfigured: false,
        metadataTruncated: false,
        mode: "announce",
        targetConfigured: false,
    },
    deliveryMode: "announce",
    descriptionTruncated: false,
    enabled: true,
    id: "nightly-report",
    name: "Nightly report",
    nameTruncated: false,
    payload: {
        kind: "agent-turn",
        message: "Produce the nightly report.",
        truncated: false,
    },
    schedule: {
        expr: "0 7 * * *",
        kind: "cron",
        truncated: false,
        tz: "Europe/Oslo",
    },
    sessionTarget: "isolated",
    source: "openclaw",
    state: { nextRunAtMs: timestampMs + 60_000 },
    synchronization: { state: "confirmed" },
    updatedAtMs: timestampMs,
    wakeMode: "now",
} as const;

function detail(): GetOpenClawCronResult {
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        job,
    };
}

function inventory(): ListOpenClawCronResult {
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        hasMore: false,
        jobs: [job],
        limit: 50,
        offset: 0,
        snapshotRevision: `sha256:${"A".repeat(43)}`,
        total: 1,
    };
}

function runs(): ListOpenClawCronRunsResult {
    return {
        freshness: { kind: "fresh", observedAtMs: timestampMs },
        hasMore: false,
        limit: 50,
        offset: 0,
        runs: [],
        total: 0,
    };
}

function testService(calls: string[]): OpenClawCronService {
    return {
        delete: (input, actor) => {
            calls.push(`delete:${input.id}:${actor.kind}:${actor.id}`);
            return Promise.resolve({
                deleted: true,
                id: input.id,
                observedAtMs: timestampMs,
            });
        },
        get: (input) => {
            calls.push(`get:${input.id}`);
            return Promise.resolve(detail());
        },
        list: () => {
            calls.push("list");
            return Promise.resolve(inventory());
        },
        listRuns: (input) => {
            calls.push(`listRuns:${input.id}`);
            return Promise.resolve(runs());
        },
        reconcileExpired: () => Promise.resolve(detail()),
        run: (input) => {
            calls.push(`run:${input.id}`);
            return Promise.resolve({ job, outcome: "accepted" });
        },
        setEnabled: (input, actor) => {
            calls.push(`setEnabled:${input.id}:${actor.kind}:${actor.id}`);
            return Promise.resolve(detail());
        },
        update: (input) => {
            calls.push(`update:${input.id}`);
            return Promise.resolve(detail());
        },
    };
}

function sessionContext(
    service: OpenClawCronService,
    mutationAccess: OpenClawCronMutationAccess,
    capabilities: readonly ("jobs:read" | "jobs:write")[] = ["jobs:read", "jobs:write"]
): RequestContext {
    return {
        authentication: {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities,
                authenticatorId: "a".repeat(32),
                id: userId,
                kind: "session",
            },
        },
        authenticationLease: {
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            revalidate: () => Promise.reject(new Error("Not used by this test")),
        },
        openClawCronMutationAccess: mutationAccess,
        openClawCronService: service,
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

function anonymousContext(service: OpenClawCronService): RequestContext {
    return {
        authentication: { kind: "anonymous" },
        openClawCronService: service,
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

const testRouter = router({ openClawCron: openClawCronRouter });

describe("OpenClaw cron procedures", () => {
    test("serves session reads and recent-MFA controls through the direct domain service", async () => {
        const calls: string[] = [];
        const caller = testRouter.createCaller(
            sessionContext(testService(calls), {
                authorizeRecentMfa: () => "authorized",
            })
        ).openClawCron;

        expect(await caller.list({})).toEqual(inventory());
        expect(await caller.get({ id: job.id })).toEqual(detail());
        expect(await caller.listRuns({ id: job.id })).toEqual(runs());
        expect(await caller.run({ id: job.id })).toMatchObject({
            outcome: "accepted",
        });
        await caller.setEnabled({
            disableIntent: { reason: "Maintenance" },
            enabled: false,
            expectedConfigRevision: "revision-1",
            id: job.id,
        });
        await caller.update({
            expectedConfigRevision: "revision-1",
            id: job.id,
            patch: { name: "Morning report" },
        });
        await caller.delete({
            expectedConfigRevision: "revision-1",
            id: job.id,
        });
        expect(calls).toEqual([
            "list",
            `get:${job.id}`,
            `listRuns:${job.id}`,
            `run:${job.id}`,
            `setEnabled:${job.id}:user:${userId}`,
            `update:${job.id}`,
            `delete:${job.id}:user:${userId}`,
        ]);
    });

    test("rejects anonymous reads before invoking the domain service", async () => {
        const calls: string[] = [];
        const caller = testRouter.createCaller(
            anonymousContext(testService(calls))
        ).openClawCron;
        const failure = await captureFailure(() => caller.list({}));
        expect(failure).toBeInstanceOf(TRPCError);
        expect(calls).toEqual([]);
    });

    test("enforces read and write capabilities before MFA or service work", async () => {
        const readCalls: string[] = [];
        let readOnlyMfaChecks = 0;
        const readOnly = testRouter.createCaller(
            sessionContext(
                testService(readCalls),
                {
                    authorizeRecentMfa: () => {
                        readOnlyMfaChecks += 1;
                        return "authorized";
                    },
                },
                ["jobs:read"]
            )
        ).openClawCron;
        expect(await readOnly.list({})).toEqual(inventory());
        expect(await captureFailure(() => readOnly.run({ id: job.id }))).toBeInstanceOf(
            TRPCError
        );
        expect(readOnlyMfaChecks).toBe(0);
        expect(readCalls).toEqual(["list"]);

        const writeCalls: string[] = [];
        let writeMfaChecks = 0;
        const writeOnly = testRouter.createCaller(
            sessionContext(
                testService(writeCalls),
                {
                    authorizeRecentMfa: () => {
                        writeMfaChecks += 1;
                        return "authorized";
                    },
                },
                ["jobs:write"]
            )
        ).openClawCron;
        expect(await captureFailure(() => writeOnly.get({ id: job.id }))).toBeInstanceOf(
            TRPCError
        );
        expect(await writeOnly.run({ id: job.id })).toMatchObject({
            outcome: "accepted",
        });
        expect(writeMfaChecks).toBe(1);
        expect(writeCalls).toEqual([`run:${job.id}`]);
    });

    test("denies every control without recent MFA before service invocation", async () => {
        for (const status of [
            "mfa-enrollment-required",
            "step-up-required",
            "session-changed",
        ] as const) {
            const calls: string[] = [];
            const context = sessionContext(testService(calls), {
                authorizeRecentMfa: () => status,
            });
            const caller = testRouter.createCaller(context).openClawCron;
            for (const control of [
                () => caller.run({ id: job.id }),
                () =>
                    caller.setEnabled({
                        disableIntent: { reason: "Maintenance" },
                        enabled: false,
                        expectedConfigRevision: "revision-1",
                        id: job.id,
                    }),
                () =>
                    caller.update({
                        expectedConfigRevision: "revision-1",
                        id: job.id,
                        patch: { name: "Morning report" },
                    }),
                () =>
                    caller.delete({
                        expectedConfigRevision: "revision-1",
                        id: job.id,
                    }),
            ]) {
                expect(await captureFailure(control)).toBeInstanceOf(TRPCError);
            }
            expect(calls).toEqual([]);
            if (status === "session-changed") {
                expect(context.responseHeaders.get("set-cookie")).toContain("Max-Age=0");
            }
        }
    });

    test("maps provider failures without exposing raw upstream messages", async () => {
        const service: OpenClawCronService = {
            ...testService([]),
            list: () =>
                Promise.reject(
                    new OpenClawCronServiceError("provider-unavailable", {
                        cause: new Error("raw Gateway detail"),
                    })
                ),
        };
        const caller = testRouter.createCaller(
            sessionContext(service, { authorizeRecentMfa: () => "authorized" })
        ).openClawCron;
        const failure = await captureFailure(() => caller.list({}));
        expect(failure).toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: "OpenClaw cron is temporarily unavailable",
        });
        expect(String(failure)).not.toContain("raw Gateway detail");
    });

    test("keeps known precondition failures distinct from indeterminate outcomes", async () => {
        for (const [reason, code, message] of [
            [
                "precondition-failed",
                "PRECONDITION_FAILED",
                "OpenClaw cron control precondition failed",
            ],
            [
                "unknown-outcome",
                "SERVICE_UNAVAILABLE",
                "OpenClaw cron outcome could not be confirmed",
            ],
        ] as const) {
            const service: OpenClawCronService = {
                ...testService([]),
                run: () => Promise.reject(new OpenClawCronServiceError(reason)),
            };
            const caller = testRouter.createCaller(
                sessionContext(service, { authorizeRecentMfa: () => "authorized" })
            ).openClawCron;

            expect(await captureFailure(() => caller.run({ id: job.id }))).toMatchObject({
                code,
                message,
            });
        }
    });
});
