import {
    createTRPCClient,
    httpBatchLink,
    httpSubscriptionLink,
    retryLink,
    splitLink,
} from "@trpc/client";
import { EventSource, type EventSourceInit } from "eventsource";

import type { QualificationRouter } from "./router.ts";

/** Fetch surface shared by the tRPC and EventSource qualification transports. */
export type QualificationFetch = (
    input: Request | string | URL,
    init?: RequestInit
) => Promise<Response>;

/** Transport options for one qualification client. */
export interface QualificationClientOptions {
    eventSourceOptions?: EventSourceInit;
    fetch?: QualificationFetch;
    retrySubscriptions?: boolean;
    url: URL;
}

/**
 * Creates the shared query, mutation, and SSE qualification client.
 * @param options Stable endpoint and optional TLS/retry transport behavior.
 * @returns A typed tRPC client.
 */
export function createQualificationClient(options: QualificationClientOptions) {
    const url = new URL("/trpc", options.url).toString();

    return createTRPCClient<QualificationRouter>({
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
                false: httpBatchLink({ fetch: options.fetch, url }),
                true: httpSubscriptionLink({
                    EventSource,
                    eventSourceOptions: options.eventSourceOptions,
                    url,
                }),
            }),
        ],
    });
}
