import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rejectionError } from "../../../../scripts/testSupport/rejection.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { startPreviewGatewayBroker } from "../../../worker/delivery/previewGatewayBroker.ts";
import {
    buildPreviewGatewaySocketSpecification,
    createPreviewGatewayCapability,
} from "../../../worker/delivery/previewGatewayProxy.ts";
import {
    PersistentGatewayUnavailableError,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";
import {
    createManagedPreviewTaskNotificationTransport,
    createPersistentGatewayPreviewProxyPort,
    createPreviewGatewayTransport,
    type PreviewGatewaySocketClient,
} from "./previewGatewayTransport.ts";

const socketPath = "/run/mira-preview/gateway/gateway.sock";

function decodingClient(
    invoke: PreviewGatewaySocketClient["invoke"]
): PreviewGatewaySocketClient {
    return Object.freeze({ invoke });
}

describe("managed preview Gateway transport", () => {
    test("exposes only the three reviewed Unix capability operations", async () => {
        const calls: unknown[] = [];
        const transport = createPreviewGatewayTransport({
            client: decodingClient((input) => {
                calls.push({
                    operation: input.operation,
                    parameters: parseJsonText(new TextDecoder().decode(input.body)),
                });
                return Promise.resolve(
                    new TextEncoder().encode(JSON.stringify({ sessions: [] }))
                );
            }),
            createRequestId: () => "018f1f0e-7c52-7d63-8f22-b5f776933127",
            socketPath,
        });
        transport.start();

        expect(await transport.request("sessions.list", { limit: 20 })).toEqual({
            sessions: [],
        });
        expect(calls).toEqual([
            { operation: "session-status", parameters: { limit: 20 } },
        ]);
        expect(await rejectionError(transport.request("cron.list", {}))).toBeInstanceOf(
            PersistentGatewayUnavailableError
        );
        expect(
            await rejectionError(transport.requestChatRead("models.list", {}))
        ).toBeInstanceOf(PersistentGatewayUnavailableError);
        expect(transport.snapshot.phase).toBe("connected");
    });

    test("treats a dispatched chat write failure as an unknown outcome", async () => {
        const transport = createPreviewGatewayTransport({
            client: decodingClient(() =>
                Promise.reject(new PersistentGatewayUnavailableError())
            ),
            socketPath,
        });
        transport.start();
        expect(
            await rejectionError(
                transport.requestChatWrite("chat.send", {
                    idempotencyKey: "abcdefghijklmnop",
                    message: "hello",
                    sessionKey: "agent:main:main",
                })
            )
        ).toBeInstanceOf(PersistentGatewayUnknownOutcomeError);
    });

    test("exchanges one real request over the private Unix broker", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-transport-"));
        const stateRoot = path.join(root, "state");
        await mkdir(stateRoot, { mode: 0o700 });
        const capability = await createPreviewGatewayCapability({
            capabilityRoot: stateRoot,
        });
        const broker = await startPreviewGatewayBroker({
            operationId: "019fd974-54a2-74dd-a64b-d4186f8d8801",
            port: {
                invoke: ({ operation }) =>
                    Promise.resolve({
                        body: new TextEncoder().encode(
                            JSON.stringify({ operation, sessions: [] })
                        ),
                    }),
            },
            specification: buildPreviewGatewaySocketSpecification(capability),
        });
        const transport = createPreviewGatewayTransport({
            createRequestId: () => "019fd974-54a2-74dd-a64b-d4186f8d8802",
            socketPath: capability.socketPath,
        });
        try {
            transport.start();
            expect(await transport.request("sessions.list", { limit: 20 })).toEqual({
                operation: "session-status",
                sessions: [],
            });
        } finally {
            await transport.stop();
            await broker.stop();
            await rm(root, { force: true, recursive: true });
        }
    });

    test("maps the host side onto exact authenticated Gateway methods", async () => {
        const calls: unknown[] = [];
        const port = createPersistentGatewayPreviewProxyPort({
            request: (method, parameters) => {
                calls.push({ method, parameters });
                return Promise.resolve({ sessions: [] });
            },
            requestChatRead: (method, parameters) => {
                calls.push({ method, parameters });
                return Promise.resolve({ messages: [] });
            },
            requestChatWrite: (method, parameters) => {
                calls.push({ method, parameters });
                return Promise.resolve({ runId: "run-1", status: "started" });
            },
        });

        const response = await port.invoke({
            body: new TextEncoder().encode(JSON.stringify({ limit: 20 })),
            capability: "not-forwarded",
            operation: "session-status",
        });
        expect(parseJsonText(new TextDecoder().decode(response.body))).toEqual({
            sessions: [],
        });
        expect(calls).toEqual([{ method: "sessions.list", parameters: { limit: 20 } }]);

        expect(
            await rejectionError(
                port.invoke({
                    body: new TextEncoder().encode(
                        JSON.stringify({ limit: "unbounded" })
                    ),
                    capability: "not-forwarded",
                    operation: "session-status",
                })
            )
        ).toBeInstanceOf(Error);
        expect(calls).toHaveLength(1);
    });

    test("keeps the managed preview worker notification lane inert", async () => {
        const transport = createManagedPreviewTaskNotificationTransport();
        transport.start();
        expect(
            await rejectionError(
                transport.taskNotificationSender.send(
                    {
                        idempotencyKey:
                            "tasks-notify-018f1f0e-7c52-7d63-8f22-b5f776933127",
                        message: "preview",
                        sessionKey: "agent:main:main",
                    },
                    new AbortController().signal
                )
            )
        ).toBeInstanceOf(PersistentGatewayUnavailableError);
    });
});
