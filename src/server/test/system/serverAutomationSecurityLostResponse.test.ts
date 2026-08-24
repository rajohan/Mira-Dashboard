import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    listAutomationCredentialsResultSchema,
    revokeAutomationCredentialResultSchema,
    rotateAutomationCredentialResultSchema,
} from "../../../contracts/automationSecurity.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import {
    automationHttpSystemBrowserOrigin,
    firstAutomationStreamEvent,
    getAutomationTrpcQuery,
    oneAutomationDeliveryForRequestedTopic,
    openAutomationHttpSystem,
} from "../support/automationHttpSystem.ts";
import { postTrpcMutation, trpcData } from "../support/mfaHttpSystem.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

async function postRotationWithoutConsumingResponse(input: {
    readonly cookie: string;
    readonly credentialId: string;
    readonly expectedAuthorizationVersion: number;
    readonly principalId: string;
    readonly serverUrl: URL;
}): Promise<Response> {
    const response = await fetch(
        new URL("/trpc/automationSecurity.rotateCredential", input.serverUrl),
        {
            body: JSON.stringify({
                json: {
                    credentialId: input.credentialId,
                    expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                    principalId: input.principalId,
                    replacement: { label: "Discarded response replacement" },
                },
            }),
            headers: {
                "content-type": "application/json",
                cookie: input.cookie,
                origin: automationHttpSystemBrowserOrigin,
                "sec-fetch-site": "same-origin",
                "user-agent": "Mira automation lost-response system test",
            },
            method: "POST",
        }
    );
    await response.body?.cancel();
    return response;
}

describe("automation credential lost-response recovery", () => {
    test("recovers a discarded staged-rotation response through non-secret HTTP history", async () => {
        const system = await openAutomationHttpSystem({
            applicationRuntime: createTestApplicationRuntime({
                stream: (options) =>
                    Promise.resolve(
                        oneAutomationDeliveryForRequestedTopic(options.topics)
                    ),
            }),
            principalId: "lost-response-reader",
        });

        try {
            const { created, jar, server } = system;
            const cookie = jar.header();
            if (cookie === undefined) throw new Error("Browser session cookie is absent");

            const discardedRotation = await postRotationWithoutConsumingResponse({
                cookie,
                credentialId: created.credential.id,
                expectedAuthorizationVersion: created.principal.authorizationVersion,
                principalId: created.principal.id,
                serverUrl: server.url,
            });
            expect(discardedRotation.status).toBe(200);
            expect(discardedRotation.headers.get("cache-control")).toBe("no-store");

            expect(
                await firstAutomationStreamEvent(
                    server,
                    created.token,
                    monitoringRealtimeTopics.reports
                )
            ).toMatchObject({ data: { kind: "change" }, id: "1" });

            const historyResponse = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listCredentials",
                { principalId: created.principal.id },
                { cookie }
            );
            expect(historyResponse.response.status, historyResponse.text).toBe(200);
            const history = v.parse(
                listAutomationCredentialsResultSchema,
                trpcData(historyResponse)
            );
            const orphan = history.credentials.find(
                (credential) =>
                    credential.replacesCredentialId === created.credential.id &&
                    credential.revokedAtMs === undefined
            );
            expect(orphan).toMatchObject({
                label: "Discarded response replacement",
                replacesCredentialId: created.credential.id,
            });
            if (orphan === undefined) {
                throw new Error("Discarded replacement is absent from history");
            }
            expect(orphan.prefix).toHaveLength(32);
            expect(historyResponse.text).not.toContain(created.token);
            expect(historyResponse.text).not.toContain('"token"');
            expect(historyResponse.text).not.toContain('"validatorHash"');
            expect(historyResponse.text).not.toContain('"validatorVersion"');

            const revokeResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.revokeCredential",
                {
                    credentialId: orphan.id,
                    expectedAuthorizationVersion: created.principal.authorizationVersion,
                    principalId: created.principal.id,
                },
                { jar }
            );
            expect(revokeResponse.response.status, revokeResponse.text).toBe(200);
            expect(
                v.parse(revokeAutomationCredentialResultSchema, trpcData(revokeResponse))
            ).toMatchObject({ credential: { id: orphan.id }, revoked: true });

            const retryResponse = await postTrpcMutation(
                server.url,
                "automationSecurity.rotateCredential",
                {
                    credentialId: created.credential.id,
                    expectedAuthorizationVersion: created.principal.authorizationVersion,
                    principalId: created.principal.id,
                    replacement: { label: "Recovered replacement" },
                },
                { jar }
            );
            expect(retryResponse.response.status, retryResponse.text).toBe(200);
            const retry = v.parse(
                rotateAutomationCredentialResultSchema,
                trpcData(retryResponse)
            );
            expect(retry.credential).toMatchObject({
                label: "Recovered replacement",
                replacesCredentialId: created.credential.id,
            });
            expect(retry.credential.id).not.toBe(orphan.id);

            for (const token of [created.token, retry.token]) {
                expect(
                    await firstAutomationStreamEvent(
                        server,
                        token,
                        monitoringRealtimeTopics.reports
                    )
                ).toMatchObject({ data: { kind: "change" }, id: "1" });
            }

            const recoveredHistoryResponse = await getAutomationTrpcQuery(
                server,
                "automationSecurity.listCredentials",
                { principalId: created.principal.id },
                { cookie }
            );
            expect(
                recoveredHistoryResponse.response.status,
                recoveredHistoryResponse.text
            ).toBe(200);
            const recoveredHistory = v.parse(
                listAutomationCredentialsResultSchema,
                trpcData(recoveredHistoryResponse)
            );
            expect(
                recoveredHistory.credentials.find(({ id }) => id === orphan.id)
                    ?.revokedAtMs
            ).toBeNumber();
            expect(
                recoveredHistory.credentials.find(({ id }) => id === retry.credential.id)
                    ?.revokedAtMs
            ).toBeUndefined();
        } finally {
            await system.close();
        }
    }, 120_000);
});
