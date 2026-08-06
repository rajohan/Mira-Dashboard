import { describe, expect, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";
import { Effect, Layer, Stream } from "effect";
import * as v from "valibot";

import { createDashboardServer } from "../../../app/dashboardServer.ts";
import type { ApplicationServer } from "../../../app/server.ts";
import {
    createAutomationCredentialResultSchema,
    createAutomationPrincipalResultSchema,
    disableAutomationPrincipalResultSchema,
    listAutomationCredentialsResultSchema,
    listAutomationPrincipalsResultSchema,
    replaceAutomationCapabilitiesResultSchema,
    revokeAutomationCredentialResultSchema,
    rotateAutomationCredentialResultSchema,
} from "../../../contracts/automationSecurity.ts";
import type { RealtimeStreamOutput } from "../../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import { testTotpSecretCipher } from "../../domains/security/testSupport/authentication.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import {
    automationHttpReportDelivery,
    automationHttpSubscriptionTimeoutMs,
    automationHttpSystemBrowserOrigin,
    automationHttpSystemPrincipalId,
    automationStreamFailure,
    createAutomationEventsClient,
    firstAutomationStreamEvent,
    getAutomationTrpcQuery,
    oneAutomationDeliveryForRequestedTopic,
    openAutomationAuthenticationFixture,
} from "../support/automationHttpSystem.ts";
import { CookieJar, postTrpcMutation, trpcData } from "../support/mfaHttpSystem.ts";
import { withTestTimeout } from "../support/promise.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

const leaseInvalidationTimeoutMs = secondsToMilliseconds(5);
async function createSystemPrincipal(
    server: ApplicationServer,
    jar: CookieJar,
    principalId = automationHttpSystemPrincipalId
) {
    const response = await postTrpcMutation(
        server.url,
        "automationSecurity.createPrincipal",
        {
            capabilities: ["reports:read"],
            id: principalId,
            initialCredential: { label: "Initial system credential" },
            label: "System automation reader",
        },
        { jar }
    );
    expect(response.response.status, response.text).toBe(200);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    return v.parse(createAutomationPrincipalResultSchema, trpcData(response));
}

describe("real HTTP automation credential lifecycle", () => {
    test("creates, authorizes, rotates, revokes, and disables persisted credentials without leaking stored secrets", async () => {
        const { fixture, jar } = await openAutomationAuthenticationFixture();
        let server: ApplicationServer | undefined;

        try {
            server = await createDashboardServer({
                applicationRuntime: createTestApplicationRuntime({
                    stream: (options) =>
                        Promise.resolve(
                            oneAutomationDeliveryForRequestedTopic(options.topics)
                        ),
                }),
                browserOrigin: automationHttpSystemBrowserOrigin,
                database: fixture.database.orm,
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => new Date(),
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            const created = await createSystemPrincipal(server, jar);

            const secondaryResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.createCredential",
                {
                    credential: { label: "Secondary system credential" },
                    expectedAuthorizationVersion: created.principal.authorizationVersion,
                    principalId: created.principal.id,
                },
                { jar }
            );
            expect(secondaryResponse.response.status, secondaryResponse.text).toBe(200);
            const secondary = v.parse(
                createAutomationCredentialResultSchema,
                trpcData(secondaryResponse)
            );

            const principals = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listPrincipals",
                {},
                { cookie: jar.header() }
            );
            const credentials = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listCredentials",
                { principalId: created.principal.id },
                { cookie: jar.header() }
            );
            expect(principals.response.status, principals.text).toBe(200);
            expect(credentials.response.status, credentials.text).toBe(200);
            expect(
                v
                    .parse(listAutomationPrincipalsResultSchema, trpcData(principals))
                    .principals.find((principal) => principal.id === created.principal.id)
                    ?.activeCredentialCount
            ).toBe(2);
            expect(
                v.parse(listAutomationCredentialsResultSchema, trpcData(credentials))
                    .credentials
            ).toHaveLength(2);
            for (const text of [principals.text, credentials.text]) {
                expect(text).not.toContain(created.token);
                expect(text).not.toContain(secondary.token);
                expect(text).not.toContain('"validatorHash"');
                expect(text).not.toContain('"validatorVersion"');
                expect(text).not.toContain('"token"');
            }

            const automationAdministration = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listPrincipals",
                {},
                { bearerToken: created.token }
            );
            expect(
                automationAdministration.response.status,
                automationAdministration.text
            ).toBe(403);
            expect(automationAdministration.text).not.toContain(created.token);
            expect(automationAdministration.response.headers.get("cache-control")).toBe(
                "no-store"
            );

            const ambiguous = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listPrincipals",
                {},
                { bearerToken: created.token, cookie: jar.header() }
            );
            expect(ambiguous.response.status).toBe(400);
            expect(ambiguous.text).toBe("Ambiguous authentication credentials");
            expect(ambiguous.text).not.toContain(created.token);
            expect(ambiguous.response.headers.get("cache-control")).toBe("no-store");

            const observedStreamResponses: Response[] = [];
            expect(
                await firstAutomationStreamEvent(
                    server,
                    created.token,
                    monitoringRealtimeTopics.reports,
                    (response) => observedStreamResponses.push(response)
                )
            ).toMatchObject({ data: { kind: "change" }, id: "1" });
            expect(observedStreamResponses[0]?.headers.get("cache-control")).toContain(
                "no-store"
            );
            const missingNotificationCapability = await automationStreamFailure(
                server,
                created.token,
                monitoringRealtimeTopics.notifications
            );
            expect(missingNotificationCapability.message).toContain(
                "Realtime topic access is forbidden"
            );

            const replacedResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.replaceCapabilities",
                {
                    capabilities: ["notifications:read"],
                    expectedAuthorizationVersion: created.principal.authorizationVersion,
                    principalId: created.principal.id,
                },
                { jar }
            );
            expect(replacedResponse.response.status, replacedResponse.text).toBe(200);
            const replaced = v.parse(
                replaceAutomationCapabilitiesResultSchema,
                trpcData(replacedResponse)
            );
            expect(replaced).toMatchObject({
                changed: true,
                principal: {
                    authorizationVersion: created.principal.authorizationVersion + 1,
                    capabilities: ["notifications:read"],
                },
            });
            const removedReportCapability = await automationStreamFailure(
                server,
                created.token,
                monitoringRealtimeTopics.reports
            );
            expect(removedReportCapability.message).toContain(
                "Realtime topic access is forbidden"
            );
            expect(
                await firstAutomationStreamEvent(
                    server,
                    created.token,
                    monitoringRealtimeTopics.notifications
                )
            ).toMatchObject({ data: { kind: "change" }, id: "1" });

            const rotationResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.rotateCredential",
                {
                    credentialId: created.credential.id,
                    expectedAuthorizationVersion: replaced.principal.authorizationVersion,
                    principalId: created.principal.id,
                    replacement: { label: "Replacement system credential" },
                },
                { jar }
            );
            expect(rotationResponse.response.status, rotationResponse.text).toBe(200);
            const rotation = v.parse(
                rotateAutomationCredentialResultSchema,
                trpcData(rotationResponse)
            );
            expect(rotation.credential.replacesCredentialId).toBe(created.credential.id);
            for (const token of [created.token, secondary.token, rotation.token]) {
                expect(
                    await firstAutomationStreamEvent(
                        server,
                        token,
                        monitoringRealtimeTopics.notifications
                    )
                ).toMatchObject({ data: { kind: "change" }, id: "1" });
            }

            const revocationResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.revokeCredential",
                {
                    credentialId: created.credential.id,
                    expectedAuthorizationVersion: replaced.principal.authorizationVersion,
                    principalId: created.principal.id,
                },
                { jar }
            );
            expect(revocationResponse.response.status, revocationResponse.text).toBe(200);
            expect(
                v.parse(
                    revokeAutomationCredentialResultSchema,
                    trpcData(revocationResponse)
                ).revoked
            ).toBeTrue();
            const revokedCredentialFailure = await automationStreamFailure(
                server,
                created.token,
                monitoringRealtimeTopics.notifications
            );
            expect(revokedCredentialFailure.message).toBe("Authentication required");
            for (const token of [secondary.token, rotation.token]) {
                expect(
                    await firstAutomationStreamEvent(
                        server,
                        token,
                        monitoringRealtimeTopics.notifications
                    )
                ).toMatchObject({ data: { kind: "change" }, id: "1" });
            }

            const disableResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.disablePrincipal",
                {
                    expectedAuthorizationVersion: replaced.principal.authorizationVersion,
                    principalId: created.principal.id,
                },
                { jar }
            );
            expect(disableResponse.response.status, disableResponse.text).toBe(200);
            const disabled = v.parse(
                disableAutomationPrincipalResultSchema,
                trpcData(disableResponse)
            );
            expect(disabled).toMatchObject({
                changed: true,
                principal: { activeCredentialCount: 0, disabled: true },
                revokedCredentials: 2,
            });
            for (const token of [secondary.token, rotation.token]) {
                const disabledCredentialFailure = await automationStreamFailure(
                    server,
                    token,
                    monitoringRealtimeTopics.notifications
                );
                expect(disabledCredentialFailure.message).toBe("Authentication required");
            }
        } finally {
            await server?.stop(true);
            fixture.database.sqlite.close(true);
        }
    }, 120_000);

    test("invalidates a quiet bearer SSE after capability replacement within the configured lease bound", async () => {
        const { fixture, jar } = await openAutomationAuthenticationFixture();
        const quietStream = Stream.make(automationHttpReportDelivery).pipe(
            Stream.concat(Stream.fromEffect(Effect.never))
        );
        const unusedMetrics = Effect.die("Metrics are not used in this test");
        const runtime = createApplicationRuntime({
            realtimeEventPumpLayer: Layer.succeed(
                RealtimeEventPumpService,
                RealtimeEventPumpService.of({
                    metricsSnapshot: unusedMetrics,
                    stream: () => quietStream,
                    wake: Effect.void,
                })
            ),
        });
        let server: ApplicationServer | undefined;

        try {
            server = await createDashboardServer({
                applicationRuntime: runtime,
                authenticationLeaseDurationMs: secondsToMilliseconds(1),
                browserOrigin: automationHttpSystemBrowserOrigin,
                database: fixture.database.orm,
                gatewayUrl: "ws://127.0.0.1:1",
                now: () => new Date(),
                port: 0,
                readiness: createReadinessController(),
                totpSecretCipher: testTotpSecretCipher,
            });
            const created = await createSystemPrincipal(
                server,
                jar,
                "quiet-system-reader"
            );
            const streamFailureOutcome = Promise.withResolvers<Error>();
            const firstEvent = Promise.withResolvers<RealtimeStreamOutput>();
            const subscription = createAutomationEventsClient(
                server,
                created.token
            ).events.stream.subscribe(
                { topics: [monitoringRealtimeTopics.reports] },
                {
                    onComplete: () =>
                        streamFailureOutcome.reject(
                            new Error(
                                "Quiet automation stream completed before lease invalidation"
                            )
                        ),
                    onData: firstEvent.resolve,
                    onError: streamFailureOutcome.resolve,
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
                const replacementStartedAtMs = Date.now();
                const replacement = await postTrpcMutation(
                    server.url,
                    "automationSecurity.replaceCapabilities",
                    {
                        capabilities: ["notifications:read"],
                        expectedAuthorizationVersion:
                            created.principal.authorizationVersion,
                        principalId: created.principal.id,
                    },
                    { jar }
                );
                expect(replacement.response.status, replacement.text).toBe(200);

                const failure = await withTestTimeout(
                    streamFailureOutcome.promise,
                    leaseInvalidationTimeoutMs,
                    "Quiet automation stream outlived its authentication lease"
                );
                expect(failure.message).toContain("Realtime topic access is forbidden");
                expect(Date.now() - replacementStartedAtMs).toBeLessThan(
                    secondsToMilliseconds(3)
                );
            } finally {
                subscription.unsubscribe();
            }
        } finally {
            await server?.stop(true);
            fixture.database.sqlite.close(true);
        }
    }, 120_000);
});
