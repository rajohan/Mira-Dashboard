import type { ChatSendOutput } from "../../contracts/chat.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import {
    prepareAndUploadChatAttachments,
    type ChatAttachmentProgress,
} from "./chatAttachments.ts";
import type { ChatDraftAttachment, ChatSendSettings } from "./chatTypes.ts";

export interface ChatSendIdentity {
    readonly clientRunId: string;
    readonly idempotencyKey: string;
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

function hexadecimal(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates a lowercase UUIDv7 accepted by the durable chat-run contract.
 * @param nowMs Caller-owned admission timestamp.
 * @returns A locally generated UUIDv7 run identity.
 */
export function createChatClientRunId(nowMs = Date.now()): string {
    const bytes = randomBytes(16);
    let timestamp = Math.max(0, Math.min(nowMs, 281_474_976_710_655));
    for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = timestamp % 256;
        timestamp = Math.floor(timestamp / 256);
    }
    bytes[6] = (bytes[6]! & 15) | 112;
    bytes[8] = (bytes[8]! & 63) | 128;
    const value = hexadecimal(bytes);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Creates one caller-owned lost-response key reused by ticket preparation and send.
 * @returns A 128-bit lowercase hexadecimal replay key.
 */
export function createChatIdempotencyKey(): string {
    return hexadecimal(randomBytes(16));
}

/**
 * Creates the exact identities reused by optimistic state and durable admission.
 * @param nowMs Caller-owned admission timestamp.
 * @returns One UUIDv7 run id and random idempotency key.
 */
export function createChatSendIdentity(nowMs = Date.now()): ChatSendIdentity {
    return {
        clientRunId: createChatClientRunId(nowMs),
        idempotencyKey: createChatIdempotencyKey(),
    };
}

export interface ExecuteChatSendInput {
    readonly attachments: readonly ChatDraftAttachment[];
    readonly identity: ChatSendIdentity;
    readonly message: string;
    readonly onAttachmentProgress: ChatAttachmentProgress;
    readonly sessionKey: string;
    readonly settings: ChatSendSettings;
    readonly signal: AbortSignal;
}

/**
 * Uploads raw files and admits the send under one exact idempotency identity.
 * @param client Validating browser tRPC client.
 * @param input Send, attachment, and auth-boundary input.
 * @returns The durable send admission readback.
 */
export async function executeChatSend(
    client: DashboardTrpcClient,
    input: ExecuteChatSendInput
): Promise<ChatSendOutput> {
    const attachment =
        input.attachments.length === 0
            ? undefined
            : await prepareAndUploadChatAttachments(
                  {
                      mutation: (name, value, options) =>
                          client.mutation(name, value, options),
                  },
                  input.sessionKey,
                  input.attachments,
                  input.identity.idempotencyKey,
                  input.signal,
                  input.onAttachmentProgress
              );
    return client.mutation(
        "chat.send",
        {
            ...(attachment === undefined
                ? {}
                : { attachmentTicketId: attachment.ticketId }),
            clientRunId: input.identity.clientRunId,
            idempotencyKey: input.identity.idempotencyKey,
            message: input.message,
            sessionKey: input.sessionKey,
            settings: {
                fastMode: input.settings.speed === "fast",
                ...(input.settings.thinking === undefined
                    ? {}
                    : { thinkingLevel: input.settings.thinking }),
            },
        },
        { signal: input.signal }
    );
}

/**
 * Unknown outcomes stay visible and gated; definite failures may restore the draft.
 * @param error Sanitized or transport mutation failure.
 * @returns Whether to retain pending state or restore the draft.
 */
export function chatSendFailureDisposition(error: unknown): "keep-pending" | "restore" {
    return isDashboardOperationOutcomeUnknown(error) ? "keep-pending" : "restore";
}
