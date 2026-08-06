import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    activeAutomationCredentialMaximumPerPrincipal,
    activeAutomationPrincipalMaximum,
    automationSecurityPageDefault,
    automationSecurityPageMaximum,
    automationSecurityProcedureContracts,
    createAutomationCredentialInputSchema,
    createAutomationCredentialResultSchema,
    createAutomationPrincipalInputSchema,
    createAutomationPrincipalResultSchema,
    disableAutomationPrincipalInputSchema,
    disableAutomationPrincipalResultSchema,
    listAutomationCredentialsInputSchema,
    listAutomationCredentialsResultSchema,
    listAutomationPrincipalsInputSchema,
    listAutomationPrincipalsResultSchema,
    replaceAutomationCapabilitiesInputSchema,
    replaceAutomationCapabilitiesResultSchema,
    revokeAutomationCredentialResultSchema,
    rotateAutomationCredentialInputSchema,
    rotateAutomationCredentialResultSchema,
} from "./automationSecurity.ts";
import { procedureContracts } from "./contractRegistry.ts";

const createdAtMs = 1_800_000_000_000;
const principalId = "openclaw-heartbeat";
const credentialId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const replacementCredentialId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";
const prefix = "a".repeat(32);
const replacementPrefix = "c".repeat(32);
const token = `${prefix}.${"b".repeat(64)}`;
const replacementToken = `${replacementPrefix}.${"d".repeat(64)}`;

const credential = {
    createdAtMs,
    id: credentialId,
    label: "Heartbeat caller",
    prefix,
};

