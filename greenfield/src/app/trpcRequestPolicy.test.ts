import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { confirmWebAuthnEnrollmentInputSchema } from "../contracts/accountSecurity.ts";
import {
    taskAutomationScheduleSummaryMaximumLength,
    taskAutomationTextMaximumLength,
    taskBodyMaximumLength,
    taskLabelMaximumLength,
    taskMaximumLabels,
    taskProgressMaximumLength,
    taskTitleMaximumLength,
} from "../contracts/taskModel.ts";
import {
    createTaskInputSchema,
    updateTaskInputSchema,
    updateTaskProgressInputSchema,
} from "../contracts/tasks.ts";
import {
    webAuthnAttestationObjectMaximumLength,
    webAuthnAuthenticatorDataMaximumLength,
    webAuthnClientDataMaximumLength,
    webAuthnCredentialIdMaximumLength,
    webAuthnPublicKeyMaximumLength,
    webAuthnSupportedAlgorithm,
    webAuthnTransports,
} from "../contracts/webauthn.ts";
import {
    authenticationHandlerIdleTimeoutSeconds,
    authenticationRequestBodyMaximumBytes,
    isTrpcRequestPath,
    readTrpcRequestPolicy,
    serverRequestBodyMaximumBytes,
    taskContentRequestBodyMaximumBytes,
    taskProgressRequestBodyMaximumBytes,
    trpcRequestBodyMaximumBytes,
    webAuthnRequestBodyMaximumBytes,
} from "./trpcRequestPolicy.ts";

function policy(path: string) {
    return readTrpcRequestPolicy(new URL(path, "https://dashboard.example"));
}

