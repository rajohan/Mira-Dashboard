import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { KopiaBackupStatus } from "../../contracts/backups.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    authenticatedBackupIdentity,
    backupRequestFingerprint,
    clearBackupRecovery,
    readOrCreateBackupIdempotencyKey,
} from "./backupOperations.ts";

const nowMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const runId = "019fe200-0000-7000-8000-000000000001";
const status = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 1,
        healthy: true,
        observedAtMs: nowMs,
        providerIdle: true,
        sourceRevision,
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: nowMs,
                snapshots: [{ completedAtMs: nowMs, retentionReasons: ["daily-1"] }],
                snapshotCount: 1,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus);

afterEach(() => globalThis.sessionStorage.clear());

describe("backup browser recovery", () => {
    test("binds recovery to identity and exact request fingerprint", () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(authStatusQueryKey, {
            session: {
                authenticatedAtMs: nowMs,
                authMethod: "password",
                createdAtMs: nowMs,
                expiresAtMs: nowMs + 1000,
                id: "b".repeat(32),
                isCurrent: true,
                lastSeenAtMs: nowMs,
            },
            state: "authenticated",
            user: {
                id: "019fe200-0000-7000-8000-000000000002",
                email: "operator@example.com",
                username: "operator",
            },
        } satisfies AuthStatus);
        const identity = authenticatedBackupIdentity(queryClient)!;
        const firstFingerprint = backupRequestFingerprint(status, "run");
        const first = readOrCreateBackupIdempotencyKey({
            fingerprint: firstFingerprint,
            identity,
            operation: "run",
            type: "kopia",
        });
        const replay = readOrCreateBackupIdempotencyKey({
            fingerprint: firstFingerprint,
            identity,
            operation: "run",
            type: "kopia",
        });
        const afterAttention = readOrCreateBackupIdempotencyKey({
            fingerprint: backupRequestFingerprint(
                {
                    ...status,
                    activity: {
                        finishedAtMs: nowMs,
                        jobRunId: runId,
                        jobsUrl: `/jobs?runId=${runId}`,
                        queuedAtMs: nowMs,
                        state: "failed",
                    },
                },
                "run"
            ),
            identity,
            operation: "run",
            type: "kopia",
        });

        expect(first).toMatch(/^[0-9a-f]{32}$/u);
        expect(replay).toBe(first);
        expect(afterAttention).not.toBe(first);
        expect(clearBackupRecovery({ identity, operation: "run", type: "kopia" })).toBe(
            true
        );
        queryClient.clear();
    });

    test("fails closed when browser storage cannot retain the request", () => {
        const original = globalThis.sessionStorage;
        Object.defineProperty(globalThis, "sessionStorage", {
            configurable: true,
            value: {
                getItem: () => null,
                removeItem: () => {},
                setItem: () => {},
            },
        });
        try {
            expect(() =>
                readOrCreateBackupIdempotencyKey({
                    fingerprint: backupRequestFingerprint(status, "run"),
                    identity: "authenticated:user:session",
                    operation: "run",
                    type: "kopia",
                })
            ).toThrow("Backup request recovery is unavailable");
        } finally {
            Object.defineProperty(globalThis, "sessionStorage", {
                configurable: true,
                value: original,
            });
        }
    });
});
