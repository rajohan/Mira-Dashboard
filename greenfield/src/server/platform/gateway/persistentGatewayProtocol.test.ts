import { describe, expect, test } from "bun:test";

import { chatAttachmentLimits } from "../../../contracts/chatMedia.ts";
import { chatPlanExplanationMaximumCodeUnits } from "../../../contracts/chatModel.ts";
import {
    assertPersistentGatewayAdminParameters,
    assertPersistentGatewayChatReadParameters,
    assertPersistentGatewayChatReadMutationParameters,
    assertPersistentGatewayChatWriteParameters,
    assertPersistentGatewayOpenClawSettingsReadParameters,
    assertPersistentGatewayOpenClawSettingsWriteParameters,
    assertPersistentGatewayReadWriteParameters,
    assertPersistentGatewayTaskReadParameters,
    assertPersistentGatewayTaskWriteParameters,
    createPersistentGatewayConnectFrame,
    isPersistentGatewayAdminMethod,
    isPersistentGatewayOpenClawSettingsReadMethod,
    isPersistentGatewayOpenClawSettingsWriteMethod,
    isPersistentGatewayReadWriteMethod,
    parsePersistentGatewayChallenge,
    parsePersistentGatewayChatSendAcknowledgement,
    parsePersistentGatewayEvent,
    parsePersistentGatewayEventEnvelope,
    parsePersistentGatewayHello,
    parsePersistentGatewayPrivateChatEvent,
    parsePersistentGatewayResponse,
    parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement,
    parsePersistentGatewaySessionsSubscriptionAcknowledgement,
    persistentGatewayAdminMethods,
    persistentGatewayAgentEventDataMaximumBytes,
    persistentGatewayAuthenticatedFrameMaximumBytes,
    persistentGatewayBufferedAmountPolicyMaximumBytes,
    persistentGatewayChatHistoryMaximumChars,
    persistentGatewayChatOutboundFrameMaximumBytes,
    persistentGatewayReadWriteMethods,
    persistentGatewayChatReadMethods,
    persistentGatewayChatReadMutationMethods,
    persistentGatewayChatWriteMethods,
    persistentGatewayOpenClawSettingsReadMethods,
    persistentGatewayOpenClawSettingsWriteMethods,
    persistentGatewaySessionScopedEventsCapability,
    persistentGatewayTaskNotificationMethod,
    persistentGatewayTaskReadMethods,
    persistentGatewayTaskWriteMethods,
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
            events: input.events ?? ["tick", "sessions.changed", "cron", "task"],
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
        const chatWrite = createPersistentGatewayConnectFrame({
            clientVersion: "0.0.0",
            credential: "redacted-fixture-token",
            instanceId: "dashboard-process-1",
            profile: "chat-write",
            requestId: "connect-4",
        });
        const chatReadMutation = createPersistentGatewayConnectFrame({
            clientVersion: "0.0.0",
            credential: "redacted-fixture-token",
            instanceId: "dashboard-process-1",
            profile: "chat-read-mutation",
            requestId: "connect-5",
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
        expect(chatWrite.params as Readonly<Record<string, unknown>>).toMatchObject({
            caps: [persistentGatewaySessionScopedEventsCapability],
            client: { displayName: "Mira Dashboard bounded chat write" },
            scopes: ["operator.write"],
        });
        expect(
            chatReadMutation.params as Readonly<Record<string, unknown>>
        ).toMatchObject({
            caps: [persistentGatewaySessionScopedEventsCapability],
            client: {
                displayName: "Mira Dashboard bounded chat read-scope mutation",
            },
            scopes: ["operator.read"],
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
            "sessions.patch",
            "sessions.reset",
        ]);
        expect(persistentGatewayChatReadMethods).toEqual([
            "chat.history",
            "chat.message.get",
            "models.list",
            "sessions.companion.state",
        ]);
        expect(persistentGatewayChatReadMutationMethods).toEqual([
            "sessions.companion.ask",
        ]);
        expect(persistentGatewayChatWriteMethods).toEqual([
            "chat.abort",
            "chat.send",
            "sessions.companion.reset",
        ]);
        expect(persistentGatewayTaskReadMethods).toEqual(["tasks.get", "tasks.list"]);
        expect(persistentGatewayTaskWriteMethods).toEqual(["tasks.cancel"]);
        expect(persistentGatewayOpenClawSettingsReadMethods).toEqual([
            "config.get",
            "skills.status",
        ]);
        expect(persistentGatewayOpenClawSettingsWriteMethods).toEqual(["config.patch"]);
        expect(isPersistentGatewayReadWriteMethod("sessions.list")).toBe(true);
        expect(isPersistentGatewayReadWriteMethod("chat.send")).toBe(false);
        expect(isPersistentGatewayReadWriteMethod("config.patch")).toBe(false);
        expect(isPersistentGatewayAdminMethod("cron.run")).toBe(true);
        expect(isPersistentGatewayAdminMethod("config.patch")).toBe(false);
        expect(isPersistentGatewayOpenClawSettingsReadMethod("config.get")).toBe(true);
        expect(isPersistentGatewayOpenClawSettingsWriteMethod("config.patch")).toBe(true);
        expect(isPersistentGatewayOpenClawSettingsWriteMethod("skills.update")).toBe(
            false
        );
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

    test("strictly binds Settings methods to server-built parameters", () => {
        expect(() =>
            assertPersistentGatewayOpenClawSettingsReadParameters("config.get", {})
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayOpenClawSettingsReadParameters("skills.status", {
                agentId: "main",
            })
        ).toThrow(TypeError);
        const baseHash = "a".repeat(64);
        const modelPatch = {
            baseHash,
            note: "Updated from Mira Dashboard settings",
            raw: JSON.stringify({
                agents: {
                    defaults: {
                        model: {
                            fallbacks: ["openai/gpt-5.6-terra"],
                            primary: "openai/gpt-5.6-sol",
                        },
                    },
                },
            }),
            replacePaths: ["agents.defaults.model.fallbacks"],
        };
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters(
                "config.patch",
                modelPatch
            )
        ).not.toThrow();
        const skillPatch = {
            baseHash,
            note: "Updated from Mira Dashboard settings",
            raw: JSON.stringify({
                skills: { entries: { imagegen: { enabled: false } } },
            }),
        };
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters(
                "config.patch",
                skillPatch
            )
        ).not.toThrow();
        const agentToolPatch = {
            baseHash,
            note: "Updated from Mira Dashboard settings",
            raw: JSON.stringify({
                agents: {
                    entries: {
                        main: {
                            tools: {
                                alsoAllow: ["cron", "web_fetch"],
                                deny: ["web_search", "custom-tool"],
                            },
                        },
                    },
                },
            }),
            replacePaths: [
                "agents.entries.main.tools.alsoAllow",
                "agents.entries.main.tools.deny",
            ],
        };
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters(
                "config.patch",
                agentToolPatch
            )
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                ...agentToolPatch,
                replacePaths: ["agents.entries.main.tools.alsoAllow"],
            })
        ).toThrow(TypeError);
        for (const unsafeAgentId of ["main.with-dot", "__proto__"]) {
            expect(() =>
                assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                    ...agentToolPatch,
                    raw: JSON.stringify({
                        agents: {
                            entries: {
                                [unsafeAgentId]: {
                                    tools: { alsoAllow: [], deny: [] },
                                },
                            },
                        },
                    }),
                    replacePaths: [
                        `agents.entries.${unsafeAgentId}.tools.alsoAllow`,
                        `agents.entries.${unsafeAgentId}.tools.deny`,
                    ],
                })
            ).toThrow(TypeError);
        }
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                ...agentToolPatch,
                raw: JSON.stringify({
                    agents: {
                        entries: {
                            main: {
                                default: true,
                                tools: { alsoAllow: [], deny: [] },
                            },
                        },
                    },
                }),
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                ...skillPatch,
                raw: JSON.stringify({
                    skills: {
                        entries: {
                            imagegen: { apiKey: "secret", enabled: false },
                        },
                    },
                }),
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                ...skillPatch,
                raw: JSON.stringify({
                    skills: {
                        entries: {
                            imagegen: { enabled: false },
                            zotero: { enabled: true },
                        },
                    },
                }),
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                baseHash,
                note: "Updated from Mira Dashboard settings",
                raw: JSON.stringify({
                    tools: {
                        agentToAgent: { enabled: true },
                        elevated: { enabled: false },
                        exec: {
                            ask: "on-miss",
                            mode: null,
                            security: "allowlist",
                        },
                        profile: "coding",
                        sessions: { visibility: "agent" },
                        web: {
                            fetch: { enabled: true },
                            search: { enabled: true, provider: "brave" },
                        },
                    },
                }),
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                ...modelPatch,
                replacePaths: undefined,
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                baseHash,
                note: "Updated from Mira Dashboard settings",
                raw: JSON.stringify({ gateway: { auth: { token: "secret" } } }),
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                baseHash,
                note: "Updated from Mira Dashboard settings",
                raw: "x".repeat(64 * 1024 + 1),
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayOpenClawSettingsWriteParameters("config.patch", {
                baseHash,
                note: "Updated from Mira Dashboard settings",
                raw: "\u00E5".repeat(32 * 1024 + 1),
            })
        ).toThrow(TypeError);
    });

    test("strictly validates every audited chat request shape", () => {
        expect(() =>
            assertPersistentGatewayChatReadParameters("chat.history", {
                limit: 100,
                maxChars: persistentGatewayChatHistoryMaximumChars,
                offset: 0,
                sessionKey: "agent:main:main",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayChatReadParameters("chat.history", {
                limit: 100,
                maxChars: persistentGatewayChatHistoryMaximumChars + 1,
                offset: 0,
                sessionKey: "agent:main:main",
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayChatReadParameters("chat.history", {
                messageId: "message-1",
                offset: 0,
                sessionKey: "agent:main:main",
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayChatReadParameters("chat.message.get", {
                maxChars: 1024 * 1024,
                messageId: "message-1",
                sessionKey: "agent:main:main",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayChatReadParameters("models.list", {
                includeProviderCapabilities: false,
                view: "configured",
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayChatReadMutationParameters("sessions.companion.ask", {
                question: "   ",
                sessionKey: "agent:main:main",
            })
        ).toThrow(TypeError);

        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.send", {
                attachments: [
                    {
                        content: "ZmlsZQ==",
                        fileName: "fixture.txt",
                        mimeType: "text/plain",
                        sizeBytes: 4,
                        type: "file",
                    },
                ],
                idempotencyKey: "abcdefghijklmnop",
                message: "hello",
                sessionKey: "agent:main:main",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.send", {
                attachments: [
                    {
                        content: "ZmlsZQ==",
                        fileName: "fixture.txt",
                        mimeType: "text/plain",
                        sizeBytes: 5,
                        type: "file",
                    },
                ],
                idempotencyKey: "abcdefghijklmnop",
                message: "hello",
                sessionKey: "agent:main:main",
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.send", {
                idempotencyKey: "too-short",
                message: "hello",
                sessionKey: "agent:main:main",
                unreviewed: true,
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.abort", {
                preserveSideRuns: false,
                runId: "provider-run-1",
                sessionKey: "agent:main:main",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.abort", {
                preserveSideRuns: true,
                sessionKey: "agent:main:main",
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayAdminParameters("sessions.patch", {
                expectedSessionId: "session-1",
                fastMode: "auto",
                key: "agent:main:main",
                model: "openai/gpt-5.6-sol",
                thinkingLevel: "high",
            })
        ).not.toThrow();

        expect(() =>
            assertPersistentGatewayTaskReadParameters("tasks.list", {
                cursor: "0",
                limit: 200,
                status: ["running", "failed"],
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayTaskReadParameters("tasks.list", {
                cursor: "01",
                limit: 201,
                status: [],
            })
        ).toThrow(TypeError);
        expect(() =>
            assertPersistentGatewayTaskReadParameters("tasks.get", {
                taskId: "task-1",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayTaskWriteParameters("tasks.cancel", {
                reason: "operator stop",
                taskId: "task-1",
            })
        ).not.toThrow();
        expect(() =>
            assertPersistentGatewayAdminParameters("sessions.patch", {
                key: "agent:main:main",
                model: "x".repeat(257),
            })
        ).toThrow(TypeError);
    });

    test("keeps the maximum accepted attachment send inside the exact serialized frame", () => {
        const loneHighSurrogate = String.fromCodePoint(55_296);
        const parameters = {
            attachments: [
                {
                    content: Buffer.alloc(
                        chatAttachmentLimits.maximumAggregateRawBytes,
                        0x61
                    ).toString("base64"),
                    fileName: loneHighSurrogate.repeat(255),
                    mimeType: `application/${"a".repeat(64)}`,
                    sizeBytes: chatAttachmentLimits.maximumAggregateRawBytes,
                    type: "file" as const,
                },
            ],
            fastMode: "auto" as const,
            idempotencyKey: "a".repeat(128),
            message: loneHighSurrogate.repeat(256 * 1024),
            queueMode: "interrupt" as const,
            sessionKey: loneHighSurrogate.repeat(512),
            thinking: loneHighSurrogate.repeat(128),
        };

        expect(() =>
            assertPersistentGatewayChatWriteParameters("chat.send", parameters)
        ).not.toThrow();
        const encodedBytes = Buffer.byteLength(
            JSON.stringify({
                id: loneHighSurrogate.repeat(128),
                method: "chat.send",
                params: parameters,
                type: "req",
            }),
            "utf8"
        );
        expect(encodedBytes).toBeLessThanOrEqual(
            persistentGatewayChatOutboundFrameMaximumBytes
        );
        expect(encodedBytes).toBeGreaterThan(
            persistentGatewayChatOutboundFrameMaximumBytes - 2 * 1024 * 1024
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
        expect(
            parsePersistentGatewayHello(
                hello({ events: ["tick"], scopes: ["operator.write"] }),
                "chat-write"
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
        const sessionLifecycleSecret = "Bearer private-session-event-field";
        const resetLifecycle = parsePersistentGatewayEvent({
            event: "sessions.changed",
            payload: {
                privateField: sessionLifecycleSecret,
                reason: "reset",
                sessionId: "provider-session-1",
                sessionKey: "agent:main:main",
                ts: 1234,
                updatedAt: 1200,
            },
            type: "event",
        });
        expect(resetLifecycle).toEqual({
            event: "sessions.changed",
            sessionLifecycle: {
                occurredAtMs: 1234,
                reason: "reset",
                sessionId: "provider-session-1",
                sessionKey: "agent:main:main",
                updatedAtMs: 1200,
            },
            type: "event",
        });
        expect(JSON.stringify(resetLifecycle)).not.toContain(sessionLifecycleSecret);
        expect(
            parsePersistentGatewayEvent({
                event: "sessions.changed",
                payload: {
                    compacted: false,
                    reason: "compact",
                    sessionKey: "agent:main:main",
                    ts: 1300,
                },
                type: "event",
            })
        ).toEqual({
            event: "sessions.changed",
            sessionLifecycle: {
                compacted: false,
                occurredAtMs: 1300,
                reason: "compact",
                sessionKey: "agent:main:main",
            },
            type: "event",
        });
        expect(
            parsePersistentGatewayEvent({
                event: "sessions.changed",
                payload: { reason: "delete", ts: 1400 },
                type: "event",
            })
        ).toEqual({
            event: "sessions.changed",
            sessionLifecycle: { occurredAtMs: 1400, reason: "delete" },
            type: "event",
        });
        expect(
            parsePersistentGatewayEvent({
                event: "sessions.changed",
                payload: {
                    compacted: "yes",
                    reason: "compact",
                    sessionKey: "agent:main:main",
                    ts: 1500,
                },
                type: "event",
            })
        ).toEqual({ event: "sessions.changed", type: "event" });
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
            parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement(
                { key: "agent:main:main", subscribed: true },
                true
            )
        ).toEqual({ key: "agent:main:main", subscribed: true });
        expect(
            parsePersistentGatewaySessionMessagesSubscriptionAcknowledgement(
                { key: "agent:main:main", subscribed: false },
                true
            )
        ).toBeUndefined();

        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "chat",
                payload: {
                    deltaText: "hello",
                    runId: "provider-run-1",
                    seq: 1,
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            })
        ).toEqual({
            event: "chat",
            payload: {
                deltaText: "hello",
                runId: "provider-run-1",
                seq: 1,
                sessionKey: "agent:main:main",
                state: "delta",
            },
        });
        const privateBulkValue = "Bearer provider-private-chat-frame";
        const projectedBulkEvent = parsePersistentGatewayPrivateChatEvent({
            event: "chat",
            payload: {
                deltaText: "bounded delta",
                message: { content: privateBulkValue },
                runId: "provider-run-bulk",
                seq: 1,
                sessionKey: "agent:main:main",
                state: "delta",
                usage: { privateBulkValue },
            },
            type: "event",
        });
        expect(projectedBulkEvent).toEqual({
            event: "chat",
            payload: {
                deltaText: "bounded delta",
                runId: "provider-run-bulk",
                seq: 1,
                sessionKey: "agent:main:main",
                state: "delta",
            },
        });
        expect(JSON.stringify(projectedBulkEvent)).not.toContain(privateBulkValue);
        const planEvent = parsePersistentGatewayPrivateChatEvent({
            event: "agent",
            payload: {
                data: {
                    explanation: "界".repeat(chatPlanExplanationMaximumCodeUnits),
                    phase: "update",
                    privateValue: privateBulkValue,
                    source: "provider-private-source",
                    steps: [{ status: "pending", step: "Inspect" }],
                    title: "Provider-private title",
                },
                runId: "provider-plan-projected",
                seq: 2,
                sessionKey: "agent:main:main",
                stream: "plan",
                ts: 1000,
            },
            type: "event",
        });
        expect(planEvent).toMatchObject({
            payload: {
                data: {
                    explanation: "界".repeat(chatPlanExplanationMaximumCodeUnits),
                    phase: "update",
                    steps: [{ status: "pending", step: "Inspect" }],
                },
            },
        });
        expect(JSON.stringify(planEvent)).not.toContain("provider-private");
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: {
                        privateBulkValue: "x".repeat(
                            persistentGatewayAgentEventDataMaximumBytes
                        ),
                        text: "bounded assistant delta",
                    },
                    runId: "provider-run-projected",
                    seq: 1,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    ts: 1000,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: { text: "bounded assistant delta" },
                runId: "provider-run-projected",
                seq: 1,
                sessionKey: "agent:main:main",
                stream: "assistant",
                ts: 1000,
            },
        });
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "session.tool",
                payload: {
                    data: {
                        args: { cmd: "bun test" },
                        name: "bash",
                        phase: "start",
                        toolCallId: "codex-command-1",
                    },
                    runId: "provider-run-session-tool",
                    seq: 4,
                    sessionKey: "agent:main:main",
                    stream: "tool",
                    ts: 1002,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: {
                    args: { cmd: "bun test" },
                    name: "bash",
                    phase: "start",
                    toolCallId: "codex-command-1",
                },
                runId: "provider-run-session-tool",
                seq: 4,
                sessionKey: "agent:main:main",
                stream: "tool",
                ts: 1002,
            },
        });
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: {
                        args: { secret: "must-not-cross" },
                        completed: true,
                        phase: "end",
                        privateDetail: "must-not-cross",
                        willRetry: false,
                    },
                    runId: "provider-run-compaction",
                    seq: 5,
                    sessionKey: "agent:main:main",
                    stream: "compaction",
                    ts: 1003,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: { completed: true, phase: "end", willRetry: false },
                runId: "provider-run-compaction",
                seq: 5,
                sessionKey: "agent:main:main",
                stream: "compaction",
                ts: 1003,
            },
        });
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: {
                        isReasoningSnapshot: true,
                        text: "Cumulative reasoning",
                    },
                    runId: "provider-reasoning-snapshot",
                    seq: 5,
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                    ts: 1003,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: {
                    isReasoningSnapshot: true,
                    text: "Cumulative reasoning",
                },
                runId: "provider-reasoning-snapshot",
                seq: 5,
                sessionKey: "agent:main:main",
                stream: "thinking",
                ts: 1003,
            },
        });
        const unsupportedPrivateValue = "Bearer unsupported-private-agent-frame";
        const unsupportedAgentEvent = parsePersistentGatewayPrivateChatEvent({
            event: "agent",
            payload: {
                agentId: "main",
                data: {
                    hook: "before_model",
                    privateValue: unsupportedPrivateValue,
                },
                isHeartbeat: false,
                runId: "provider-run-codex-hook",
                seq: 3,
                sessionKey: "agent:main:main",
                stream: "codex_app_server.hook",
                ts: 1001,
            },
            type: "event",
        });
        expect(unsupportedAgentEvent).toEqual({
            event: "agent",
            payload: {
                agentId: "main",
                data: {},
                runId: "provider-run-codex-hook",
                seq: 3,
                sessionKey: "agent:main:main",
                stream: "unsupported",
                ts: 1001,
            },
        });
        expect(JSON.stringify(unsupportedAgentEvent)).not.toContain(
            unsupportedPrivateValue
        );
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: "malformed known stream data",
                    runId: "provider-run-malformed-assistant",
                    seq: 4,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    ts: 1002,
                },
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: {
                        text: "x".repeat(persistentGatewayAgentEventDataMaximumBytes),
                    },
                    runId: "provider-run-oversized",
                    seq: 1,
                    sessionKey: "agent:main:main",
                    stream: "assistant",
                    ts: 1000,
                },
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "chat",
                payload: {
                    deltaText: "x".repeat(64 * 1024 + 1),
                    runId: "provider-run-oversized-delta",
                    seq: 1,
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
            })
        ).toBeUndefined();
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: { delta: "thinking" },
                    runId: "provider-run-1",
                    seq: 2,
                    sessionKey: "agent:main:main",
                    stream: "thinking",
                    ts: 1000,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: { delta: "thinking" },
                runId: "provider-run-1",
                seq: 2,
                sessionKey: "agent:main:main",
                stream: "thinking",
                ts: 1000,
            },
        });
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "agent",
                payload: {
                    data: {
                        kind: "preamble",
                        progressText: "Checking the live session.",
                    },
                    runId: "provider-run-preamble",
                    seq: 3,
                    sessionKey: "agent:main:main",
                    stream: "item",
                    ts: 1001,
                },
                type: "event",
            })
        ).toEqual({
            event: "agent",
            payload: {
                data: {
                    kind: "preamble",
                    progressText: "Checking the live session.",
                },
                runId: "provider-run-preamble",
                seq: 3,
                sessionKey: "agent:main:main",
                stream: "item",
                ts: 1001,
            },
        });
        expect(
            parsePersistentGatewayPrivateChatEvent({
                event: "chat",
                payload: {
                    runId: "provider-run-1",
                    seq: 0,
                    sessionKey: "agent:main:main",
                    state: "delta",
                },
                type: "event",
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
