import { describe, expect, test } from "bun:test";

import {
    assertPersistentGatewayAdminParameters,
    assertPersistentGatewayReadWriteParameters,
    createPersistentGatewayConnectFrame,
    isPersistentGatewayAdminMethod,
    isPersistentGatewayReadWriteMethod,
    parsePersistentGatewayChallenge,
    parsePersistentGatewayChatSendAcknowledgement,
    parsePersistentGatewayEvent,
    parsePersistentGatewayEventEnvelope,
    parsePersistentGatewayHello,
    parsePersistentGatewayResponse,
    parsePersistentGatewaySessionsSubscriptionAcknowledgement,
    persistentGatewayAdminMethods,
    persistentGatewayAuthenticatedFrameMaximumBytes,
    persistentGatewayBufferedAmountPolicyMaximumBytes,
    persistentGatewayReadWriteMethods,
    persistentGatewaySessionScopedEventsCapability,
    persistentGatewayTaskNotificationMethod,
} from "./persistentGatewayProtocol.ts";

function hello(input: {
    readonly events?: readonly string[];
    readonly maxBufferedBytes?: number;
    readonly maxPayload?: number;
    readonly scopes: readonly string[];
}): Readonly<Record<string, unknown>> {
    return {
        auth: { role: "operator", scopes: input.scopes },
        features: {
            events: input.events ?? ["tick", "sessions.changed", "cron"],
            methods: ["sessions.list", "chat.send", "cron.run"],
        },
        policy: {
            maxBufferedBytes: input.maxBufferedBytes ?? 4 * 1024 * 1024,
            maxPayload:
                input.maxPayload ?? persistentGatewayAuthenticatedFrameMaximumBytes,
            tickIntervalMs: 30_000,
        },
        protocol: 4,
        server: { connId: "connection-1", version: "2026.7.2-beta.7" },
        snapshot: { ignoredInitialState: true },
        type: "hello-ok",
    };
}

