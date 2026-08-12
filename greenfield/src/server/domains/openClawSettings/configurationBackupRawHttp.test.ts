import { describe, expect, test } from "bun:test";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import { createOpenClawConfigurationBackupRawHttpHandler } from "./configurationBackupRawHttp.ts";
import { createOpenClawConfigurationBackupTicketStore } from "./configurationBackupTickets.ts";

const origin = "https://dashboard.example.test";
const actor = Object.freeze({
    authenticatorId: "0".repeat(32),
    id: "019fe633-9133-7ba0-8b80-809dd80dfb40",
});
const sessionToken = `${"0".repeat(32)}.${"1".repeat(64)}`;
const ticketId = "10000000-0000-4000-8000-000000000001";
const bytes = new TextEncoder().encode('{"secret":"private"}\n');

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

function request(method: string, requestOrigin = origin): Request {
    return new Request(
        `${origin}/api/openclaw-settings/configuration-backups/${ticketId}`,
        {
            headers: {
                cookie: `${dashboardSessionCookieName}=${sessionToken}`,
                origin: requestOrigin,
                "sec-fetch-site": requestOrigin === origin ? "same-origin" : "cross-site",
            },
            method,
        }
    );
}

function fixture(
    authorization: "authorized" | "step-up-required" = "authorized",
    principalValue: AuthenticatedPrincipal = principal()
) {
    const tickets = createOpenClawConfigurationBackupTicketStore({
        generateId: () => ticketId,
        nowMs: () => 1000,
    });
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
});
