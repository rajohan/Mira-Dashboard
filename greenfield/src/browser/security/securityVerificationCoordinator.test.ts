import { describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import { registerAuthenticatedOperation } from "../auth/authenticatedOperationRegistry.ts";
import {
    createSecurityVerificationCoordinator,
    SecurityVerificationCancelledError,
} from "./securityVerificationCoordinator.ts";

describe("security verification coordinator", () => {
    test("publishes presenter ownership and exposes the fixed cancellation error", () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        let publications = 0;
        const unsubscribe = coordinator.subscribe(() => {
            publications += 1;
        });

        expect(coordinator.getSnapshot()).toMatchObject({
            authenticationIdentity: "session:one",
            pendingInteractionCount: 0,
            pendingRequestCount: 0,
            phase: "idle",
            presenterClaimed: false,
        });
        const releasePresenter = coordinator.acquirePresenter();
        expect(releasePresenter).toBeFunction();
        expect(coordinator.acquirePresenter()).toBeUndefined();
        expect(coordinator.getSnapshot().presenterClaimed).toBeTrue();

        releasePresenter?.();
        releasePresenter?.();
        expect(coordinator.getSnapshot().presenterClaimed).toBeFalse();
        expect(publications).toBe(2);
        unsubscribe();
        coordinator.setAuthenticationIdentity("session:two");
        expect(publications).toBe(2);

        const cancellation = new SecurityVerificationCancelledError();
        expect(cancellation).toBeInstanceOf(Error);
        expect(cancellation.name).toBe("SecurityVerificationCancelledError");
        expect(cancellation.message).toBe("Security verification was cancelled");
    });

    test("rejects unbound, conflicting, and already-aborted requests", async () => {
        const unbound = createSecurityVerificationCoordinator(() => void 0);
        expect(unbound.request("step_up_required")).toBeUndefined();

        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        expect(
            coordinator.request("step_up_required", { identity: "session:two" })
        ).toBeUndefined();

        const aborted = new AbortController();
        aborted.abort();
        const cancelled = coordinator.request("step_up_required", {
            signal: aborted.signal,
        });
        expect(await cancelled?.outcome).toBe("cancelled");
        cancelled?.releaseAfterAttempt();

        const operation = new AbortController();
        const finishOperation = registerAuthenticatedOperation({
            cacheGeneration: 1,
            identity: "session:operation",
            queryClient: new QueryClient(),
            signal: operation.signal,
        });
        expect(
            coordinator.request("step_up_required", {
                identity: "session:one",
                signal: operation.signal,
            })
        ).toBeUndefined();
        finishOperation();
        expect(coordinator.getSnapshot().phase).toBe("idle");
    });

    test("replays all blocked requests and completes the planned cache reset", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        expect(coordinator.beginProof()).toBeFalse();
        expect(coordinator.failProof()).toBeFalse();
        expect(coordinator.beginCacheReset("session:two")).toBeFalse();
        expect(coordinator.acknowledgeCacheReset("session:two")).toBeFalse();
        expect(await coordinator.waitForCacheReset()).toBe("cancelled");

        const first = coordinator.request("step_up_required");
        const second = coordinator.request("mfa_enrollment_required");
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(coordinator.getSnapshot()).toMatchObject({
            generation: 1,
            identity: "session:one",
            pendingRequestCount: 2,
            phase: "prompting",
            reason: "mfa_enrollment_required",
        });

        expect(coordinator.beginProof()).toBeTrue();
        expect(coordinator.beginProof()).toBeFalse();
        expect(coordinator.failProof()).toBeTrue();
        expect(coordinator.failProof()).toBeFalse();
        expect(coordinator.beginProof()).toBeTrue();
        const replay = coordinator.completeProof();
        expect(coordinator.getSnapshot().phase).toBe("replaying");
        expect(await first?.outcome).toBe("verified");
        expect(await second?.outcome).toBe("verified");
        first?.releaseAfterAttempt();
        first?.releaseAfterAttempt();
        second?.releaseAfterAttempt();
        expect(await replay).toBeTrue();
        expect(coordinator.getSnapshot().phase).toBe("reconciling");
        expect(await coordinator.completeProof()).toBeFalse();

        expect(coordinator.beginCacheReset("session:two")).toBeTrue();
        coordinator.setAuthenticationIdentity("session:two");
        expect(coordinator.acknowledgeCacheReset("session:other")).toBeFalse();
        const resetCompletion = coordinator.waitForCacheReset();
        expect(coordinator.acknowledgeCacheReset("session:two")).toBeTrue();
        expect(await resetCompletion).toBe("completed");
        expect(coordinator.getSnapshot()).toMatchObject({
            authenticationIdentity: "session:two",
            phase: "idle",
            reason: undefined,
        });
    });

    test("holds replay for protected interactions and registered operation completion", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        const operationController = new AbortController();
        const finishOperation = registerAuthenticatedOperation({
            cacheGeneration: 7,
            identity: "session:one",
            queryClient: new QueryClient(),
            signal: operationController.signal,
        });
        const interaction = coordinator.prepareProtectedInteraction("step_up_required");
        const request = coordinator.request("step_up_required", {
            signal: operationController.signal,
        });

        expect(coordinator.getSnapshot()).toMatchObject({
            pendingInteractionCount: 1,
            pendingRequestCount: 1,
            protectedInteraction: true,
        });
        expect(coordinator.beginProof()).toBeTrue();
        const replay = coordinator.completeProof();
        expect(await interaction?.outcome).toBe("verified");
        expect(await request?.outcome).toBe("verified");
        expect(coordinator.request("step_up_required")).toBeUndefined();

        const lateInteraction =
            coordinator.prepareProtectedInteraction("step_up_required");
        expect(await lateInteraction?.outcome).toBe("verified");
        lateInteraction?.releaseAfterAttempt();
        request?.releaseAfterAttempt();
        interaction?.releaseAfterAttempt();

        let replayFinished = false;
        void replay.then(() => (replayFinished = true));
        await Promise.resolve();
        expect(replayFinished).toBeFalse();
        finishOperation();
        expect(await replay).toBeTrue();
        expect(coordinator.getSnapshot().phase).toBe("reconciling");
        expect(coordinator.abortActiveFlow()).toBeTrue();
        expect(coordinator.abortActiveFlow()).toBeFalse();
    });

    test("supports proactive proof while rejecting other identities", async () => {
        const authentication: { identity?: string } = {};
        const coordinator = createSecurityVerificationCoordinator(
            () => authentication.identity
        );
        expect(coordinator.promptProactively("step_up_required")).toBeFalse();

        authentication.identity = "session:one";
        expect(coordinator.promptProactively("step_up_required")).toBeTrue();
        expect(coordinator.getSnapshot()).toMatchObject({
            authenticationIdentity: "session:one",
            phase: "prompting",
            reason: "step_up_required",
        });
        expect(
            coordinator.promptProactively("mfa_enrollment_required", "session:one")
        ).toBeTrue();
        expect(coordinator.getSnapshot().reason).toBe("mfa_enrollment_required");
        expect(
            coordinator.promptProactively("step_up_required", "session:other")
        ).toBeFalse();
        expect(coordinator.beginProof()).toBeTrue();
        expect(
            coordinator.promptProactively("step_up_required", "session:one")
        ).toBeTrue();
        expect(coordinator.failProof()).toBeTrue();
        coordinator.dismiss();
        expect(await coordinator.waitForCacheReset()).toBe("cancelled");
        expect(coordinator.getSnapshot().phase).toBe("idle");
        coordinator.dismiss();
    });

    test("cancels on waiter abort, presenter release, and unexpected auth change", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => "session:one");
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();
        const first = coordinator.request("step_up_required", {
            signal: firstAbort.signal,
        });
        const second = coordinator.request("step_up_required", {
            signal: secondAbort.signal,
        });

        firstAbort.abort();
        expect(await first?.outcome).toBe("cancelled");
        expect(coordinator.getSnapshot()).toMatchObject({
            pendingRequestCount: 1,
            phase: "prompting",
        });
        first?.releaseAfterAttempt();
        secondAbort.abort();
        expect(await second?.outcome).toBe("cancelled");
        second?.releaseAfterAttempt();
        expect(coordinator.getSnapshot().phase).toBe("idle");

        const presenterRelease = coordinator.acquirePresenter();
        const presenterWaiter = coordinator.request("step_up_required");
        presenterRelease?.();
        expect(await presenterWaiter?.outcome).toBe("cancelled");
        presenterWaiter?.releaseAfterAttempt();

        const identityWaiter = coordinator.request("step_up_required");
        coordinator.setAuthenticationIdentity("session:two");
        expect(await identityWaiter?.outcome).toBe("cancelled");
        identityWaiter?.releaseAfterAttempt();
        expect(coordinator.getSnapshot()).toMatchObject({
            authenticationIdentity: "session:two",
            phase: "idle",
        });
    });

    test("fails closed when the identity reader throws", async () => {
        const coordinator = createSecurityVerificationCoordinator(() => {
            throw new TypeError("cache unavailable");
        });
        expect(coordinator.getSnapshot().authenticationIdentity).toBeUndefined();
        expect(
            coordinator.promptProactively("step_up_required", "session:explicit")
        ).toBeTrue();
        const waiter = coordinator.request("step_up_required", {
            identity: "session:explicit",
        });
        expect(waiter).toBeDefined();
        coordinator.dismiss();
        expect(await waiter?.outcome).toBe("cancelled");
        waiter?.releaseAfterAttempt();
    });
});
