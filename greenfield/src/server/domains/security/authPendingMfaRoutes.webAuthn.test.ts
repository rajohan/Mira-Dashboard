import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import {
    webAuthnAuthenticationOptionsSchema,
    webAuthnCeremonyTimeoutMs,
} from "../../../contracts/webauthn.ts";
import { dashboardPendingLoginCookieName } from "../../rawHttp/authenticationCredentials.ts";
import { generateOpaqueToken } from "../../shared/opaqueToken.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestMfaLoginLifecycleService,
    createTestRequestContext,
    testSecurityUserId,
    testSessionSelector,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import {
    ceremonyFixtureChallenge,
    ceremonyFixtureCredentialId,
    ceremonyFixtureRpId,
    createAuthenticationFixture,
} from "./mfa/webauthn/testSupport/ceremonyFixture.ts";

const verifiedAtMs = 1_800_000_000_000;
const authenticationOptions = v.parse(webAuthnAuthenticationOptionsSchema, {
    allowCredentials: [
        {
            id: ceremonyFixtureCredentialId,
            transports: ["usb"],
            type: "public-key",
        },
    ],
    challenge: ceremonyFixtureChallenge,
    rpId: ceremonyFixtureRpId,
    timeout: webAuthnCeremonyTimeoutMs,
    userVerification: "required",
});
const authSession = Object.freeze({
    authenticatedAtMs: verifiedAtMs,
    authMethod: "webauthn" as const,
    createdAtMs: verifiedAtMs,
    expiresAtMs: verifiedAtMs + 2_592_000_000,
    id: testSessionSelector,
    isCurrent: true,
    lastSeenAtMs: verifiedAtMs,
});
const authUser = Object.freeze({
    id: testSecurityUserId,
    username: "operator",
});

function pendingLoginRequest(token: string): Request {
    return new Request("http://localhost/trpc/test", {
        headers: {
            cookie: `${dashboardPendingLoginCookieName}=${token}`,
        },
    });
}

describe("WebAuthn pending-login routes", () => {
    test("requires a syntactically valid pending-login cookie", async () => {
        let called = false;
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                mfaLoginLifecycle: createTestMfaLoginLifecycleService({
                    beginWebAuthnLogin: () => {
                        called = true;
                        return Promise.resolve({ status: "service-unavailable" });
                    },
                }),
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.beginWebAuthnLogin()
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(called).toBeFalse();
    });

    test("returns only validated assertion options", async () => {
        const pending = generateOpaqueToken("pending-login");
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                mfaLoginLifecycle: createTestMfaLoginLifecycleService({
                    beginWebAuthnLogin: () =>
                        Promise.resolve({
                            expiresAtMs: verifiedAtMs + 60_000,
                            options: authenticationOptions,
                            status: "created",
                        }),
                }),
                request: pendingLoginRequest(pending.token),
            }
        );

        expect(await appRouter.createCaller(context).auth.beginWebAuthnLogin()).toEqual({
            expiresAtMs: verifiedAtMs + 60_000,
            options: authenticationOptions,
        });
    });

    test("validates output before setting ordered session and pending clear cookies", async () => {
        const pending = generateOpaqueToken("pending-login");
        const session = generateOpaqueToken("session");
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                mfaLoginLifecycle: createTestMfaLoginLifecycleService({
                    completeWebAuthnLogin: () =>
                        Promise.resolve({
                            session: authSession,
                            status: "authenticated",
                            token: session.token,
                            user: authUser,
                        }),
                }),
                request: pendingLoginRequest(pending.token),
                responseHeaders,
            }
        );

        const result = await appRouter.createCaller(context).auth.loginWebAuthn({
            response: await createAuthenticationFixture({ counter: 1 }),
        });

        expect(result).toEqual({ session: authSession, user: authUser });
        expect(JSON.stringify(result)).not.toContain(session.token);
        const cookies = responseHeaders.getSetCookie();
        expect(cookies).toHaveLength(2);
        expect(cookies[0]).toContain(`__Host-mira_dashboard_session=${session.token}`);
        expect(cookies[0]).toContain("Secure; HttpOnly; SameSite=Strict");
        expect(cookies[1]).toContain(`${dashboardPendingLoginCookieName}=`);
        expect(cookies[1]).toContain("Max-Age=0");
    });

    test("maps work saturation without changing cookies", async () => {
        const pending = generateOpaqueToken("pending-login");
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            undefined,
            createTestApplicationRuntime(),
            {
                mfaLoginLifecycle: createTestMfaLoginLifecycleService({
                    completeWebAuthnLogin: () =>
                        Promise.resolve({
                            retryAfterSeconds: 9,
                            status: "rate-limited",
                        }),
                }),
                request: pendingLoginRequest(pending.token),
                responseHeaders,
            }
        );
        const response = await createAuthenticationFixture({ counter: 1 });

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).auth.loginWebAuthn({
                response,
            })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("TOO_MANY_REQUESTS");
        expect(responseHeaders.get("retry-after")).toBe("9");
        expect(responseHeaders.get("set-cookie")).toBeNull();
    });
});