describe("persistent Gateway protocol-v4 boundary", () => {
    test("builds the only credential-bearing frame with exact lane scopes", () => {
        const readWrite = createPersistentGatewayConnectFrame({
            clientVersion: "0.0.0",
            credential: "redacted-fixture-token",
            instanceId: "dashboard-process-1",
            profile: "web-read",
            requestId: "connect-1",
        });
        const admin = createPersistentGatewayConnectFrame({
            clientVersion: "0.0.0",
            credential: "redacted-fixture-token",
            instanceId: "dashboard-process-1",
            profile: "admin",
            requestId: "connect-2",
        });
        const worker = createPersistentGatewayConnectFrame({
            clientVersion: "0.0.0",
            credential: "redacted-fixture-token",
            instanceId: "dashboard-worker-1",
            profile: "task-notification-worker",
            requestId: "connect-3",
        });

        expect(readWrite).toEqual({
            id: "connect-1",
            method: "connect",
            params: {
                auth: { token: "redacted-fixture-token" },
                caps: [persistentGatewaySessionScopedEventsCapability],
                client: {
                    deviceFamily: "server",
                    displayName: "Mira Dashboard persistent web reads",
                    id: "gateway-client",
                    instanceId: "dashboard-process-1",
                    mode: "backend",
                    platform: process.platform,
                    version: "0.0.0",
                },
                maxProtocol: 4,
                minProtocol: 4,
                role: "operator",
                scopes: ["operator.read"],
            },
            type: "req",
        });
        expect((admin.params as Readonly<Record<string, unknown>>).scopes).toEqual([
            "operator.admin",
        ]);
        expect((admin.params as Readonly<Record<string, unknown>>).caps).toEqual([
            persistentGatewaySessionScopedEventsCapability,
        ]);
        expect(worker.params as Readonly<Record<string, unknown>>).toMatchObject({
            caps: [persistentGatewaySessionScopedEventsCapability],
            scopes: ["operator.write"],
        });
        expect(JSON.stringify(readWrite)).not.toContain("nonce");
    });

    test("locks generic and single-use method allowlists to least privilege", () => {
        expect(persistentGatewayReadWriteMethods).toEqual([
            "cron.get",
            "cron.list",
            "cron.runs",
            "sessions.list",
            "system.info",
        ]);
        expect(persistentGatewayReadWriteMethods).not.toContain(
            persistentGatewayTaskNotificationMethod
        );
        expect(persistentGatewayReadWriteMethods).not.toContain("sessions.dispatch");
        expect(persistentGatewayReadWriteMethods).not.toContain("sessions.reclaim");
        expect(persistentGatewayAdminMethods).toEqual([
            "cron.remove",
            "cron.run",
            "cron.update",
            "sessions.compact",
            "sessions.delete",
            "sessions.reset",
        ]);
        expect(isPersistentGatewayReadWriteMethod("sessions.list")).toBe(true);
        expect(isPersistentGatewayReadWriteMethod("chat.send")).toBe(false);
        expect(isPersistentGatewayReadWriteMethod("config.patch")).toBe(false);
        expect(isPersistentGatewayAdminMethod("cron.run")).toBe(true);
        expect(isPersistentGatewayAdminMethod("config.patch")).toBe(false);
    });

    test("keeps persistent web reads object-bound and all controls admin-only", () => {
        expect(() =>
            assertPersistentGatewayReadWriteParameters("sessions.list", { limit: 20 })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayReadWriteParameters("sessions.list", null)
        ).toThrow(TypeError);
        expect(() => assertPersistentGatewayAdminParameters("cron.run", null)).toThrow(
            TypeError
        );
    });

    test("requires challenge then a bounded exact-scope hello with tick support", () => {
        expect(
            parsePersistentGatewayChallenge({
                event: "connect.challenge",
                payload: { nonce: "nonce-1" },
                type: "event",
            })
        ).toEqual({ nonce: "nonce-1" });
        expect(
            parsePersistentGatewayHello(hello({ scopes: ["operator.read"] }), "web-read")
        ).toMatchObject({
            auth: { role: "operator", scopes: ["operator.read"] },
            protocol: 4,
            type: "hello-ok",
        });
        expect(
            parsePersistentGatewayHello(hello({ scopes: ["operator.admin"] }), "admin")
        ).toBeDefined();
        expect(
            parsePersistentGatewayHello(
                hello({
                    maxBufferedBytes: persistentGatewayBufferedAmountPolicyMaximumBytes,
                    scopes: ["operator.read"],
                }),
                "web-read"
            )
        ).toBeDefined();

        for (const candidate of [
            hello({ scopes: ["operator.write"] }),
            hello({ scopes: ["operator.read", "operator.write"] }),
            hello({ scopes: ["operator.read", "operator.read"] }),
            hello({ events: ["chat"], scopes: ["operator.read"] }),
            hello({ events: ["tick", "cron"], scopes: ["operator.read"] }),
            hello({ events: ["tick", "sessions.changed"], scopes: ["operator.read"] }),
            hello({
                maxPayload: persistentGatewayAuthenticatedFrameMaximumBytes + 1,
                scopes: ["operator.read"],
            }),
            hello({
                maxBufferedBytes: persistentGatewayBufferedAmountPolicyMaximumBytes + 1,
                scopes: ["operator.read"],
            }),
        ]) {
            expect(parsePersistentGatewayHello(candidate, "web-read")).toBeUndefined();
        }
        expect(
            parsePersistentGatewayHello(
                hello({ events: ["tick"], scopes: ["operator.write"] }),
                "task-notification-worker"
            )
        ).toBeDefined();
        expect(
            parsePersistentGatewayHello(
                hello({ events: ["tick"], scopes: ["operator.admin"] }),
                "admin"
            )
        ).toBeDefined();
    });

    test("projects only coherent responses, allowlisted events, and audited chat-send acknowledgements", () => {
        expect(
            parsePersistentGatewayResponse({
                id: "request-1",
                ok: true,
                payload: { jobs: [] },
                type: "res",
            })
        ).toEqual({
            id: "request-1",
            ok: true,
            payload: { jobs: [] },
            type: "res",
        });
        expect(
            parsePersistentGatewayResponse({
                error: { code: "UNAVAILABLE", message: "raw upstream detail" },
                id: "request-1",
                ok: false,
                payload: {},
                type: "res",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayResponse({
                error: {
                    code: "SECRET_SHAPED_ERROR_CODE",
                    message: "must not become a public error code",
                },
                id: "request-1",
                ok: false,
                type: "res",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayEvent({
                event: "sessions.changed",
                payload: { reason: "fixture" },
                seq: 7,
                type: "event",
            })
        ).toEqual({
            event: "sessions.changed",
            seq: 7,
            type: "event",
        });
        const secretShapedPayload = "Bearer secret-shaped-cron-payload";
        const cronEvent = parsePersistentGatewayEvent({
            event: "cron",
            payload: {
                credential: secretShapedPayload,
                nested: { token: secretShapedPayload },
            },
            seq: 8,
            type: "event",
        });
        expect(cronEvent).toEqual({ event: "cron", seq: 8, type: "event" });
        expect(JSON.stringify(cronEvent)).not.toContain(secretShapedPayload);
        expect(
            parsePersistentGatewayEvent({
                event: "tick",
                payload: { ts: 1 },
                seq: 8,
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayEvent({
                event: "config.changed",
                payload: {},
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayEventEnvelope({
                event: "config.changed",
                payload: { unreviewed: "never projected" },
                seq: 1,
                type: "event",
            })
        ).toEqual({ event: "config.changed", seq: 1, type: "event" });
        expect(
            parsePersistentGatewayEventEnvelope({
                event: "config.changed",
                payload: {},
                seq: 0,
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayEventEnvelope({
                event: "config.changed",
                extraEnvelopeField: true,
                type: "event",
            })
        ).toBeUndefined();

        expect(
            parsePersistentGatewaySessionsSubscriptionAcknowledgement({
                subscribed: true,
            })
        ).toBe(true);
        expect(
            parsePersistentGatewaySessionsSubscriptionAcknowledgement({
                subscribed: true,
                unreviewed: true,
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewaySessionsSubscriptionAcknowledgement({
                subscribed: false,
            })
        ).toBeUndefined();

        expect(
            parsePersistentGatewayChatSendAcknowledgement({
                runId: "tasks-notify-event-1",
                serverTiming: { receivedToAckMs: 1 },
                status: "started",
            })
        ).toEqual({ runId: "tasks-notify-event-1", status: "started" });
        expect(
            parsePersistentGatewayChatSendAcknowledgement({
                runId: "tasks-notify-event-1",
                status: "in_flight",
            })
        ).toEqual({ runId: "tasks-notify-event-1", status: "in_flight" });
        expect(
            parsePersistentGatewayChatSendAcknowledgement({
                runId: "tasks-notify-event-1",
                status: "ok",
            })
        ).toEqual({ runId: "tasks-notify-event-1", status: "ok" });
        expect(
            parsePersistentGatewayChatSendAcknowledgement({
                runId: "tasks-notify-event-1",
                status: "accepted",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayChatSendAcknowledgement({
                runId: "tasks-notify-event-1",
                status: "timeout",
            })
        ).toBeUndefined();
    });
});
