import * as v from "valibot";

import {
    chatHistoryInputSchema,
    chatHistoryOutputSchema,
    chatMessageGetInputSchema,
    chatMessageGetOutputSchema,
    type ChatHistoryInput,
    type ChatHistoryOutput,
    type ChatMessageGetInput,
    type ChatMessageGetOutput,
} from "../../../contracts/chat.ts";
import {
    chatHistoryProviderPageMaximum,
    chatHistoryResponseMaximumBytes,
    chatMessageHydrationMaximumBytes,
    chatMessageSchema,
    type ChatMessage,
} from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import type { ChatProvider, ChatProviderInFlightRun } from "./provider.ts";

export interface ChatHistoryAliasResolver {
    readonly resolveLocalRunId: (
        alias: Readonly<{
            historyMessageId: string;
            idempotencyKey?: string;
            providerRunId?: string;
            sessionKey: string;
        }>
    ) => string | undefined;
}

export interface ChatProviderObservationBoundary {
    readonly epoch: number;
    readonly observedAtMs: number;
}

export interface ChatHistoryObservationPort {
    readonly beginObservation: (sessionKey: string) => ChatProviderObservationBoundary;
    readonly observeHistoryMessages: (
        sessionKey: string,
        messages: readonly ChatMessage[],
        observation: ChatProviderObservationBoundary
    ) => void | Promise<void>;
    readonly observeInFlightRun: (
        sessionKey: string,
        inFlightRun: ChatProviderInFlightRun | undefined,
        observation: ChatProviderObservationBoundary
    ) => void | Promise<void>;
}

function promoteLocalRunAlias(
    message: ChatMessage,
    sessionKey: string,
    aliases: ChatHistoryAliasResolver | undefined
): ChatMessage {
    const { localRunId: _providerLocalRunId, ...providerMessage } = message;
    const localRunId = aliases?.resolveLocalRunId({
        historyMessageId: message.id,
        ...(message.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: message.idempotencyKey }),
        ...(message.runId === undefined ? {} : { providerRunId: message.runId }),
        sessionKey,
    });
    return v.parse(chatMessageSchema, {
        ...providerMessage,
        ...(localRunId === undefined ? {} : { localRunId }),
    });
}

function previewText(message: ChatMessage): string | undefined {
    if (message.content.kind === "hydration-required") return message.content.preview;
    const text = message.content.parts
        .flatMap((part) => {
            switch (part.kind) {
                case "text":
                case "thinking":
                case "control": {
                    return [part.text];
                }
                case "tool": {
                    return part.output === undefined ? [] : [part.output];
                }
                default: {
                    return [];
                }
            }
        })
        .join("\n");
    return text.length === 0 ? undefined : text.slice(0, 4096);
}

function hydrationPlaceholder(message: ChatMessage, includePreview = true): ChatMessage {
    const preview = includePreview ? previewText(message) : undefined;
    return v.parse(chatMessageSchema, {
        ...message,
        content: {
            kind: "hydration-required",
            ...(preview === undefined ? {} : { preview }),
            reason: "response-budget",
        },
    });
}

function outputBytes(
    messages: readonly ChatMessage[],
    input: ChatHistoryInput,
    providerPagesRead: number,
    nextCursor: string | undefined,
    sessionId: string | undefined,
    truncated: boolean
): number {
    return utf8ByteLength(
        JSON.stringify({
            messages,
            ...(nextCursor === undefined ? {} : { nextCursor }),
            providerPagesRead,
            ...(sessionId === undefined ? {} : { sessionId }),
            sessionKey: input.sessionKey,
            truncated,
        })
    );
}

/** Bounded two-page Gateway history projection and exact-message hydration. */
export class ChatHistoryService {
    readonly #aliases: ChatHistoryAliasResolver | undefined;
    readonly #observations: ChatHistoryObservationPort | undefined;
    readonly #provider: ChatProvider;

    public constructor(
        provider: ChatProvider,
        aliases?: ChatHistoryAliasResolver,
        observations?: ChatHistoryObservationPort
    ) {
        this.#aliases = aliases;
        this.#observations = observations;
        this.#provider = provider;
    }

