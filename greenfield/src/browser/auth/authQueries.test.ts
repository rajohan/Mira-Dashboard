import { describe, expect, spyOn, test } from "bun:test";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { authStatusQueryKey, publishAuthenticationStatus } from "./authQueries.ts";

const bootstrapStatus = { state: "bootstrap-required" } satisfies AuthStatus;
const anonymousStatus = { state: "anonymous" } satisfies AuthStatus;
const pendingMfaStatus = {
    pendingLogin: {
        expiresAtMs: 1_800_000_060_000,
        methods: ["totp"],
        username: "auth-transition-test",
    },
    state: "pending-mfa",
} satisfies AuthStatus;

describe("authentication status publication", () => {
    test("serializes overlapping publications through the latest transition record", async () => {
        const queryClient = createDashboardQueryClient();
        const firstGate = Promise.withResolvers<void>();
        const secondGate = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();
        const secondStarted = Promise.withResolvers<void>();
        const thirdStarted = Promise.withResolvers<void>();
        let cancellationCount = 0;
        const cancelQueries = spyOn(queryClient, "cancelQueries").mockImplementation(
            async () => {
                cancellationCount += 1;
                if (cancellationCount === 1) {
                    firstStarted.resolve();
                    await firstGate.promise;
                } else if (cancellationCount === 2) {
                    secondStarted.resolve();
                    await secondGate.promise;
                } else {
                    thirdStarted.resolve();
                }
            }
        );
        const publicationA = publishAuthenticationStatus(queryClient, bootstrapStatus);
        let publicationB: Promise<void> | undefined;
        let publicationC: Promise<void> | undefined;

        try {
            await firstStarted.promise;
            publicationB = publishAuthenticationStatus(queryClient, anonymousStatus);
            await Promise.resolve();
            expect(cancellationCount).toBe(1);

            firstGate.resolve();
            await publicationA;
            await secondStarted.promise;
            publicationC = publishAuthenticationStatus(queryClient, pendingMfaStatus);
            await Promise.resolve();
            expect(cancellationCount).toBe(2);

            secondGate.resolve();
            await publicationB;
            await thirdStarted.promise;
            await publicationC;

            expect(cancellationCount).toBe(3);
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(
                pendingMfaStatus
            );
        } finally {
            firstGate.resolve();
            secondGate.resolve();
            await Promise.allSettled(
                [publicationA, publicationB, publicationC].filter(
                    (publication): publication is Promise<void> =>
                        publication !== undefined
                )
            );
            cancelQueries.mockRestore();
            queryClient.clear();
        }
    });

    test("continues a queued publication after the previous transition rejects", async () => {
        const queryClient = createDashboardQueryClient();
        const firstGate = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();
        const secondStarted = Promise.withResolvers<void>();
        const transitionError = new Error("Authentication transition failed");
        let cancellationCount = 0;
        const cancelQueries = spyOn(queryClient, "cancelQueries").mockImplementation(
            async () => {
                cancellationCount += 1;
                if (cancellationCount === 1) {
                    firstStarted.resolve();
                    await firstGate.promise;
                    throw transitionError;
                }
                if (cancellationCount === 2) secondStarted.resolve();
            }
        );
        const publicationA = publishAuthenticationStatus(queryClient, bootstrapStatus);
        let publicationB: Promise<void> | undefined;

        try {
            await firstStarted.promise;
            publicationB = publishAuthenticationStatus(queryClient, anonymousStatus);
            firstGate.resolve();

            let observedError: unknown;
            try {
                await publicationA;
            } catch (error) {
                observedError = error;
            }
            expect(observedError).toBe(transitionError);
            await secondStarted.promise;
            await publicationB;
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(anonymousStatus);

            await publishAuthenticationStatus(queryClient, pendingMfaStatus);
            expect(cancellationCount).toBe(3);
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(
                pendingMfaStatus
            );
        } finally {
            firstGate.resolve();
            await Promise.allSettled(
                [publicationA, publicationB].filter(
                    (publication): publication is Promise<void> =>
                        publication !== undefined
                )
            );
            cancelQueries.mockRestore();
            queryClient.clear();
        }
    });
});
