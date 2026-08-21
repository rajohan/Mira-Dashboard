import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { secondsToMilliseconds } from "date-fns";
import { EventSource, type EventSourceFetchInit } from "eventsource";
import superjson from "superjson";
import * as v from "valibot";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import type { ApplicationServer } from "../../../app/server.ts";
import { createAutomationPrincipalResultSchema } from "../../../contracts/automationSecurity.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import {
    authenticationTestUserId,
    openAuthenticationTestDatabase,
    testTotpSecretCipher,
} from "../../domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import type { ApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import type { AppRouter } from "../../trpc/appRouter.ts";
import { CookieJar, postTrpcMutation, trpcData } from "./mfaHttpSystem.ts";
import { withTestTimeout } from "./promise.ts";
import { withTestDashboardDatabase } from "./requestContext.ts";

export const automationHttpSystemBrowserOrigin = "https://dashboard.example";
export const automationHttpSystemPrincipalId = "system-automation-reader";
export const automationHttpSubscriptionTimeoutMs = secondsToMilliseconds(3);

export const automationHttpReportDelivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: monitoringRealtimeTopics.reports,
    },
    id: "1",
    kind: "change",
};

const notificationDelivery: RealtimeEventDelivery = {
    event: {
        entityId: "notification-1",
        entityType: "notification",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"notification-1"}',
        topic: monitoringRealtimeTopics.notifications,
    },
    id: "1",
    kind: "change",
};

export type AutomationAuthenticationFixture = Awaited<
    ReturnType<typeof openAuthenticationTestDatabase>
>;

function enableTestUserMfa(
    fixture: AutomationAuthenticationFixture,
    enabledAt: Date
): void {
    const confirmedTotpFactorId = "019fc968-1a9b-7772-af1b-d5b863b0e7b4";
    const encryptedTestTotpSecret = `v1.${"A".repeat(16)}.${"B".repeat(64)}`;
    const enrollmentExpiresAtMs = enabledAt.getTime() + secondsToMilliseconds(300);
    fixture.database.sqlite
        .query(
            `INSERT INTO user_totp_factors (
                id,
                user_id,
                label,
                encrypted_secret,
                secret_key_id,
                created_at,
                enrollment_expires_at,
                confirmed_at,
                last_used_step
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            confirmedTotpFactorId,
            authenticationTestUserId,
            "System authenticator",
            encryptedTestTotpSecret,
            "system-test",
            enabledAt.getTime(),
            enrollmentExpiresAtMs,
            enabledAt.getTime(),
            1
        );
    fixture.database.sqlite
        .query("UPDATE users SET mfa_enabled_at = ? WHERE id = ?")
        .run(enabledAt.getTime(), authenticationTestUserId);
    fixture.database.sqlite
        .query("UPDATE auth_sessions SET mfa_verified_at = ? WHERE user_id = ?")
        .run(enabledAt.getTime(), authenticationTestUserId);
}

/**
 * Opens one persisted browser/automation fixture with a confirmed recent MFA session.
 * @param now Shared composition clock used to create the authenticated fixture.
 * @returns The migrated database fixture and its authenticated browser cookie jar.
 */
export async function openAutomationAuthenticationFixture(
    now: () => Date = () => new Date()
): Promise<{
    readonly fixture: AutomationAuthenticationFixture;
    readonly jar: CookieJar;
}> {
    const fixtureTime = now();
    const fixture = await openAuthenticationTestDatabase(fixtureTime);
    try {
        enableTestUserMfa(fixture, fixtureTime);
        const jar = new CookieJar();
        jar.set(dashboardSessionCookieName, fixture.session.token);
        return { fixture, jar };
    } catch (error) {
        fixture.database.sqlite.close(true);
        throw error;
    }
}

interface AutomationHttpSystemOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationLeaseDurationMs?: number;
    readonly now?: () => Date;
    readonly principalId?: string;
}

/**
 * Starts the real persisted automation-security HTTP composition and creates one reader.
 * @param options Runtime and optional lease/principal overrides for the focused system test.
 * @returns The running server, browser session, initial credential, and deterministic cleanup.
 */
export async function openAutomationHttpSystem(options: AutomationHttpSystemOptions) {
    const { fixture, jar } = await openAutomationAuthenticationFixture(options.now);
    let server: ApplicationServer | undefined;

    try {
        server = await createDashboardServer({
            applicationRuntime: withTestDashboardDatabase(
                options.applicationRuntime,
                fixture.database.orm
            ),
            ...(options.authenticationLeaseDurationMs === undefined
                ? {}
                : {
                      authenticationLeaseDurationMs:
                          options.authenticationLeaseDurationMs,
                  }),
            browserOrigin: automationHttpSystemBrowserOrigin,
            gatewayUrl: "ws://127.0.0.1:1",
            now: options.now ?? (() => new Date()),
            port: 0,
            readiness: createReadinessController(),
            totpSecretCipher: testTotpSecretCipher,
        });
        const creationResponse = await postTrpcMutation(
            server.url,
            "automationSecurity.createPrincipal",
            {
                capabilities: ["reports:read"],
                id: options.principalId ?? automationHttpSystemPrincipalId,
                initialCredential: { label: "Initial system credential" },
                label: "System automation reader",
            },
            { jar }
        );
        if (creationResponse.response.status !== 200) {
            throw new Error(
                `Automation system principal creation failed with HTTP ${creationResponse.response.status}`
            );
        }
        const created = v.parse(
            createAutomationPrincipalResultSchema,
            trpcData(creationResponse)
        );

        return {
            created,
            fixture,
            jar,
            server,
            async close(): Promise<void> {
                try {
                    await server?.stop(true);
                } finally {
                    fixture.database.sqlite.close(true);
                }
            },
        };
    } catch (error) {
        try {
            await server?.stop(true);
        } finally {
            fixture.database.sqlite.close(true);
        }
        throw error;
    }
}

function browserRequestHeaders(options: {
    readonly bearerToken?: string;
    readonly cookie?: string;
}): Headers {
    const headers = new Headers({
        origin: automationHttpSystemBrowserOrigin,
        "sec-fetch-site": "same-origin",
        "user-agent": "Mira automation-security system test",
    });
    if (options.bearerToken !== undefined) {
        headers.set("authorization", `Bearer ${options.bearerToken}`);
    }
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    return headers;
}

/**
 * Performs one real tRPC Fetch query with an explicit cookie and/or bearer.
 * @param server Running application server under test.
 * @param procedure Exact tRPC procedure name.
 * @param input JSON-compatible procedure input.
 * @param options Authentication headers for the request.
 * @returns The raw HTTP response, cookies, and response text.
 */
export async function getAutomationTrpcQuery(
    server: ApplicationServer,
    procedure: string,
    input: unknown,
    options: { readonly bearerToken?: string; readonly cookie?: string }
) {
    const encodedInput = encodeURIComponent(JSON.stringify({ json: input }));
    const response = await fetch(
        new URL(`/trpc/${procedure}?input=${encodedInput}`, server.url),
        { headers: browserRequestHeaders(options) }
    );
    return {
        response,
        setCookies: response.headers.getSetCookie(),
        text: await response.text(),
    };
}

function eventSourceFetchWithBearer(
    bearerToken: string,
    observeResponse?: (response: Response) => void
) {
    return async (url: string | URL, init: EventSourceFetchInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${bearerToken}`);
        headers.set("origin", automationHttpSystemBrowserOrigin);
        headers.set("sec-fetch-site", "same-origin");
        const response = await fetch(url, { ...init, headers });
        observeResponse?.(response);
        return response;
    };
}

