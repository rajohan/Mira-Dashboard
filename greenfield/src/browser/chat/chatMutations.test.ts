import { describe, expect, jest, test } from "bun:test";

import * as v from "valibot";

import { chatSendInputSchema } from "../../contracts/chat.ts";
import { chatRunIdSchema } from "../../contracts/chatModel.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    chatSendFailureDisposition,
    createChatSendIdentity,
    executeChatSend,
} from "./chatMutations.ts";

describe("chat mutations", () => {
    test("creates contract-valid UUIDv7 and lost-response identities", () => {
        const identity = createChatSendIdentity(1_800_000_000_000);
        expect(v.parse(chatRunIdSchema, identity.clientRunId)).toBe(identity.clientRunId);
        expect(identity.idempotencyKey).toMatch(/^[0-9a-f]{32}$/u);
    });

    test("admits one send without overriding the provider-owned queue mode", async () => {
        const identity = createChatSendIdentity();
        let observedInput: unknown;
        const mutation = jest.fn((_: string, input: unknown) => {
            observedInput = input;
            return Promise.resolve({
                admission: "created",
                run: { id: identity.clientRunId },
            });
        });
        await executeChatSend({ mutation } as unknown as DashboardTrpcClient, {
            attachments: [],
            identity,
            message: "Hello",
            onAttachmentProgress: jest.fn(),
            sessionKey: "agent:main:main",
            settings: { model: "gpt-5", speed: "fast", thinking: "high" },
            signal: new AbortController().signal,
        });
        const parsed = v.parse(chatSendInputSchema, observedInput);
        expect(parsed).toMatchObject({
            clientRunId: identity.clientRunId,
            idempotencyKey: identity.idempotencyKey,
        });
        expect(parsed).not.toHaveProperty("queueMode");
        expect(mutation).toHaveBeenCalledTimes(1);
    });

    test("gates only explicitly unknown mutation outcomes", () => {
        expect(
            chatSendFailureDisposition({
                data: { reason: "operation_outcome_unknown" },
            })
        ).toBe("keep-pending");
        expect(chatSendFailureDisposition(new Error("definite"))).toBe("restore");
    });
});
