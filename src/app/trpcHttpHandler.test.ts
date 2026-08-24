import { describe, expect, test } from "bun:test";

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
    const handler = createTrpcHttpHandler({
        ...createTestServerSecurityServices(),
        applicationRuntime: createTestApplicationRuntime(),
        ...(input.browserOrigin === undefined
            ? {}
            : { browserOrigin: input.browserOrigin }),
    });

    const response = await handler(request, new URL(request.url), unreachableBunServer);

    expect(response.status).toBe(input.expectedStatus);
    expect(await response.text()).toBe(input.expectedBody);
    expect(cancellationReasons).toEqual([input.expectedCancellationReason]);
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
