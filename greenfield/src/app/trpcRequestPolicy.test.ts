import { describe, expect, test } from "bun:test";

import {
    authenticationHandlerIdleTimeoutSeconds,
    authenticationRequestBodyMaximumBytes,
    isTrpcRequestPath,
    readTrpcRequestPolicy,
    trpcRequestBodyMaximumBytes,
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
        expect(policy("/trpc/events.stream")).toEqual({
            handlerIdleTimeoutSeconds: 0,
            rejectsBatch: false,
            requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
        });
        expect(policy("/trpc/system.runtimeIdentity")).toEqual({
            rejectsBatch: false,
            requestBodyMaximumBytes: trpcRequestBodyMaximumBytes,
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

    test("fails closed for malformed and encoded authentication paths", () => {
        for (const path of [
            "/trpc/auth.login%?batch=1",
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
