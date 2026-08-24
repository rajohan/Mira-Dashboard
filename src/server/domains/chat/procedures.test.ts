import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { chatProcedureContracts } from "../../../contracts/chat.ts";
import type { ProcedureContract } from "../../../contracts/registry.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import { type ChatService, ChatServiceError } from "./service.ts";

const sessionKey = "agent:main:main";
const runId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";
const sentinel = "private provider detail /home/ubuntu/secret";

function failingService(reason: ChatServiceError["reason"]): ChatService {
    const fail = (): Promise<never> =>
        Promise.reject(new ChatServiceError(reason, { cause: new Error(sentinel) }));
    return new Proxy(
        {},
        {
            get: () => fail,
        }
    ) as ChatService;
}

async function caller(reason: ChatServiceError["reason"]) {
    const context = await createTestRequestContext(
        createTestSessionAuthentication(["chat:read", "chat:write"])
    );
    return appRouter.createCaller({
        ...context,
        chatService: failingService(reason),
    }).chat;
}

async function expectFailure(
    operation: () => Promise<unknown>,
    code: TRPCError["code"],
    message: string
): Promise<TRPCError> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect(failure).toMatchObject({ code, message });
    expect((failure as TRPCError).message).not.toContain(sentinel);
    return failure as TRPCError;
}

describe("chat procedures", () => {
    test("locks subscription and provider failures to the declared safe route errors", async () => {
        await expectFailure(
            () => caller("capacity").then((chat) => chat.history({ sessionKey })),
            "TOO_MANY_REQUESTS",
            "Chat capacity is temporarily full"
        );
        await expectFailure(
            () =>
                caller("provider-unavailable").then((chat) =>
                    chat.getMessage({ messageId: "message-1", sessionKey })
                ),
            "SERVICE_UNAVAILABLE",
            "Chat provider is temporarily unavailable"
        );
        await expectFailure(
            () =>
                caller("provider-unavailable").then((chat) =>
                    chat.runtime({ sessionKey })
                ),
            "SERVICE_UNAVAILABLE",
            "Chat provider is temporarily unavailable"
        );
        await expectFailure(
            () => caller("capacity").then((chat) => chat.abort({ runId, sessionKey })),
            "TOO_MANY_REQUESTS",
            "Chat capacity is temporarily full"
        );
        await expectFailure(
            () => caller("conflict").then((chat) => chat.companionReset({ sessionKey })),
            "CONFLICT",
            "Chat state changed; refresh before retrying"
        );
    });

    test("maps malformed, capacity, and disposed attachment preparation safely", async () => {
        const input = {
            files: [
                {
                    fileName: "note.txt",
                    mimeType: "text/plain",
                    sizeBytes: 1,
                },
            ],
            idempotencyKey: "A".repeat(32),
            sessionKey,
        };
        for (const [reason, code, message] of [
            ["invalid-input", "BAD_REQUEST", "Chat input is invalid"],
            ["capacity", "TOO_MANY_REQUESTS", "Chat capacity is temporarily full"],
            [
                "provider-unavailable",
                "SERVICE_UNAVAILABLE",
                "Chat provider is temporarily unavailable",
            ],
        ] as const) {
            await expectFailure(
                () => caller(reason).then((chat) => chat.prepareAttachmentTicket(input)),
                code,
                message
            );
        }
    });

    test("exposes unknown companion outcomes only through the allowlisted reason", async () => {
        for (const operation of ["ask", "reset"] as const) {
            const chat = await caller("unknown-outcome");
            const failure = await expectFailure(
                () =>
                    operation === "ask"
                        ? chat.companionAsk({ question: "Explain", sessionKey })
                        : chat.companionReset({ sessionKey }),
                "SERVICE_UNAVAILABLE",
                "Chat provider outcome could not be confirmed"
            );
            expect(failure).toHaveProperty("cause.reason", "operation_outcome_unknown");
        }
    });

    test("passes the authenticated actor into companion rate admission", async () => {
        let observedActor: unknown;
        const service = new Proxy(
            {},
            {
                get: (_target, property) =>
                    property === "companionAsk"
                        ? (_input: unknown, actor: unknown) => {
                              observedActor = actor;
                              return Promise.resolve({
                                  answer: "answer",
                                  timestampMs: 1000,
                              });
                          }
                        : () =>
                              Promise.reject(new Error("Unexpected chat service method")),
            }
        ) as ChatService;
        const context = await createTestRequestContext(
            createTestAutomationAuthentication(["chat:write"])
        );

        expect(
            await appRouter
                .createCaller({ ...context, chatService: service })
                .chat.companionAsk({ question: "Explain", sessionKey })
        ).toEqual({ answer: "answer", timestampMs: 1000 });
        expect(observedActor).toEqual({ id: "test-automation", kind: "automation" });
    });

    test("redacts provider details from the companion unknown-outcome wire shape", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["chat:write"])
        );
        const response = await fetchRequestHandler({
            createContext: () => ({
                ...context,
                chatService: failingService("unknown-outcome"),
            }),
            endpoint: "/trpc",
            req: new Request("http://localhost/trpc/chat.companionAsk", {
                body: JSON.stringify({
                    json: { question: "Explain", sessionKey },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            router: appRouter,
        });
        const text = await response.text();

        expect(response.status).toBe(503);
        expect(text).toContain('"reason":"operation_outcome_unknown"');
        expect(text).toContain("Chat provider outcome could not be confirmed");
        expect(text).not.toContain(sentinel);
        expect(text).not.toContain('"cause"');
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("declares the exact companion reasons and query capacity surface", () => {
        const contracts = new Map<string, ProcedureContract>(
            chatProcedureContracts.map((contract) => [contract.name, contract])
        );
        expect(contracts.get("chat.companionAsk")?.errorReasons).toEqual([
            "operation_outcome_unknown",
        ]);
        expect(contracts.get("chat.companionReset")?.errorReasons).toEqual([
            "operation_outcome_unknown",
        ]);
        expect(contracts.get("chat.companionReset")?.errors).toContain("CONFLICT");
        for (const name of ["chat.getMessage", "chat.history", "chat.runtime"]) {
            expect(contracts.get(name)?.errors).toEqual([
                "FORBIDDEN",
                "SERVICE_UNAVAILABLE",
                "TOO_MANY_REQUESTS",
                "UNAUTHORIZED",
            ]);
        }
    });
});
