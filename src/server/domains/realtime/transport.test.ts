import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { gatewayRealtimeTopics } from "../../../contracts/gatewayRealtime.ts";
import { monitoringRealtimeTopics } from "../../../contracts/monitoringRealtime.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import type { RealtimeEventDelivery } from "../../platform/realtime/eventPump.ts";
import {
    createTestAutomationAuthentication,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { authorizeRealtimeTopics, realtimeDeliveryToStreamOutput } from "./transport.ts";

const reportsAuthentication = createTestAutomationAuthentication(["reports:read"]);
if (reportsAuthentication.kind !== "authenticated") {
    throw new Error("Test automation identity is not authenticated");
}
const reportsPrincipal: AuthenticatedPrincipal = reportsAuthentication.principal;
const gatewayAutomation = createTestAutomationAuthentication(["gateway-sessions:read"]);
const gatewaySession = createTestSessionAuthentication(["gateway-sessions:read"]);
if (
    gatewayAutomation.kind !== "authenticated" ||
    gatewaySession.kind !== "authenticated"
) {
    throw new Error("Gateway test identities are not authenticated");
}

const reportDelivery: RealtimeEventDelivery = {
    event: {
        entityId: "report-1",
        entityType: "report",
        occurredAtMs: 1,
        operation: "created",
        payloadJson: '{"id":"report-1"}',
        topic: monitoringRealtimeTopics.reports,
    },
    id: "1",
    kind: "change",
};

describe("realtime tRPC transport", () => {
    test("authorizes every requested topic before opening the pump", () => {
        expect(
            authorizeRealtimeTopics(reportsPrincipal, [
                monitoringRealtimeTopics.incidents,
                monitoringRealtimeTopics.reports,
            ])
        ).toEqual([monitoringRealtimeTopics.incidents, monitoringRealtimeTopics.reports]);

        let failure: unknown;
        try {
            authorizeRealtimeTopics(reportsPrincipal, [
                monitoringRealtimeTopics.notifications,
            ]);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("FORBIDDEN");
    });

    test("keeps Gateway topics session-only even with the exact capability", () => {
        expect(
            authorizeRealtimeTopics(gatewaySession.principal, [
                gatewayRealtimeTopics.connection,
                gatewayRealtimeTopics.sessions,
            ])
        ).toEqual([gatewayRealtimeTopics.connection, gatewayRealtimeTopics.sessions]);
        expect(() =>
            authorizeRealtimeTopics(gatewayAutomation.principal, [
                gatewayRealtimeTopics.sessions,
            ])
        ).toThrow(TRPCError);
    });

    test("parses durable plain JSON into the topic-specific client contract", () => {
        expect(realtimeDeliveryToStreamOutput(reportDelivery)).toEqual({
            data: {
                event: {
                    entityId: "report-1",
                    entityType: "report",
                    occurredAtMs: 1,
                    operation: "created",
                    payload: { id: "report-1" },
                    topic: monitoringRealtimeTopics.reports,
                },
                kind: "change",
            },
            id: "1",
        });
        expect(
            realtimeDeliveryToStreamOutput({
                id: "1",
                kind: "resync-required",
                reason: "cursor-outside-retention",
            })
        ).toEqual({
            data: {
                kind: "resync-required",
                reason: "cursor-outside-retention",
            },
            id: "1",
        });
    });

    test("keeps malformed or mismatched durable data out of the client stream", () => {
        const invalidDeliveries: RealtimeEventDelivery[] = [
            {
                ...reportDelivery,
                event: { ...reportDelivery.event, payloadJson: "{" },
            },
            {
                ...reportDelivery,
                event: { ...reportDelivery.event, payloadJson: '{"other":true}' },
            },
            {
                ...reportDelivery,
                event: { ...reportDelivery.event, entityType: "incident" },
            },
            { ...reportDelivery, id: "01" },
        ];

        for (const delivery of invalidDeliveries) {
            expect(() => realtimeDeliveryToStreamOutput(delivery)).toThrow();
        }
    });
});