/**
 * Creates a real tRPC EventSource client using one opaque bearer token.
 * @param server Running application server under test.
 * @param bearerToken Complete opaque automation token.
 * @param observeResponse Optional raw SSE response observer.
 * @returns A typed tRPC subscription client.
 */
export function createAutomationEventsClient(
    server: ApplicationServer,
    bearerToken: string,
    observeResponse?: (response: Response) => void
) {
    return createTRPCClient<AppRouter>({
        links: [
            httpSubscriptionLink({
                EventSource,
                eventSourceOptions: {
                    fetch: eventSourceFetchWithBearer(bearerToken, observeResponse),
                },
                transformer: superjson,
                url: new URL("/trpc", server.url).toString(),
            }),
        ],
    });
}

/**
 * Reads and closes one authorized tracked SSE subscription.
 * @param server Running application server under test.
 * @param bearerToken Complete opaque automation token.
 * @param topic Exact monitoring topic under test.
 * @param observeResponse Optional raw SSE response observer.
 * @returns The first validated tracked stream event.
 */
export async function firstAutomationStreamEvent(
    server: ApplicationServer,
    bearerToken: string,
    topic: (typeof monitoringRealtimeTopics)[keyof typeof monitoringRealtimeTopics],
    observeResponse?: (response: Response) => void
): Promise<RealtimeStreamOutput> {
    const outcome = Promise.withResolvers<RealtimeStreamOutput>();
    const subscription = createAutomationEventsClient(
        server,
        bearerToken,
        observeResponse
    ).events.stream.subscribe(
        { topics: [topic] },
        {
            onComplete: () =>
                outcome.reject(
                    new Error("Realtime subscription completed before one event")
                ),
            onData: outcome.resolve,
            onError: outcome.reject,
        }
    );

    try {
        return await withTestTimeout(
            outcome.promise,
            automationHttpSubscriptionTimeoutMs,
            "Authorized automation stream did not emit"
        );
    } finally {
        subscription.unsubscribe();
    }
}

/**
 * Reads and closes one rejected tracked SSE subscription.
 * @param server Running application server under test.
 * @param bearerToken Complete opaque automation token.
 * @param topic Exact monitoring topic under test.
 * @returns The client-visible subscription failure.
 */
export async function automationStreamFailure(
    server: ApplicationServer,
    bearerToken: string,
    topic: (typeof monitoringRealtimeTopics)[keyof typeof monitoringRealtimeTopics]
): Promise<Error> {
    const outcome = Promise.withResolvers<Error>();
    const subscription = createAutomationEventsClient(
        server,
        bearerToken
    ).events.stream.subscribe(
        { topics: [topic] },
        {
            onComplete: () =>
                outcome.reject(
                    new Error("Rejected realtime subscription completed without error")
                ),
            onData: () =>
                outcome.reject(new Error("Rejected realtime subscription emitted data")),
            onError: outcome.resolve,
        }
    );

    try {
        return await withTestTimeout(
            outcome.promise,
            automationHttpSubscriptionTimeoutMs,
            "Rejected automation stream did not fail"
        );
    } finally {
        subscription.unsubscribe();
    }
}

/**
 * Returns one valid delivery matching the first requested monitoring topic.
 * @param topics Topic filter supplied to the runtime test double.
 * @returns One matching asynchronous delivery.
 */
export function oneAutomationDeliveryForRequestedTopic(
    topics: readonly string[] | undefined
): AsyncIterable<RealtimeEventDelivery> {
    const delivery = topics?.includes(monitoringRealtimeTopics.notifications)
        ? notificationDelivery
        : automationHttpReportDelivery;
    return (async function* () {
        yield await Promise.resolve(delivery);
    })();
}
