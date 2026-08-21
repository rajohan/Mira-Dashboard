import { afterEach, describe, expect, test } from "bun:test";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import type {
    OpenClawConfigurationBackupActor,
    OpenClawConfigurationBackupTicketStore,
} from "./configurationBackup.ts";
import { createOpenClawConfigurationBackupRawHttpHandler } from "./configurationBackupRawHttp.ts";
import { createOpenClawConfigurationBackupTicketStore } from "./configurationBackupTickets.ts";

const origin = "https://dashboard.example.test";
const actor = Object.freeze({
    authenticatorId: "0".repeat(32),
    id: "019fe633-9133-7ba0-8b80-809dd80dfb40",
});
const sessionToken = `${"0".repeat(32)}.${"1".repeat(64)}`;
const ticketId = "10000000-0000-4000-8000-000000000001";
const secondTicketId = "10000000-0000-4000-8000-000000000002";
const thirdTicketId = "10000000-0000-4000-8000-000000000003";
const bytes = new TextEncoder().encode('{"secret":"private"}\n');
const ticketStores: OpenClawConfigurationBackupTicketStore[] = [];

async function waitForResponseCleanup(): Promise<void> {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

function principal(
    overrides: Partial<AuthenticatedPrincipal> = {}
): AuthenticatedPrincipal {
    return {
        authorizationVersion: 1,
        authenticatorId: actor.authenticatorId,
        capabilities: ["openclaw-settings:write"],
        id: actor.id,
        kind: "session",
        ...overrides,
    };
}

function request(
    method: string,
    requestOrigin = origin,
    requestedTicketId = ticketId,
    signal?: AbortSignal
): Request {
    return new Request(
        `${origin}/api/openclaw-settings/configuration-backups/${requestedTicketId}`,
        {
            headers: {
                cookie: `${dashboardSessionCookieName}=${sessionToken}`,
                origin: requestOrigin,
                "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site",
            },
            method,
            signal,
        }
    );
}

function trackTicketStore<T extends OpenClawConfigurationBackupTicketStore>(store: T): T {
    ticketStores.push(store);
    return store;
}

function fixture(
    authorization: "authorized" | "session-changed" | "step-up-required" = "authorized",
    principalValue: AuthenticatedPrincipal = principal()
) {
    const tickets = trackTicketStore(
        createOpenClawConfigurationBackupTicketStore({
            generateId: () => ticketId,
            nowMs: () => 1000,
        })
    );
    tickets.issue(actor, bytes);
    const handler = createOpenClawConfigurationBackupRawHttpHandler({
        authenticateCredential: () => ({
            authentication: {
                kind: "authenticated" as const,
                principal: principalValue,
            },
            lease: {
                expiresAtMs: 4_000_000_000_000_000,
                revalidate: () => Promise.resolve(),
            },
        }),
        authorizeAccess: () => authorization,
        browserOrigin: origin,
        tickets,
    });
    return { handler, tickets };
}

async function response(
    fixtureValue: ReturnType<typeof fixture>,
    incoming: Request
): Promise<Response> {
    const result = await fixtureValue.handler(incoming, new URL(incoming.url));
    if (result === undefined) throw new Error("Expected backup handler response");
    return result;
}

afterEach(() => {
    for (const store of ticketStores.splice(0)) store.dispose();
});

describe("OpenClaw configuration export raw HTTP", () => {
    test("supports non-consuming HEAD and one same-origin authenticated GET", async () => {
        const value = fixture();
        const head = await response(value, request("HEAD"));
        expect(head.status).toBe(200);
        expect(head.headers.get("cache-control")).toBe("private, no-store");
        expect(head.headers.get("content-disposition")).toBe(
            'attachment; filename="openclaw.json"'
        );

        const downloaded = await response(value, request("GET"));
        expect(downloaded.status).toBe(200);
        expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
        const replay = await response(value, request("GET"));
        expect(replay.status).toBe(404);
    });

    test("rejects cross-origin, stale-MFA, automation, and unsupported methods", async () => {
        const crossOrigin = await response(
            fixture(),
            request("GET", "https://evil.example")
        );
        expect(crossOrigin.status).toBe(403);
        const staleMfa = await response(fixture("step-up-required"), request("GET"));
        expect(staleMfa.status).toBe(403);
        const automation = await response(
            fixture(
                "authorized",
                principal({
                    authenticatorId: "019fe633-9133-7ba0-8b80-809dd80dfb41",
                    kind: "automation",
                })
            ),
            request("GET")
        );
        expect(automation.status).toBe(403);
        const unsupported = await response(fixture(), request("POST"));
        expect(unsupported.status).toBe(405);
        expect(unsupported.headers.get("allow")).toBe("GET, HEAD");
    });

    test("clears the stale browser session cookie when recent-MFA sees a changed session", async () => {
        const staleSession = await response(fixture("session-changed"), request("GET"));

        expect(staleSession.status).toBe(401);
        expect(staleSession.headers.get("set-cookie")).toContain(
            `${dashboardSessionCookieName}=; Max-Age=0`
        );
    });

    test("holds bounded download admission and exact secret bytes through EOF or cancel", async () => {
        const ids = [ticketId, secondTicketId, thirdTicketId];
        const backingStore = trackTicketStore(
            createOpenClawConfigurationBackupTicketStore({
                generateId: () => ids.shift()!,
                nowMs: () => 1000,
            })
        );
        backingStore.issue(actor, bytes);
        backingStore.issue(actor, bytes);
        backingStore.issue(actor, bytes);
        const consumedBytes: Uint8Array[] = [];
        const tickets = trackTicketStore<OpenClawConfigurationBackupTicketStore>(
            Object.freeze({
                consume(
                    backupActor: OpenClawConfigurationBackupActor,
                    requestedTicketId: string
                ) {
                    const content = backingStore.consume(backupActor, requestedTicketId);
                    consumedBytes.push(content.bytes);
                    return content;
                },
                dispose: () => backingStore.dispose(),
                inspect: (
                    backupActor: OpenClawConfigurationBackupActor,
                    requestedTicketId: string
                ) => backingStore.inspect(backupActor, requestedTicketId),
                issue: (
                    backupActor: OpenClawConfigurationBackupActor,
                    sourceBytes: Uint8Array
                ) => backingStore.issue(backupActor, sourceBytes),
            })
        );
        const handler = createOpenClawConfigurationBackupRawHttpHandler({
            authenticateCredential: () => ({
                authentication: {
                    kind: "authenticated" as const,
                    principal: principal(),
                },
                lease: {
                    expiresAtMs: 4_000_000_000_000_000,
                    revalidate: () => Promise.resolve(),
                },
            }),
            authorizeAccess: () => "authorized",
            browserOrigin: origin,
            tickets,
            workLimits: {
                maximumConcurrentDownloads: 1,
                maximumInFlightBytes: bytes.byteLength * 3,
            },
        });
        const respond = async (incoming: Request): Promise<Response> => {
            const result = await handler(incoming, new URL(incoming.url));
            if (result === undefined) throw new Error("Expected backup response");
            return result;
        };

        const first = await respond(request("GET", origin, ticketId));
        expect(first.status).toBe(200);
        expect(consumedBytes[0]).toEqual(new Uint8Array(bytes.byteLength));
        const concurrentDenial = await respond(request("GET", origin, secondTicketId));
        expect(concurrentDenial.status).toBe(429);

        const firstReader = first.body!.getReader();
        const firstChunk = await firstReader.read();
        expect(firstChunk).toEqual({ done: false, value: bytes });
        expect(firstChunk.value).not.toBe(consumedBytes[0]);
        expect(consumedBytes[0]).toEqual(new Uint8Array(bytes.byteLength));
        const deliveryDenial = await respond(request("GET", origin, secondTicketId));
        expect(deliveryDenial.status).toBe(429);
        expect(await firstReader.read()).toEqual({ done: true, value: undefined });
        await waitForResponseCleanup();
        expect(consumedBytes[0]).toEqual(new Uint8Array(bytes.byteLength));

        const second = await respond(request("GET", origin, secondTicketId));
        expect(second.status).toBe(200);
        expect(consumedBytes[1]).toEqual(new Uint8Array(bytes.byteLength));
        await second.body!.cancel("test cancellation");
        expect(consumedBytes[1]).toEqual(new Uint8Array(bytes.byteLength));

        const third = await respond(request("GET", origin, thirdTicketId));
        expect(third.status).toBe(200);
        await third.body!.cancel("test cleanup");
        tickets.dispose();
    });

    test("enforces the aggregate in-flight byte budget without consuming denied tickets", async () => {
        const ids = [ticketId, secondTicketId];
        const tickets = trackTicketStore(
            createOpenClawConfigurationBackupTicketStore({
                generateId: () => ids.shift()!,
                nowMs: () => 1000,
            })
        );
        tickets.issue(actor, bytes);
        tickets.issue(actor, bytes);
        const handler = createOpenClawConfigurationBackupRawHttpHandler({
            authenticateCredential: () => ({
                authentication: {
                    kind: "authenticated" as const,
                    principal: principal(),
                },
                lease: {
                    expiresAtMs: 4_000_000_000_000_000,
                    revalidate: () => Promise.resolve(),
                },
            }),
            authorizeAccess: () => "authorized",
            browserOrigin: origin,
            tickets,
            workLimits: {
                maximumConcurrentDownloads: 2,
                maximumInFlightBytes: bytes.byteLength,
            },
        });
        const respond = async (requestedTicketId: string): Promise<Response> => {
            const incoming = request("GET", origin, requestedTicketId);
            const result = await handler(incoming, new URL(incoming.url));
            if (result === undefined) throw new Error("Expected backup response");
            return result;
        };

        const first = await respond(ticketId);
        const byteDenial = await respond(secondTicketId);
        expect(byteDenial.status).toBe(429);
        await first.arrayBuffer();
        await waitForResponseCleanup();
        const second = await respond(secondTicketId);
        expect(second.status).toBe(200);
        await second.body!.cancel("test cleanup");
        tickets.dispose();
    });

    test("erases both consumed and streamed copies when the request aborts", async () => {
        const backingStore = trackTicketStore(
            createOpenClawConfigurationBackupTicketStore({
                generateId: () => ticketId,
                nowMs: () => 1000,
            })
        );
        backingStore.issue(actor, bytes);
        let consumedBytes: Uint8Array | undefined;
        const tickets = trackTicketStore<OpenClawConfigurationBackupTicketStore>(
            Object.freeze({
                consume(
                    backupActor: OpenClawConfigurationBackupActor,
                    requestedTicketId: string
                ) {
                    const content = backingStore.consume(backupActor, requestedTicketId);
                    consumedBytes = content.bytes;
                    return content;
                },
                dispose: () => backingStore.dispose(),
                inspect: (
                    backupActor: OpenClawConfigurationBackupActor,
                    requestedTicketId: string
                ) => backingStore.inspect(backupActor, requestedTicketId),
                issue: (
                    backupActor: OpenClawConfigurationBackupActor,
                    sourceBytes: Uint8Array
                ) => backingStore.issue(backupActor, sourceBytes),
            })
        );
        const handler = createOpenClawConfigurationBackupRawHttpHandler({
            authenticateCredential: () => ({
                authentication: {
                    kind: "authenticated" as const,
                    principal: principal(),
                },
                lease: {
                    expiresAtMs: 4_000_000_000_000_000,
                    revalidate: () => Promise.resolve(),
                },
            }),
            authorizeAccess: () => "authorized",
            browserOrigin: origin,
            tickets,
        });
        const controller = new AbortController();
        const incoming = request("GET", origin, ticketId, controller.signal);
        const result = await handler(incoming, new URL(incoming.url));
        if (result === undefined) throw new Error("Expected backup response");
        expect(result.status).toBe(200);
        expect(consumedBytes).toEqual(new Uint8Array(bytes.byteLength));

        const reader = result.body!.getReader();
        const first = await reader.read();
        expect(first).toEqual({ done: false, value: bytes });
        const streamedValue: unknown = first.value;
        if (!(streamedValue instanceof Uint8Array)) {
            throw new TypeError("Expected streamed backup bytes");
        }
        controller.abort(new DOMException("test abort", "AbortError"));
        expect(await reader.read().catch((error: unknown) => error)).toBeInstanceOf(
            DOMException
        );
        expect(streamedValue).toEqual(new Uint8Array(bytes.byteLength));
        expect(consumedBytes).toEqual(new Uint8Array(bytes.byteLength));
    });
});
