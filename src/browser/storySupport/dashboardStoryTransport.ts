import type { TRPCRequestOptions } from "@trpc/client";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import type { DashboardTrpcTransport } from "../api/trpcClient.ts";

export type DashboardStoryFixtureValue =
    | { readonly error: Error; readonly kind: "failure" }
    | { readonly kind: "resolver"; readonly resolve: DashboardStoryFixtureResolver }
    | { readonly kind: "value"; readonly value: unknown };

export type DashboardStoryFixtureResolver = (
    input: unknown,
    callIndex: number
) => unknown;

/**
 * @param value Contract-valid procedure output.
 * @returns A static strict-transport fixture.
 */
export function dashboardStoryValue(value: unknown): DashboardStoryFixtureValue {
    return { kind: "value", value };
}

/**
 * @param error Safe fixture failure.
 * @returns A failed strict-transport fixture.
 */
export function dashboardStoryFailure(error: Error): DashboardStoryFixtureValue {
    return { error, kind: "failure" };
}

/**
 * @param resolve Input- and call-aware fixture function.
 * @returns An input- and call-aware strict-transport fixture.
 */
export function dashboardStoryResolver(
    resolve: DashboardStoryFixtureResolver
): DashboardStoryFixtureValue {
    return { kind: "resolver", resolve };
}

export interface DashboardStoryFixtures {
    readonly mutations?: Readonly<Record<string, DashboardStoryFixtureValue>>;
    readonly queries?: Readonly<Record<string, DashboardStoryFixtureValue>>;
}

const storyTimestampMs = 1_800_000_000_000;

/** Stable authenticated browser session shared by authenticated page stories. */
export const authenticatedDashboardStoryStatus = Object.freeze({
    session: {
        authenticatedAtMs: storyTimestampMs - 60_000,
        authMethod: "password",
        createdAtMs: storyTimestampMs - 60_000,
        expiresAtMs: storyTimestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: storyTimestampMs,
        userAgent: "Dashboard Storybook",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        email: "operator@example.com",
        emailVerified: true,
        username: "operator",
    },
} as const satisfies AuthStatus);

/** Safe default used by authenticated stories that do not exercise security UI. */
export const dashboardStoryAccountSecuritySummary = Object.freeze({
    checkedAtMs: storyTimestampMs,
    mfa: {
        enabled: false,
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentAuth: {
        mfa: { recent: false },
        password: {
            expiresAtMs: storyTimestampMs + 300_000,
            recent: true,
            remainingMs: 300_000,
            verifiedAtMs: storyTimestampMs,
        },
    },
    webAuthn: { available: false },
} as const satisfies AccountSecuritySummary);

function valueForCall(
    value: DashboardStoryFixtureValue,
    input: unknown,
    callIndex: number
): Promise<unknown> {
    if (value.kind === "failure") return Promise.reject(value.error);
    if (value.kind === "value") return Promise.resolve(value.value);
    try {
        return Promise.resolve(value.resolve(input, callIndex));
    } catch (error) {
        return Promise.reject(
            error instanceof Error
                ? error
                : new TypeError("Story fixture resolver failed")
        );
    }
}

/**
 * Strict fixture transport used by full-page stories. Unknown procedures fail
 * instead of silently inventing a response, while auth lifecycle defaults remain
 * identical across authenticated pages.
 */
export class DashboardStoryTransport implements DashboardTrpcTransport {
    readonly #fixtures: DashboardStoryFixtures;
    readonly #mutationCounts = new Map<string, number>();
    readonly #queryCounts = new Map<string, number>();

    constructor(fixtures: DashboardStoryFixtures = {}) {
        this.#fixtures = fixtures;
    }

    mutation(
        path: string,
        input?: unknown,
        _options?: TRPCRequestOptions
    ): Promise<unknown> {
        const callIndex = this.#mutationCounts.get(path) ?? 0;
        this.#mutationCounts.set(path, callIndex + 1);
        const fixture = this.#fixtures.mutations?.[path];
        if (fixture !== undefined) return valueForCall(fixture, input, callIndex);
        if (path === "auth.touch") {
            return Promise.resolve({ lastSeenAtMs: storyTimestampMs });
        }
        return Promise.reject(new TypeError(`Unexpected story mutation: ${path}`));
    }

    query(
        path: string,
        input?: unknown,
        _options?: TRPCRequestOptions
    ): Promise<unknown> {
        const callIndex = this.#queryCounts.get(path) ?? 0;
        this.#queryCounts.set(path, callIndex + 1);
        const fixture = this.#fixtures.queries?.[path];
        if (fixture !== undefined) return valueForCall(fixture, input, callIndex);
        if (path === "auth.status")
            return Promise.resolve(authenticatedDashboardStoryStatus);
        if (path === "accountSecurity.summary")
            return Promise.resolve(dashboardStoryAccountSecuritySummary);
        return Promise.reject(new TypeError(`Unexpected story query: ${path}`));
    }
}
