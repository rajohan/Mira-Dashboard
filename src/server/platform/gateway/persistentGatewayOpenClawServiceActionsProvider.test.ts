import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createPersistentGatewayOpenClawServiceActionsProvider,
    OpenClawServiceActionsProviderError,
} from "./persistentGatewayOpenClawServiceActionsProvider.ts";
import type { PersistentGatewayTaskNotificationTransport } from "./persistentGatewayTransport.ts";
import { PersistentGatewayUnknownOutcomeError } from "./persistentGatewayTransport.ts";

type Request = PersistentGatewayTaskNotificationTransport["requestOpenClawServiceAction"];

describe("persistent Gateway OpenClaw Service Actions provider", () => {
    test("uses the exact cleanup request and returns only bounded aggregate counts", async () => {
        const calls: Parameters<Request>[] = [];
        const signal = new AbortController().signal;
        const provider = createPersistentGatewayOpenClawServiceActionsProvider({
            requestOpenClawServiceAction: (...input: Parameters<Request>) => {
                calls.push(input);
                return Promise.resolve({
                    method: "sessions.cleanup",
                    stores: [
                        {
                            artifactsRemoved: 2,
                            bytesFreed: 300,
                            diskEntriesRemoved: 3,
                            diskFilesRemoved: 4,
                            dmScopesRetired: 5,
                            entriesAfter: 6,
                            entriesBefore: 7,
                            entriesCapped: 8,
                            entriesPruned: 9,
                            missingEntriesRemoved: 10,
                            modelRunsPruned: 11,
                        },
                        {
                            artifactsRemoved: 1,
                            bytesFreed: 20,
                            diskEntriesRemoved: 1,
                            diskFilesRemoved: 1,
                            dmScopesRetired: 1,
                            entriesAfter: 1,
                            entriesBefore: 2,
                            entriesCapped: 1,
                            entriesPruned: 1,
                            missingEntriesRemoved: 1,
                            modelRunsPruned: 1,
                        },
                    ],
                });
            },
        });

        expect(await provider.cleanupSessions(signal)).toEqual({
            artifactsRemoved: 3,
            bytesFreed: 320,
            diskEntriesRemoved: 4,
            diskFilesRemoved: 5,
            dmScopesRetired: 6,
            entriesAfter: 7,
            entriesBefore: 9,
            entriesCapped: 9,
            entriesPruned: 10,
            missingEntriesRemoved: 11,
            modelRunsPruned: 12,
            status: "completed",
            storesProcessed: 2,
        });
        expect(calls).toEqual([
            [
                "sessions.cleanup",
                { allAgents: true, enforce: true },
                { signal, timeoutMs: 600_000 },
            ],
        ]);
    });

    test("projects completed and accepted updates without raw operational fields", async () => {
        const responses = [
            {
                afterVersion: "2026.8.0",
                beforeVersion: "2026.7.2-beta.7",
                method: "update.run" as const,
                status: "completed" as const,
            },
            {
                beforeVersion: "2026.7.2-beta.7",
                method: "update.run" as const,
                status: "accepted" as const,
            },
        ];
        const calls: Parameters<Request>[] = [];
        const provider = createPersistentGatewayOpenClawServiceActionsProvider({
            requestOpenClawServiceAction: (...input: Parameters<Request>) => {
                calls.push(input);
                const response = responses.shift();
                if (response === undefined) throw new Error("missing fixture response");
                return Promise.resolve(response);
            },
        });

        expect(await provider.updateInstallation()).toEqual({
            afterVersion: "2026.8.0",
            beforeVersion: "2026.7.2-beta.7",
            status: "completed",
        });
        expect(await provider.updateInstallation()).toEqual({
            beforeVersion: "2026.7.2-beta.7",
            status: "accepted",
        });
        expect(
            calls.map(([method, parameters, options]) => ({
                method,
                parameters,
                timeoutMs: options?.timeoutMs,
            }))
        ).toEqual([
            {
                method: "update.run",
                parameters: { timeoutMs: 1_200_000 },
                timeoutMs: 2_100_000,
            },
            {
                method: "update.run",
                parameters: { timeoutMs: 1_200_000 },
                timeoutMs: 2_100_000,
            },
        ]);
    });

    test("fails operational errors and preserves unknown outcome without replay", async () => {
        let attempts = 0;
        const operational = createPersistentGatewayOpenClawServiceActionsProvider({
            requestOpenClawServiceAction: () => {
                attempts += 1;
                return Promise.resolve({ method: "update.run", status: "failed" });
            },
        });
        const operationFailure = await captureFailure(() =>
            operational.updateInstallation()
        );
        expect(operationFailure).toBeInstanceOf(OpenClawServiceActionsProviderError);
        expect(operationFailure).toMatchObject({ reason: "operation-failed" });

        const uncertain = createPersistentGatewayOpenClawServiceActionsProvider({
            requestOpenClawServiceAction: () => {
                attempts += 1;
                return Promise.reject(new PersistentGatewayUnknownOutcomeError());
            },
        });
        const unknownFailure = await captureFailure(() => uncertain.cleanupSessions());
        expect(unknownFailure).toBeInstanceOf(OpenClawServiceActionsProviderError);
        expect(unknownFailure).toMatchObject({
            message: "OpenClaw Service Action failed",
            reason: "unknown-outcome",
        });
        const renderedUnknownFailure =
            unknownFailure instanceof Error
                ? [
                      unknownFailure.name,
                      unknownFailure.message,
                      unknownFailure.stack ?? "",
                  ].join("\n")
                : String(unknownFailure);
        expect(renderedUnknownFailure).not.toContain("systemctl");
        expect(attempts).toBe(2);
    });

    test("fails closed when aggregate cleanup counts exceed safe integers", async () => {
        const provider = createPersistentGatewayOpenClawServiceActionsProvider({
            requestOpenClawServiceAction: () =>
                Promise.resolve({
                    method: "sessions.cleanup",
                    stores: [
                        {
                            artifactsRemoved: Number.MAX_SAFE_INTEGER,
                            bytesFreed: 0,
                            diskEntriesRemoved: 0,
                            diskFilesRemoved: 0,
                            dmScopesRetired: 0,
                            entriesAfter: 0,
                            entriesBefore: 0,
                            entriesCapped: 0,
                            entriesPruned: 0,
                            missingEntriesRemoved: 0,
                            modelRunsPruned: 0,
                        },
                        {
                            artifactsRemoved: 1,
                            bytesFreed: 0,
                            diskEntriesRemoved: 0,
                            diskFilesRemoved: 0,
                            dmScopesRetired: 0,
                            entriesAfter: 0,
                            entriesBefore: 0,
                            entriesCapped: 0,
                            entriesPruned: 0,
                            missingEntriesRemoved: 0,
                            modelRunsPruned: 0,
                        },
                    ],
                }),
        });

        expect(await captureFailure(() => provider.cleanupSessions())).toMatchObject({
            message: "OpenClaw Service Action failed",
            reason: "unavailable",
        });
    });
});