const replacementCredential = {
    createdAtMs: createdAtMs + 1,
    id: replacementCredentialId,
    label: "Heartbeat caller replacement",
    prefix: replacementPrefix,
    replacesCredentialId: credentialId,
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

describe("automation-security contracts", () => {
    test("accepts strict creation input and canonicalizes unique capabilities", () => {
        const parsed = v.parse(createAutomationPrincipalInputSchema, {
            capabilities: ["reports:read", "notifications:read"],
            id: principalId,
            initialCredential: {
                expiresAtMs: createdAtMs + 86_400_000,
                label: "😀".repeat(128),
            },
            label: "OpenClaw heartbeat",
        });

        expect(parsed.capabilities).toEqual(["notifications:read", "reports:read"]);
        expect(Object.isFrozen(parsed.capabilities)).toBe(true);
        expect(
            v.parse(createAutomationPrincipalInputSchema, {
                capabilities: [],
                id: "agent-1",
                initialCredential: { label: "Initial credential" },
                label: "Least privilege",
            }).capabilities
        ).toEqual([]);

        for (const invalidLabel of [
            " ",
            "line\nbreak",
            "unsafe\u061Clabel",
            "unsafe\u200Blabel",
            "😀".repeat(129),
        ]) {
            expect(() =>
                v.parse(createAutomationPrincipalInputSchema, {
                    capabilities: [],
                    id: principalId,
                    initialCredential: { label: "Initial credential" },
                    label: invalidLabel,
                })
            ).toThrow();
        }
        expect(() =>
            v.parse(createAutomationPrincipalInputSchema, {
                capabilities: ["reports:read", "reports:read"],
                id: principalId,
                initialCredential: { label: "Initial credential" },
                label: "Duplicate grants",
            })
        ).toThrow();
        expect(() =>
            v.parse(createAutomationPrincipalInputSchema, {
                capabilities: [],
                id: principalId,
                initialCredential: { label: "Initial credential" },
                label: "Unknown field",
                unexpected: true,
            })
        ).toThrow();
    });

    test("returns a principal, explicit credential binding, and exact one-time token", () => {
        expect(
            v.parse(createAutomationPrincipalResultSchema, {
                credential,
                principal,
                token,
            })
        ).toEqual({ credential, principal, token });

        for (const invalidToken of [
            token.toUpperCase(),
            ` ${token}`,
            token.replace(".", "-"),
            `${"e".repeat(32)}.${"b".repeat(64)}`,
        ]) {
            expect(() =>
                v.parse(createAutomationPrincipalResultSchema, {
                    credential,
                    principal,
                    token: invalidToken,
                })
            ).toThrow();
        }
        expect(() =>
            v.parse(createAutomationPrincipalResultSchema, {
                credential: { ...credential, validatorHash: "f".repeat(64) },
                principal,
                token,
            })
        ).toThrow();
    });

    test("validates principal timestamp, disabled-state, and credential-count invariants", () => {
        const disabledPrincipal = {
            ...principal,
            activeCredentialCount: 0,
            authorizationVersion: 2,
            disabled: true as const,
            disabledAtMs: createdAtMs + 2,
            updatedAtMs: createdAtMs + 2,
        };
        expect(
            v.parse(disableAutomationPrincipalResultSchema, {
                changed: true,
                principal: disabledPrincipal,
                revokedCredentials: activeAutomationCredentialMaximumPerPrincipal + 1,
            }).principal.disabled
        ).toBe(true);
        expect(
            v.parse(disableAutomationPrincipalResultSchema, {
                changed: false,
                principal: disabledPrincipal,
                revokedCredentials: 0,
            }).changed
        ).toBe(false);

        for (const invalidPrincipal of [
            { ...principal, activeCredentialCount: 2 },
            {
                ...principal,
                activeCredentialCount: activeAutomationCredentialMaximumPerPrincipal + 1,
                totalCredentialCount: activeAutomationCredentialMaximumPerPrincipal + 1,
            },
            { ...principal, updatedAtMs: createdAtMs - 1 },
            { ...disabledPrincipal, activeCredentialCount: 1 },
            { ...disabledPrincipal, disabledAtMs: createdAtMs - 1 },
        ]) {
            expect(() =>
                v.parse(listAutomationPrincipalsResultSchema, {
                    activePrincipalCount: invalidPrincipal.disabled ? 0 : 1,
                    principals: [invalidPrincipal],
                    totalPrincipalCount: 1,
                })
            ).toThrow();
        }
        expect(() =>
            v.parse(disableAutomationPrincipalResultSchema, {
                changed: true,
                principal,
                revokedCredentials: 1,
            })
        ).toThrow();
        expect(() =>
            v.parse(disableAutomationPrincipalResultSchema, {
                changed: false,
                principal: disabledPrincipal,
                revokedCredentials: 1,
            })
        ).toThrow();
    });

    test("paginates principals with stable composite cursors and bounded output", () => {
        expect(v.parse(listAutomationPrincipalsInputSchema, {})).toEqual({
            limit: automationSecurityPageDefault,
        });
        expect(
            v.parse(listAutomationPrincipalsInputSchema, {
                cursor: { createdAtMs, id: principalId },
                limit: automationSecurityPageMaximum,
            })
        ).toEqual({
            cursor: { createdAtMs, id: principalId },
            limit: automationSecurityPageMaximum,
        });

        const secondPrincipal = {
            ...principal,
            createdAtMs: createdAtMs + 1,
            id: "openclaw-task-tracking",
            updatedAtMs: createdAtMs + 1,
        };
        expect(
            v.parse(listAutomationPrincipalsResultSchema, {
                activePrincipalCount: 2,
                nextCursor: {
                    createdAtMs: principal.createdAtMs,
                    id: principal.id,
                },
                principals: [secondPrincipal, principal],
                totalPrincipalCount: 2,
            }).principals
        ).toHaveLength(2);

        for (const invalid of [
            {
                activePrincipalCount: 2,
                principals: [principal, secondPrincipal],
                totalPrincipalCount: 2,
            },
            {
                activePrincipalCount: 2,
                nextCursor: { createdAtMs, id: "wrong-principal" },
                principals: [secondPrincipal, principal],
                totalPrincipalCount: 2,
            },
            {
                activePrincipalCount: activeAutomationPrincipalMaximum + 1,
                principals: [principal],
                totalPrincipalCount: activeAutomationPrincipalMaximum + 1,
            },
            {
                activePrincipalCount: 1,
                principals: Array.from(
                    { length: automationSecurityPageMaximum + 1 },
                    (_, index) => ({
                        ...principal,
                        createdAtMs: createdAtMs + automationSecurityPageMaximum - index,
                        id: `principal-${String(index).padStart(2, "0")}`,
                        updatedAtMs: createdAtMs + automationSecurityPageMaximum - index,
                    })
                ),
                totalPrincipalCount: automationSecurityPageMaximum + 1,
            },
        ]) {
            expect(() =>
                v.parse(listAutomationPrincipalsResultSchema, invalid)
            ).toThrow();
        }
        for (const invalidInput of [
            { limit: 0 },
            { limit: automationSecurityPageMaximum + 1 },
            { unexpected: true },
        ]) {
            expect(() =>
                v.parse(listAutomationPrincipalsInputSchema, invalidInput)
            ).toThrow();
        }
    });

    test("paginates complete non-secret credential history without a lifetime cap", () => {
        expect(v.parse(listAutomationCredentialsInputSchema, { principalId })).toEqual({
            limit: automationSecurityPageDefault,
            principalId,
        });

        const parsed = v.parse(listAutomationCredentialsResultSchema, {
            credentials: [replacementCredential, credential],
            nextCursor: {
                createdAtMs: credential.createdAtMs,
                id: credential.id,
            },
            principalId,
            totalCredentialCount: 500,
        });
        expect(parsed.totalCredentialCount).toBe(500);
        expect(parsed.credentials[0]?.replacesCredentialId).toBe(credentialId);
        expect(parsed.credentials[0]).not.toHaveProperty("lastUsedAtMs");
        expect(parsed.credentials[0]).not.toHaveProperty("validatorHash");
        expect(parsed.credentials[0]).not.toHaveProperty("token");

        for (const invalid of [
            {
                credentials: [credential, replacementCredential],
                principalId,
                totalCredentialCount: 2,
            },
            {
                credentials: [replacementCredential, credential],
                nextCursor: {
                    createdAtMs: replacementCredential.createdAtMs,
                    id: replacementCredential.id,
                },
                principalId,
                totalCredentialCount: 2,
            },
            {
                credentials: [replacementCredential, credential],
                principalId,
                totalCredentialCount: 1,
            },
        ]) {
            expect(() =>
                v.parse(listAutomationCredentialsResultSchema, invalid)
            ).toThrow();
        }
    });

    test("enforces credential time ordering and replacement identity", () => {
        for (const invalidCredential of [
            { ...credential, expiresAtMs: createdAtMs },
            { ...credential, revokedAtMs: createdAtMs - 1 },
            { ...credential, replacesCredentialId: credentialId },
            { ...credential, lastUsedAtMs: createdAtMs },
        ]) {
            expect(() =>
                v.parse(listAutomationCredentialsResultSchema, {
                    credentials: [invalidCredential],
                    principalId,
                    totalCredentialCount: 1,
                })
            ).toThrow();
        }
    });

    test("models explicit staged rotation and later revocation", () => {
        const mutationBase = {
            expectedAuthorizationVersion: 1,
            principalId,
        };
        expect(
            v.parse(createAutomationCredentialInputSchema, {
                ...mutationBase,
                credential: { label: "Additional caller" },
            })
        ).toEqual({
            ...mutationBase,
            credential: { label: "Additional caller" },
        });
        expect(
            v.parse(rotateAutomationCredentialInputSchema, {
                ...mutationBase,
                credentialId,
                replacement: { label: "Staged replacement" },
            }).credentialId
        ).toBe(credentialId);

        expect(
            v.parse(createAutomationCredentialResultSchema, { credential, token })
                .credential.replacesCredentialId
        ).toBeUndefined();
        expect(
            v.parse(rotateAutomationCredentialResultSchema, {
                credential: replacementCredential,
                token: replacementToken,
            }).credential
        ).toEqual(replacementCredential);
        expect(() =>
            v.parse(rotateAutomationCredentialResultSchema, { credential, token })
        ).toThrow();
        expect(() =>
            v.parse(createAutomationCredentialResultSchema, {
                credential: replacementCredential,
                token: replacementToken,
            })
        ).toThrow();

        const revokedCredential = { ...credential, revokedAtMs: createdAtMs + 2 };
        expect(
            v.parse(revokeAutomationCredentialResultSchema, {
                credential: revokedCredential,
                revoked: true,
            }).credential.revokedAtMs
        ).toBe(createdAtMs + 2);
        expect(
            v.parse(revokeAutomationCredentialResultSchema, {
                credential: revokedCredential,
                revoked: false,
            }).revoked
        ).toBe(false);
        expect(() =>
            v.parse(revokeAutomationCredentialResultSchema, {
                credential,
                revoked: true,
            })
        ).toThrow();
    });

    test("requires optimistic principal state for every existing-principal mutation", () => {
        expect(
            v.parse(replaceAutomationCapabilitiesInputSchema, {
                capabilities: ["reports:read", "notifications:read"],
                expectedAuthorizationVersion: 3,
                principalId,
            })
        ).toEqual({
            capabilities: ["notifications:read", "reports:read"],
            expectedAuthorizationVersion: 3,
            principalId,
        });
        expect(
            v.parse(disableAutomationPrincipalInputSchema, {
                expectedAuthorizationVersion: 3,
                principalId,
            })
        ).toEqual({ expectedAuthorizationVersion: 3, principalId });
        expect(
            v.parse(replaceAutomationCapabilitiesResultSchema, {
                changed: false,
                principal,
            }).changed
        ).toBe(false);

        for (const schema of [
            createAutomationCredentialInputSchema,
            rotateAutomationCredentialInputSchema,
            disableAutomationPrincipalInputSchema,
            replaceAutomationCapabilitiesInputSchema,
        ]) {
            expect(() =>
                v.parse(schema, {
                    capabilities: [],
                    credential: { label: "Credential" },
                    credentialId,
                    principalId,
                    replacement: { label: "Replacement" },
                })
            ).toThrow();
        }
    });

    test("registers exactly eight procedures with session-only assurance metadata", () => {
        const names = automationSecurityProcedureContracts.map(({ name }) => name);
        expect(names).toEqual([
            "automationSecurity.listPrincipals",
            "automationSecurity.listCredentials",
            "automationSecurity.createPrincipal",
            "automationSecurity.createCredential",
            "automationSecurity.rotateCredential",
            "automationSecurity.revokeCredential",
            "automationSecurity.replaceCapabilities",
            "automationSecurity.disablePrincipal",
        ]);
        expect(
            procedureContracts
                .filter(({ domain }) => domain === "automation-security")
                .map(({ name }) => name)
        ).toEqual(names);

        for (const contract of automationSecurityProcedureContracts.slice(0, 2)) {
            expect(contract.kind).toBe("query");
            expect(contract.access).toEqual({
                capabilities: [],
                capabilityPolicy: "all",
                kind: "authenticated",
                principalKinds: ["session"],
            });
            expect(contract.transport).toEqual({
                batching: "adapter-default",
                handler: "authentication",
                requestBody: "authentication",
            });
        }

        for (const contract of automationSecurityProcedureContracts.slice(2)) {
            expect(contract.kind).toBe("mutation");
            expect(contract.access).toEqual({
                kind: "recent-auth",
                whenMfaDisabled: "deny",
                whenMfaEnabled: "mfa",
            });
            expect(
                "errorReasons" in contract ? contract.errorReasons : undefined
            ).toEqual(["mfa_enrollment_required", "step_up_required"]);
            expect(contract.transport).toEqual({
                batching: "forbidden",
                handler: "authentication",
                requestBody: "authentication",
            });
        }

        const documentedErrors = new Set(
            automationSecurityProcedureContracts.flatMap(({ errors }) => errors)
        );
        for (const error of [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "PRECONDITION_FAILED",
            "UNAUTHORIZED",
        ] as const) {
            expect(documentedErrors.has(error)).toBe(true);
        }
    });
});
