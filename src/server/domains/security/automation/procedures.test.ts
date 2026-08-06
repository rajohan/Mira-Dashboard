import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { captureFailure } from "../../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestAutomationSecurityLifecycleService,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../../test/support/requestContext.ts";
import { appRouter } from "../../../trpc/appRouter.ts";
import type { AutomationSecurityLifecycleService } from "./lifecycle.ts";

const createdAtMs = 1_800_000_000_000;
const principalId = "openclaw-heartbeat";
const credentialId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const replacementCredentialId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";
const credentialPrefix = "a".repeat(32);
const replacementPrefix = "c".repeat(32);
const token = `${credentialPrefix}.${"b".repeat(64)}`;
const replacementToken = `${replacementPrefix}.${"d".repeat(64)}`;

const credential = {
    createdAtMs,
    id: credentialId,
    label: "Heartbeat caller",
    prefix: credentialPrefix,
};
const replacementCredential = {
    createdAtMs: createdAtMs + 1,
    id: replacementCredentialId,
    label: "Heartbeat replacement",
    prefix: replacementPrefix,
    replacesCredentialId: credentialId,
};
const revokedCredential = {
    ...credential,
    revokedAtMs: createdAtMs + 1,
};
const principal = {
    activeCredentialCount: 1,
    authorizationVersion: 1,
    capabilities: ["notifications:read", "reports:read"] as const,
    createdAtMs,
    disabled: false as const,
    id: principalId,
    label: "OpenClaw heartbeat",
    totalCredentialCount: 1,
    updatedAtMs: createdAtMs,
};
const disabledPrincipal = {
    ...principal,
    activeCredentialCount: 0,
    authorizationVersion: 2,
    disabled: true as const,
    disabledAtMs: createdAtMs + 2,
    updatedAtMs: createdAtMs + 2,
};
const createCredentialInput = {
    credential: { label: "Secondary credential" },
    expectedAuthorizationVersion: 1,
    principalId,
};

function successfulAutomationLifecycle(): AutomationSecurityLifecycleService {
    return createTestAutomationSecurityLifecycleService({
        createCredential: () => ({
            result: { credential, token },
            status: "created",
        }),
        createPrincipal: () => ({
            result: { credential, principal, token },
            status: "created",
        }),
        disablePrincipal: () => ({
            result: {
                changed: true,
                principal: disabledPrincipal,
                revokedCredentials: 1,
            },
            status: "disabled",
        }),
        listCredentials: () => ({
            result: {
                credentials: [credential],
                principalId,
                totalCredentialCount: 1,
            },
            status: "listed",
        }),
        listPrincipals: () => ({
            result: {
                activePrincipalCount: 1,
                principals: [principal],
                totalPrincipalCount: 1,
            },
            status: "listed",
        }),
        replaceCapabilities: () => ({
            result: { changed: false, principal },
            status: "replaced",
        }),
        revokeCredential: () => ({
            result: { credential: revokedCredential, revoked: true },
            status: "revoked",
        }),
        rotateCredential: () => ({
            result: {
                credential: replacementCredential,
                token: replacementToken,
            },
            status: "rotated",
        }),
    });
}