describe("tRPC request policy", () => {
    test("selects exact registered body, timeout, and batching policies", () => {
        expect(policy("/trpc/auth.status?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: false,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/auth.login?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: true,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/automationSecurity.listPrincipals?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: false,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/automationSecurity.createPrincipal?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: true,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/auth.loginWebAuthn")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: false,
            requestBodyMaximumBytes: webAuthnRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/accountSecurity.stepUpWebAuthn")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: false,
            requestBodyMaximumBytes: webAuthnRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/accountSecurity.confirmWebAuthnEnrollment")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: false,
            requestBodyMaximumBytes: webAuthnRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/events.stream")).toEqual({
            handlerIdleTimeoutSeconds: 0,
            rejectsBatch: false,
            requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/system.runtimeIdentity")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/tasks.create")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: taskContentRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/tasks.update")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: taskContentRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/tasks.assign")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/tasks.addUpdate")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: taskProgressRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/tasks.updateProgress")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: taskProgressRequestBodyMaximumBytes,
        });
    });

    test("combines mixed batches using the strictest applicable policies", () => {
        expect(policy("/trpc/auth.status,auth.login?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: true,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/events.stream,auth.status?batch=1")).toEqual({
            handlerIdleTimeoutSeconds: 0,
            rejectsBatch: false,
            requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
        });
        expect(
            policy("/trpc/auth.status,accountSecurity.confirmWebAuthnEnrollment?batch=1")
        ).toEqual({
            handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
            rejectsBatch: true,
            requestBodyMaximumBytes: webAuthnRequestBodyMaximumBytes,
        });
    });

    test("fits the largest accepted WebAuthn enrollment inside its exact budget", () => {
        const credentialId = "A".repeat(webAuthnCredentialIdMaximumLength);
        const input = v.parse(confirmWebAuthnEnrollmentInputSchema, {
            response: {
                authenticatorAttachment: "cross-platform",
                clientExtensionResults: { credProps: { rk: true } },
                id: credentialId,
                rawId: credentialId,
                response: {
                    attestationObject: "A".repeat(webAuthnAttestationObjectMaximumLength),
                    authenticatorData: "A".repeat(webAuthnAuthenticatorDataMaximumLength),
                    clientDataJSON: "A".repeat(webAuthnClientDataMaximumLength),
                    publicKey: "A".repeat(webAuthnPublicKeyMaximumLength * 2),
                    publicKeyAlgorithm: webAuthnSupportedAlgorithm,
                    transports: [...webAuthnTransports],
                },
                type: "public-key",
            },
        });
        const encodedBytes = Buffer.byteLength(JSON.stringify({ json: input }));

        expect(encodedBytes).toBeGreaterThan(authenticationRequestBodyMaximumBytes);
        expect(encodedBytes).toBeLessThan(webAuthnRequestBodyMaximumBytes);
    });

    test("fits the largest canonical task content requests inside their budget", () => {
        const firstSurrogateCodePoint = 55_296;
        const jsonExpandingCodePoint = "\uD800";
        const maximumLabels = Array.from({ length: taskMaximumLabels }, (_, index) =>
            String.fromCodePoint(firstSurrogateCodePoint + index).repeat(
                taskLabelMaximumLength
            )
        );
        const maximumTaskContent = {
            automation: {
                cronJobId: jsonExpandingCodePoint.repeat(taskAutomationTextMaximumLength),
                kind: "openclaw-cron",
                model: jsonExpandingCodePoint.repeat(taskAutomationTextMaximumLength),
                recurring: false,
                scheduleSummary: jsonExpandingCodePoint.repeat(
                    taskAutomationScheduleSummaryMaximumLength
                ),
                sessionTarget: jsonExpandingCodePoint.repeat(
                    taskAutomationTextMaximumLength
                ),
                thinking: jsonExpandingCodePoint.repeat(taskAutomationTextMaximumLength),
            },
            bodyMarkdown: jsonExpandingCodePoint.repeat(taskBodyMaximumLength),
            labels: maximumLabels,
            priority: "medium",
            title: jsonExpandingCodePoint.repeat(taskTitleMaximumLength),
        } as const;
        const createInput = v.parse(createTaskInputSchema, {
            ...maximumTaskContent,
            assignee: "mira-2026",
            status: "in-progress",
        });
        const updateInput = v.parse(updateTaskInputSchema, {
            expectedVersion: Number.MAX_SAFE_INTEGER,
            id: "019fd300-0000-7000-8000-000000000001",
            patch: maximumTaskContent,
        });
        const encodedBytes = [createInput, updateInput].map((input) =>
            Buffer.byteLength(JSON.stringify({ json: input }))
        );

        expect(encodedBytes).toEqual([617_232, 617_275]);
        expect(Math.min(...encodedBytes)).toBeGreaterThan(trpcRequestBodyMaximumBytes);
        expect(Math.max(...encodedBytes)).toBeLessThan(
            taskContentRequestBodyMaximumBytes
        );
        expect(taskContentRequestBodyMaximumBytes).toBe(serverRequestBodyMaximumBytes);
    });

    test("fits the largest canonical progress update inside its exact budget", () => {
        const input = v.parse(updateTaskProgressInputSchema, {
            expectedVersion: Number.MAX_SAFE_INTEGER,
            messageMarkdown: "\u0001".repeat(taskProgressMaximumLength),
            taskId: "019fd300-0000-7000-8000-000000000001",
            updateId: "019fd300-0000-7000-8000-000000000002",
        });
        const encodedBytes = Buffer.byteLength(JSON.stringify({ json: input }));

        expect(encodedBytes).toBe(120_164);
        expect(encodedBytes).toBeGreaterThan(trpcRequestBodyMaximumBytes);
        expect(encodedBytes).toBeLessThan(taskProgressRequestBodyMaximumBytes);
        expect(taskProgressRequestBodyMaximumBytes).toBeLessThan(
            taskContentRequestBodyMaximumBytes
        );
    });

    test("fails closed for unknown names in registered authentication namespaces", () => {
        for (const path of [
            "/trpc/auth.future?batch=1",
            "/trpc/auth.statusExtra?batch=1",
            "/trpc/accountSecurity.future?batch=1",
            "/trpc/automationSecurity.future?batch=1",
        ]) {
            expect(policy(path)).toEqual({
                handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
                rejectsBatch: true,
                requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
            });
        }
    });

    test("keeps unknown and malformed task procedures on the default budget", () => {
        for (const path of [
            "/trpc/tasks.future",
            "/trpc/tasks.createExtra",
            "/trpc/tasks.create,unknown.future",
            "/trpc/tasks.updateProgress,unknown.future",
            "/trpc/tasks.create%2F",
            "/trpc/tasks.create///",
            "/trpc/tasks%2Ecreate%",
        ]) {
            expect(policy(path)).toEqual({
                rejectsBatch: false,
                requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
            });
        }
    });

    test("fails closed for malformed and encoded authentication paths", () => {
        for (const path of [
            "/trpc/auth.login%?batch=1",
            "/trpc/%61uth.login%?batch=1",
            "/trpc/a%75th.login%?batch=1",
            "/trpc/auth%2Elogin%?batch=1",
            "/trpc/system.runtimeIdentity%2Cauth.login%?batch=1",
            "/trpc/ACCOUNTSECURITY%2EstepUpTotp%?batch=1",
            "/trpc/AUTOMATIONSECURITY%2EcreatePrincipal%?batch=1",
        ]) {
            expect(policy(path)).toEqual({
                handlerIdleTimeoutSeconds: authenticationHandlerIdleTimeoutSeconds,
                rejectsBatch: true,
                requestBodyMaximumBytes: authenticationRequestBodyMaximumBytes,
            });
        }
    });

    test("matches only the exact tRPC mount", () => {
        expect(isTrpcRequestPath("/trpc")).toBeTrue();
        expect(isTrpcRequestPath("/trpc/auth.status")).toBeTrue();
        expect(isTrpcRequestPath("/trpc-unrelated")).toBeFalse();
    });
});
