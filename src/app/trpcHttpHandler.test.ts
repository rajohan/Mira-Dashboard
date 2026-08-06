import { describe, expect, test } from "bun:test";

import { createStructuredLogger } from "../server/platform/observability/structuredLogger.ts";
import {
    createTestApplicationRuntime,
    createTestServerSecurityServices,
} from "../server/test/support/requestContext.ts";
import { createTrpcHttpHandler } from "./trpcHttpHandler.ts";

const unreachableBunServer = {
    requestIP(): never {
        throw new Error("Early rejection unexpectedly resolved a client address");
    },
    timeout(): never {
        throw new Error("Early rejection unexpectedly configured a request timeout");
    },
};

interface EarlyRejectionExpectation {
    readonly browserOrigin?: string;
    readonly expectedBody: string;
    readonly expectedCancellationReason: string;
    readonly expectedStatus: number;
    readonly headers?: Record<string, string>;
    readonly path: string;
}

async function expectEarlyRejectionCancelsBody(
    input: EarlyRejectionExpectation
): Promise<void> {
    const logLines: string[] = [];
    const cancellationReasons: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
        cancel(reason) {
            cancellationReasons.push(reason);
        },
        start(controller) {
            controller.enqueue(new Uint8Array([123, 125]));
        },
    });
    const request = new Request(new URL(input.path, "https://dashboard.example").href, {
        body,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        method: "POST",
    });
    const logger = createStructuredLogger({
        identity: {
            bun: "1.4.0-test",
            pid: 123,
            processRole: "web",
            release: "handler-test",
            service: "mira-dashboard",
        },
        sink: {
            write(line) {
                logLines.push(line);
            },
        },
    });
    const handler = createTrpcHttpHandler({
        ...createTestServerSecurityServices(),
        applicationRuntime: createTestApplicationRuntime({ logger }),
        ...(input.browserOrigin === undefined
            ? {}
            : { browserOrigin: input.browserOrigin }),
    });

    const response = await handler(
        request,
        new URL(request.url),
        unreachableBunServer,
        "01900000-0000-7000-8000-000000000001"
    );

    expect(response.status).toBe(input.expectedStatus);
    expect(await response.text()).toBe(input.expectedBody);
    expect(cancellationReasons).toEqual([input.expectedCancellationReason]);
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(logLines).toEqual([]);
}

describe("tRPC HTTP handler early rejection", () => {
    test("cancels a forbidden-source request body", () =>
        expectEarlyRejectionCancelsBody({
            browserOrigin: "https://dashboard.example",
            expectedBody: "Forbidden",
            expectedCancellationReason: "tRPC request source is forbidden",
            expectedStatus: 403,
            headers: {
                origin: "https://attacker.example",
                "sec-fetch-site": "cross-site",
            },
            path: "/trpc/auth.bootstrap",
        }));

    test("cancels an ambiguous-credential request body", () =>
        expectEarlyRejectionCancelsBody({
            expectedBody: "Ambiguous authentication credentials",
            expectedCancellationReason: "tRPC authentication credentials are ambiguous",
            expectedStatus: 400,
            headers: {
                authorization: `Bearer ${"a".repeat(32)}.${"b".repeat(64)}`,
                cookie: "__Host-mira_dashboard_session=malformed",
            },
            path: "/trpc/auth.logout",
        }));

    test("cancels a forbidden security-batch request body", () =>
        expectEarlyRejectionCancelsBody({
            expectedBody: "Security procedure is not batchable",
            expectedCancellationReason: "tRPC security procedure batch is forbidden",
            expectedStatus: 400,
            path: "/trpc/auth.login?batch=1",
        }));
});

test("redacts an unexpected context defect through the tRPC boundary", async () => {
    const sentinel = "context-failure-secret";
    const logLines: string[] = [];
    const request = new Request("https://dashboard.example/trpc/auth.status");
    const logger = createStructuredLogger({
        identity: {
            bun: "1.4.0-test",
            pid: 123,
            processRole: "web",
            release: "handler-test",
            service: "mira-dashboard",
        },
        sink: {
            write(line) {
                logLines.push(line);
            },
        },
    });
    const handler = createTrpcHttpHandler({
        ...createTestServerSecurityServices(),
        applicationRuntime: createTestApplicationRuntime({ logger }),
        authenticateCredential() {
            throw new Error(sentinel);
        },
    });
    const bunServer = {
        requestIP: () => ({ address: "127.0.0.1" }),
        timeout(_request: Request, seconds: number) {
            expect(seconds).toBeGreaterThan(0);
        },
    };

    const response = await handler(
        request,
        new URL(request.url),
        bunServer,
        "01900000-0000-7000-8000-000000000001"
    );
    const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records[0]).toMatchObject({
        event: "trpc.request.defect",
        outcome: "server-error",
    });
    expect(records[0]).toMatchObject({
        requestId: "01900000-0000-7000-8000-000000000001",
    });
});