describe("automation-security procedures", () => {
    test("requires a browser session and never accepts an automation capability", async () => {
        for (const testCase of [
            { authentication: undefined, code: "UNAUTHORIZED" },
            {
                authentication: createTestAutomationAuthentication([
                    "notifications:read",
                    "reports:read",
                ]),
                code: "FORBIDDEN",
            },
        ] as const) {
            let lifecycleCalls = 0;
            const context = await createTestRequestContext(
                testCase.authentication,
                createTestApplicationRuntime(),
                {
                    automationSecurityLifecycle:
                        createTestAutomationSecurityLifecycleService({
                            listPrincipals: () => {
                                lifecycleCalls += 1;
                                return { status: "session-changed" };
                            },
                        }),
                }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).automationSecurity.listPrincipals({})
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
            expect(lifecycleCalls).toBe(0);
        }
    });

    test("returns every explicitly parsed lifecycle output", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            { automationSecurityLifecycle: successfulAutomationLifecycle() }
        );
        const caller = appRouter.createCaller(context).automationSecurity;

        expect(await caller.listPrincipals({})).toEqual({
            activePrincipalCount: 1,
            principals: [principal],
            totalPrincipalCount: 1,
        });
        expect(await caller.listCredentials({ principalId })).toEqual({
            credentials: [credential],
            principalId,
            totalCredentialCount: 1,
        });
        expect(
            await caller.createPrincipal({
                capabilities: ["notifications:read", "reports:read"],
                id: principalId,
                initialCredential: { label: credential.label },
                label: principal.label,
            })
        ).toEqual({ credential, principal, token });
        expect(await caller.createCredential(createCredentialInput)).toEqual({
            credential,
            token,
        });
        expect(
            await caller.rotateCredential({
                credentialId,
                expectedAuthorizationVersion: 1,
                principalId,
                replacement: { label: replacementCredential.label },
            })
        ).toEqual({ credential: replacementCredential, token: replacementToken });
        expect(
            await caller.revokeCredential({
                credentialId,
                expectedAuthorizationVersion: 1,
                principalId,
            })
        ).toEqual({ credential: revokedCredential, revoked: true });
        expect(
            await caller.replaceCapabilities({
                capabilities: ["notifications:read", "reports:read"],
                expectedAuthorizationVersion: 1,
                principalId,
            })
        ).toEqual({ changed: false, principal });
        expect(
            await caller.disablePrincipal({
                expectedAuthorizationVersion: 1,
                principalId,
            })
        ).toEqual({
            changed: true,
            principal: disabledPrincipal,
            revokedCredentials: 1,
        });
    });

    test.each([
        { code: "CONFLICT", status: "conflict" },
        { code: "PRECONDITION_FAILED", status: "invalid-expiry" },
        { code: "FORBIDDEN", status: "mfa-enrollment-required" },
        { code: "NOT_FOUND", status: "not-found" },
        { code: "UNAUTHORIZED", status: "session-changed" },
        { code: "FORBIDDEN", status: "step-up-required" },
        { code: "SERVICE_UNAVAILABLE", status: "unavailable" },
    ] as const)("maps $status to $code", async ({ code, status }) => {
        const responseHeaders = new Headers();
        const createCredential = (() => ({
            status,
        })) as unknown as AutomationSecurityLifecycleService["createCredential"];
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                automationSecurityLifecycle: createTestAutomationSecurityLifecycleService(
                    { createCredential }
                ),
                responseHeaders,
            }
        );
        const failure = await captureFailure(() =>
            appRouter
                .createCaller(context)
                .automationSecurity.createCredential(createCredentialInput)
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe(code);
        expect(responseHeaders.get("set-cookie")?.includes("Max-Age=0") ?? false).toBe(
            status === "session-changed"
        );
    });

    test.each([
        { reason: "mfa_enrollment_required", status: "mfa-enrollment-required" },
        { reason: "step_up_required", status: "step-up-required" },
    ] as const)("emits the allowlisted $reason reason", async ({ reason, status }) => {
        const createCredential = (() => ({
            status,
        })) as unknown as AutomationSecurityLifecycleService["createCredential"];
        const response = await fetchRequestHandler({
            createContext: () =>
                createTestRequestContext(
                    createTestSessionAuthentication([]),
                    createTestApplicationRuntime(),
                    {
                        automationSecurityLifecycle:
                            createTestAutomationSecurityLifecycleService({
                                createCredential,
                            }),
                    }
                ),
            endpoint: "/trpc",
            req: new Request(
                "http://localhost/trpc/automationSecurity.createCredential",
                {
                    body: JSON.stringify({ json: createCredentialInput }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }
            ),
            router: appRouter,
        });
        const text = await response.text();

        expect(response.status).toBe(403);
        expect(text).toContain(`"reason":"${reason}"`);
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("rejects malformed lifecycle output before returning it", async () => {
        const invalidListPrincipals = (() => ({
            result: {
                activePrincipalCount: 1,
                principals: [{ ...principal, capabilities: ["root:everything"] }],
                totalPrincipalCount: 1,
            },
            status: "listed",
        })) as unknown as AutomationSecurityLifecycleService["listPrincipals"];
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                automationSecurityLifecycle: createTestAutomationSecurityLifecycleService(
                    {
                        listPrincipals: invalidListPrincipals,
                    }
                ),
            }
        );
        const failure = await captureFailure(() =>
            appRouter.createCaller(context).automationSecurity.listPrincipals({})
        );

        expect(failure).toBeInstanceOf(Error);
    });
});
