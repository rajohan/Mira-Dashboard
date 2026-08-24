import { createTRPCUntypedClient, httpSubscriptionLink } from "@trpc/client";
import superjson from "superjson";
import * as v from "valibot";

import {
    type RealtimeStreamInput,
    type RealtimeStreamOutput,
    realtimeStreamInputSchema,
    realtimeStreamOutputSchema,
} from "../../contracts/events.ts";
import { DashboardProtocolError } from "./trpcClient.ts";

export interface DashboardRealtimeTransportObserver {
    readonly onData: (value: unknown) => void;
    readonly onError: (error: unknown) => void;
}

/** Unsubscribes one browser-owned realtime stream. */
export interface DashboardRealtimeSubscription {
    readonly unsubscribe: () => void;
}

/** Minimal long-lived tRPC authority retained behind contract validation. */
export interface DashboardRealtimeTransport {
    readonly subscription: (
        path: string,
        input: unknown,
        observer: DashboardRealtimeTransportObserver
    ) => DashboardRealtimeSubscription;
}

/** Validated callbacks for one durable Dashboard event stream. */
export interface DashboardRealtimeObserver {
    readonly onData: (output: RealtimeStreamOutput) => void;
    /** Receives only terminal transport or protocol failures. */
    readonly onError?: (error: DashboardProtocolError) => void;
}

/** Browser client for contract-validated tracked SSE. */
export interface DashboardRealtimeClient {
    readonly subscribe: (
        input: RealtimeStreamInput,
        observer: DashboardRealtimeObserver
    ) => DashboardRealtimeSubscription;
}

/**
 * Creates the same-origin tRPC tracked-SSE transport.
 * @param url Same-origin tRPC mount.
 * @returns One reconnecting subscription transport with cookie credentials.
 */
export function createDashboardRealtimeTransport(
    url = "/trpc"
): DashboardRealtimeTransport {
    const client = createTRPCUntypedClient({
        links: [
            httpSubscriptionLink({
                eventSourceOptions: { withCredentials: true },
                transformer: superjson,
                url,
            }),
        ],
    });
    const transport: DashboardRealtimeTransport = {
        subscription(path, input, observer) {
            return client.subscription(path, input, {
                onData: observer.onData,
                onError: observer.onError,
            });
        },
    };
    return Object.freeze(transport);
}

/**
 * Creates a validating browser client over the tracked-SSE transport.
 * @param transport Injected production or isolated transport.
 * @returns Contract-validated realtime subscription operations.
 */
export function createDashboardRealtimeClient(
    transport: DashboardRealtimeTransport = createDashboardRealtimeTransport()
): DashboardRealtimeClient {
    const client: DashboardRealtimeClient = {
        subscribe(input, observer) {
            const parsedInput = v.parse(realtimeStreamInputSchema, input);
            let active = true;
            const transportState: {
                subscription?: DashboardRealtimeSubscription;
            } = {};
            const close = () => {
                if (!active) return;
                active = false;
                transportState.subscription?.unsubscribe();
            };
            const transportSubscription = transport.subscription(
                "events.stream",
                parsedInput,
                {
                    onData(value) {
                        if (!active) return;
                        const parsed = v.safeParse(realtimeStreamOutputSchema, value);
                        if (!parsed.success) {
                            close();
                            observer.onError?.(new DashboardProtocolError());
                            return;
                        }
                        observer.onData(parsed.output);
                    },
                    onError() {
                        if (!active) return;
                        close();
                        observer.onError?.(new DashboardProtocolError());
                    },
                }
            );
            transportState.subscription = transportSubscription;
            if (!active) transportSubscription.unsubscribe();
            return Object.freeze({
                unsubscribe: close,
            });
        },
    };
    return Object.freeze(client);
}
