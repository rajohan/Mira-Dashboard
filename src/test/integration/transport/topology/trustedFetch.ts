import type { IntegrationFetch } from "../trpc/client.ts";

/** Options for an integration client that trusts one ephemeral TLS identity. */
export interface TrustedFetchOptions {
    certificateAuthority: string;
    cookie?: string;
}

/**
 * Creates a Bun Fetch implementation with a private CA and optional test credential.
 * @param options TLS trust and credential options.
 * @returns A Fetch-compatible function for tRPC and EventSource.
 */
export function createTrustedFetch(options: TrustedFetchOptions): IntegrationFetch {
    return async (input, init) => {
        const inputHeaders = input instanceof Request ? input.headers : undefined;
        const headers = new Headers(init?.headers ?? inputHeaders);
        if (options.cookie !== undefined) {
            headers.set("cookie", options.cookie);
        }

        return fetch(input, {
            ...init,
            headers,
            tls: { ca: options.certificateAuthority },
        });
    };
}
