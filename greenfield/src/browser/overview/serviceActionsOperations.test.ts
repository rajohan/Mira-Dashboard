import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    authenticatedServiceActionIdentity,
    clearServiceActionRecovery,
    readOrCreateServiceActionIdempotencyKey,
    serviceActionPresentations,
    serviceActionRecoveryExists,
    serviceActionRequestInput,
} from "./serviceActionsOperations.ts";

const timestampMs = 1_800_000_000_000;

function authenticatedStatus(userId: string, sessionId: string): AuthStatus {
    return {
        session: {
            authenticatedAtMs: timestampMs,
            authMethod: "password",
            createdAtMs: timestampMs,
            expiresAtMs: timestampMs + 86_400_000,
            id: sessionId,
            isCurrent: true,
            lastSeenAtMs: timestampMs,
        },
        state: "authenticated",
        user: { id: userId, username: "operator" },
    };
}

afterEach(() => {
    globalThis.sessionStorage.clear();
});

describe("service action browser operations", () => {
    test("binds recovery keys to the exact user, session, and action", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            authStatusQueryKey,
            authenticatedStatus("019fd974-54a2-74dd-a64b-d4186f8d8828", "a".repeat(32))
        );
        const firstIdentity = authenticatedServiceActionIdentity(queryClient);
        expect(firstIdentity).toBe(
            `authenticated:019fd974-54a2-74dd-a64b-d4186f8d8828:${"a".repeat(32)}`
        );
        const cleanupKey = readOrCreateServiceActionIdempotencyKey(
            firstIdentity!,
            "openclaw-cleanup"
        );
        const updateKey = readOrCreateServiceActionIdempotencyKey(
            firstIdentity!,
            "system-update"
        );
        expect(cleanupKey).toMatch(/^[0-9a-f]{32}$/u);
        expect(updateKey).toMatch(/^[0-9a-f]{32}$/u);
        expect(updateKey).not.toBe(cleanupKey);

        queryClient.setQueryData(
            authStatusQueryKey,
            authenticatedStatus("019fd974-54a2-74dd-a64b-d4186f8d8828", "b".repeat(32))
        );
        const secondIdentity = authenticatedServiceActionIdentity(queryClient)!;
        const secondCleanupKey = readOrCreateServiceActionIdempotencyKey(
            secondIdentity,
            "openclaw-cleanup"
        );
        expect(secondCleanupKey).not.toBe(cleanupKey);
        expect(serviceActionRecoveryExists(firstIdentity, "openclaw-cleanup")).toBe(true);
        expect(serviceActionRecoveryExists(secondIdentity, "openclaw-cleanup")).toBe(
            true
        );
        expect(clearServiceActionRecovery(firstIdentity!, "openclaw-cleanup")).toBe(true);
        expect(serviceActionRecoveryExists(firstIdentity, "openclaw-cleanup")).toBe(
            false
        );
        expect(serviceActionRecoveryExists(secondIdentity, "openclaw-cleanup")).toBe(
            true
        );
        queryClient.clear();
    });

    test("builds only the four exact confirmation inputs", () => {
        const idempotencyKey = "a".repeat(32);
        expect(serviceActionRequestInput("openclaw-cleanup", idempotencyKey)).toEqual({
            actionId: "openclaw-cleanup",
            confirmation: "cleanup-openclaw",
            idempotencyKey,
        });
        expect(serviceActionRequestInput("openclaw-update", idempotencyKey)).toEqual({
            actionId: "openclaw-update",
            confirmation: "update-openclaw",
            idempotencyKey,
        });
        expect(serviceActionRequestInput("system-restart", idempotencyKey)).toEqual({
            actionId: "system-restart",
            confirmation: "restart-system",
            idempotencyKey,
        });
        expect(serviceActionRequestInput("system-update", idempotencyKey)).toEqual({
            actionId: "system-update",
            confirmation: "update-system",
            idempotencyKey,
        });
    });

    test("keeps explicit retry labels for every fixed action", () => {
        expect(
            Object.fromEntries(
                Object.entries(serviceActionPresentations).map(([id, presentation]) => [
                    id,
                    presentation.retryLabel,
                ])
            )
        ).toEqual({
            "openclaw-cleanup": "Retry OpenClaw cleanup request",
            "openclaw-update": "Retry OpenClaw update request",
            "system-restart": "Retry system restart request",
            "system-update": "Retry system update request",
        });
    });
});
