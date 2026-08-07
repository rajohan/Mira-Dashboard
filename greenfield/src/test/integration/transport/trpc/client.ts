import {
    createTRPCClient,
    httpBatchLink,
    httpSubscriptionLink,
    type HTTPBatchLinkOptions,
    retryLink,
    splitLink,
} from "@trpc/client";
import { EventSource, type EventSourceInit } from "eventsource";

import type { IntegrationRouter } from "./router.ts";

/** Native Bun fetch surface shared by the integration transports. */
export type IntegrationFetch = (
    ...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

type IntegrationTrpcFetch = NonNullable<
    HTTPBatchLinkOptions<IntegrationRouter["_def"]["_config"]["$types"]>["fetch"]
>;

function adaptIntegrationTrpcFetch(
    fetchImplementation: IntegrationFetch | undefined
): IntegrationTrpcFetch | undefined {
    if (fetchImplementation === undefined) return undefined;

    return async (input, init) => {
        if (typeof input !== "string") {
            throw new TypeError("The integration tRPC adapter requires a string URL");
        }
        const response = await fetchImplementation(input, {
            body: init?.body,
            headers: init?.headers,
            method: init?.method,
            signal: init?.signal,
        });
        return {
            json: () => response.json(),
            ok: response.ok,
        };
    };
}

/** Transport options for one integration client. */
export interface IntegrationClientOptions {
    eventSourceOptions?: EventSourceInit;
    fetch?: IntegrationFetch;
    retrySubscriptions?: boolean;
    url: URL;
}

/**
 * Creates the shared query, mutation, and SSE integration client.
 * @param options Stable endpoint and optional TLS/retry transport behavior.
 * @returns A typed tRPC client.
 */
export function createIntegrationClient(options: IntegrationClientOptions) {
    const url = new URL("/trpc", options.url).toString();
    const trpcFetch = adaptIntegrationTrpcFetch(options.fetch);

    return createTRPCClient<IntegrationRouter>({
        links: [
            retryLink({
                retry: ({ attempts, op }) =>
                    options.retrySubscriptions === true &&
                    op.type === "subscription" &&
                    attempts <= 20,
                retryDelayMs: () => 100,
            }),
            splitLink({
                condition: (operation) => operation.type === "subscription",
                false: httpBatchLink({ fetch: trpcFetch, url }),
                true: httpSubscriptionLink({
                    EventSource,
                    eventSourceOptions: options.eventSourceOptions,
                    url,
                }),
            }),
        ],
    });
}
