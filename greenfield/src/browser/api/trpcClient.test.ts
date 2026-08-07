import { describe, expect, test } from "bun:test";

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