    public async getMessage(
        rawInput: ChatMessageGetInput,
        signal?: AbortSignal
    ): Promise<ChatMessageGetOutput> {
        const input = v.parse(chatMessageGetInputSchema, rawInput);
        const output = v.parse(
            chatMessageGetOutputSchema,
            await this.#provider.getMessage(
                {
                    maxChars: chatMessageHydrationMaximumBytes,
                    messageId: input.messageId,
                    sessionKey: input.sessionKey,
                },
                signal
            )
        );
        if (output.status === "unavailable") return output;
        return v.parse(chatMessageGetOutputSchema, {
            message: promoteLocalRunAlias(
                output.message,
                input.sessionKey,
                this.#aliases
            ),
            status: "available",
        });
    }

    public async history(
        rawInput: ChatHistoryInput,
        signal?: AbortSignal
    ): Promise<ChatHistoryOutput> {
        const input = v.parse(chatHistoryInputSchema, rawInput);
        const observation = this.#observations?.beginObservation(input.sessionKey);
        const pages: ChatMessage[][] = [];
        let offset = Number(input.cursor);
        let providerPagesRead = 0;
        let sessionId: string | undefined;
        let nextCursor: string | undefined;
        let providerTruncated = false;
        let uniqueCount = 0;

        while (
            providerPagesRead < chatHistoryProviderPageMaximum &&
            uniqueCount < input.limit
        ) {
            const requestedOffset = offset;
            const page = await this.#provider.history(
                {
                    limit: input.limit - uniqueCount,
                    maxChars: chatHistoryResponseMaximumBytes,
                    offset,
                    sessionKey: input.sessionKey,
                },
                signal
            );
            if (providerPagesRead === 0 && observation !== undefined) {
                await this.#observations?.observeInFlightRun(
                    input.sessionKey,
                    page.inFlightRun,
                    observation
                );
            }
            if (observation !== undefined) {
                await this.#observations?.observeHistoryMessages(
                    input.sessionKey,
                    page.messages,
                    observation
                );
            }
            providerPagesRead += 1;
            if (
                sessionId !== undefined &&
                page.sessionId !== undefined &&
                page.sessionId !== sessionId
            ) {
                throw new Error("Chat provider history session identity changed");
            }
            sessionId ??= page.sessionId;
            pages.push(
                page.messages.map((message) =>
                    promoteLocalRunAlias(message, input.sessionKey, this.#aliases)
                )
            );
            uniqueCount = new Set(
                pages.flatMap((messages) => messages.map(({ id }) => id))
            ).size;
            providerTruncated = page.hasMore;
            if (!page.hasMore) {
                nextCursor = undefined;
                break;
            }
            if (page.nextOffset === undefined || page.nextOffset <= requestedOffset) {
                throw new Error("Chat provider history cursor did not advance");
            }
            offset = page.nextOffset;
            nextCursor = String(offset);
        }

        if (providerPagesRead === 0) {
            throw new Error("Chat history read did not execute a provider page");
        }
        // Provider offsets walk backward from the recent tail. Each page is
        // chronological, so older later pages are prepended before newer pages.
        const newestIdentityWins = new Set<string>();
        const chronological: ChatMessage[] = [];
        for (const message of pages.toReversed().flat().toReversed()) {
            if (newestIdentityWins.has(message.id)) continue;
            newestIdentityWins.add(message.id);
            chronological.unshift(message);
        }
        const boundedWindow = chronological.slice(-input.limit);
        let hydrationTruncated = false;
        let messages: ChatMessage[] = [];
        for (const message of boundedWindow.toReversed()) {
            const complete = [message, ...messages];
            if (
                outputBytes(
                    complete,
                    input,
                    providerPagesRead,
                    nextCursor,
                    sessionId,
                    true
                ) <= chatHistoryResponseMaximumBytes
            ) {
                messages = complete;
                continue;
            }
            hydrationTruncated = true;
            const withPreview = [hydrationPlaceholder(message), ...messages];
            if (
                outputBytes(
                    withPreview,
                    input,
                    providerPagesRead,
                    nextCursor,
                    sessionId,
                    true
                ) <= chatHistoryResponseMaximumBytes
            ) {
                messages = withPreview;
                continue;
            }
            const minimal = [hydrationPlaceholder(message, false), ...messages];
            if (
                outputBytes(
                    minimal,
                    input,
                    providerPagesRead,
                    nextCursor,
                    sessionId,
                    true
                ) > chatHistoryResponseMaximumBytes
            ) {
                throw new Error("Chat history identities exceed the response budget");
            }
            messages = minimal;
        }
        const truncated = providerTruncated || hydrationTruncated;
        return v.parse(chatHistoryOutputSchema, {
            messages,
            ...(nextCursor === undefined ? {} : { nextCursor }),
            providerPagesRead,
            ...(sessionId === undefined ? {} : { sessionId }),
            sessionKey: input.sessionKey,
            truncated,
        });
    }
}
