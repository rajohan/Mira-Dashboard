import { describe, expect, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";
import { Clock, Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as v from "valibot";

import {
    disableAutomationPrincipalResultSchema,
    revokeAutomationCredentialResultSchema,
} from "../../../contracts/automationSecurity.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import {
    automationHttpReportDelivery,
    automationHttpSubscriptionTimeoutMs,
    createAutomationEventsClient,
    openAutomationHttpSystem,
} from "../support/automationHttpSystem.ts";
import { postTrpcMutation, trpcData } from "../support/mfaHttpSystem.ts";
import { withTestTimeout } from "../support/promise.ts";
import { createTestStructuredLogger } from "../support/requestContext.ts";

const leaseDurationMs = secondsToMilliseconds(1);
const invalidationTimeoutMs = secondsToMilliseconds(5);
const unchangedRenewalObservationMs = leaseDurationMs + 250;

type InvalidationMutation = "disable-principal" | "revoke-credential";

async function createQuietAutomationRuntime() {
    const clockRuntime = ManagedRuntime.make(TestClock.layer());
    await clockRuntime.runPromise(TestClock.setTime(Date.now()));
    const clock = Context.get(await clockRuntime.context(), Clock.Clock);
    let nextClockRead: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const quietStream = Stream.make(automationHttpReportDelivery).pipe(
        Stream.concat(Stream.fromEffect(Effect.never))
    );
    const metricsSnapshot = Effect.die("Metrics are not used in this test");
    const eventPump = RealtimeEventPumpService.of({
        metricsSnapshot,
        stream: () => quietStream,
        wake: Effect.void,
    });
    const realtimeEventPumpLayer = Layer.succeed(RealtimeEventPumpService, eventPump);
    const applicationRuntime = createApplicationRuntime({
        clock,
        logger: createTestStructuredLogger(),
        realtimeEventPumpLayer,
    });
    return Object.freeze({
        advanceClock(milliseconds: number) {
            return clockRuntime.runPromise(TestClock.adjust(milliseconds));
        },
        applicationRuntime,
        disposeClock: () => clockRuntime.dispose(),
        now() {
            nextClockRead?.resolve();
            nextClockRead = undefined;
            return new Date(clock.currentTimeMillisUnsafe());
        },
        observeNextClockRead(): Promise<void> {
            if (nextClockRead !== undefined) {
                throw new Error("Authentication clock observation is already pending");
            }
            nextClockRead = Promise.withResolvers<void>();
            return nextClockRead.promise;
        },
    });
}

async function expectQuietLeaseInvalidation(
    mutation: InvalidationMutation
): Promise<void> {
    const runtime = await createQuietAutomationRuntime();
    const system = await openAutomationHttpSystem({
        applicationRuntime: runtime.applicationRuntime,
        authenticationLeaseDurationMs: leaseDurationMs,
        now: runtime.now,
        principalId: `quiet-${mutation}`,
    }).catch(async (error: unknown) => {
        try {
            await runtime.applicationRuntime.dispose();
        } finally {
            await runtime.disposeClock();
        }
        throw error;
    });
    const streamFailure = Promise.withResolvers<Error>();
    const firstEvent = Promise.withResolvers<RealtimeStreamOutput>();
    let streamState: "active" | "completed" | "failed" = "active";
    const subscription = createAutomationEventsClient(
        system.server,
        system.created.token
    ).events.stream.subscribe(
        { topics: [monitoringRealtimeTopics.reports] },
        {
            onComplete: () => {
                streamState = "completed";
                streamFailure.reject(
                    new Error("Quiet automation stream completed before invalidation")
                );
            },
            onData: firstEvent.resolve,
            onError: (error) => {
                streamState = "failed";
                streamFailure.resolve(error);
            },
        }
    );

    try {
        expect(
            await withTestTimeout(
                firstEvent.promise,
                automationHttpSubscriptionTimeoutMs,
                "Quiet automation stream did not emit its opening event"
            )
        ).toMatchObject({ data: { kind: "change" }, id: "1" });
        const unchangedRenewal = runtime.observeNextClockRead();
        await runtime.advanceClock(unchangedRenewalObservationMs);
        await withTestTimeout(
            unchangedRenewal,
            automationHttpSubscriptionTimeoutMs,
            "Quiet automation stream did not renew its unchanged lease"
        );
        expect(String(streamState)).toBe("active");
        const invalidationStartedAtMs = Date.now();
        const mutationResponse = await postTrpcMutation(
            system.server.url,
            mutation === "revoke-credential"
                ? "automationSecurity.revokeCredential"
                : "automationSecurity.disablePrincipal",
            mutation === "revoke-credential"
                ? {
                      credentialId: system.created.credential.id,
                      expectedAuthorizationVersion:
                          system.created.principal.authorizationVersion,
                      principalId: system.created.principal.id,
                  }
                : {
                      expectedAuthorizationVersion:
                          system.created.principal.authorizationVersion,
                      principalId: system.created.principal.id,
                  },
            { jar: system.jar }
        );
        expect(mutationResponse.response.status, mutationResponse.text).toBe(200);
        if (mutation === "revoke-credential") {
            expect(
                v.parse(
                    revokeAutomationCredentialResultSchema,
                    trpcData(mutationResponse)
                ).revoked
            ).toBeTrue();
        } else {
            expect(
                v.parse(
                    disableAutomationPrincipalResultSchema,
                    trpcData(mutationResponse)
                )
            ).toMatchObject({ changed: true, revokedCredentials: 1 });
        }

        await runtime.advanceClock(leaseDurationMs);
        const failure = await withTestTimeout(
            streamFailure.promise,
            invalidationTimeoutMs,
            `Quiet automation stream outlived ${mutation} lease invalidation`
        );
        expect(failure.message).toBe("Realtime authentication is no longer valid");
        expect(Date.now() - invalidationStartedAtMs).toBeLessThan(
            secondsToMilliseconds(3)
        );
    } finally {
        subscription.unsubscribe();
        try {
            await system.close();
        } finally {
            await runtime.disposeClock();
        }
    }
}

describe("automation credential quiet SSE lease invalidation", () => {
    test("invalidates after the active credential is revoked", async () => {
        await expectQuietLeaseInvalidation("revoke-credential");
    }, 120_000);

    test("invalidates after the principal is terminally disabled", async () => {
        await expectQuietLeaseInvalidation("disable-principal");
    }, 120_000);
});
