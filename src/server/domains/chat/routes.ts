import { TRPCError } from "@trpc/server";

import {
    chatAbortInputSchema,
    chatAbortOutputSchema,
    chatCompanionAskInputSchema,
    chatCompanionAskOutputSchema,
    chatCompanionResetInputSchema,
    chatCompanionResetOutputSchema,
    chatCompanionStateInputSchema,
    chatCompanionStateOutputSchema,
    chatHistoryInputSchema,
    chatHistoryOutputSchema,
    chatMessageGetInputSchema,
    chatMessageGetOutputSchema,
    chatModelsListInputSchema,
    chatModelsListOutputSchema,
    chatRuntimeInputSchema,
    chatRuntimeOutputSchema,
    chatSendInputSchema,
    chatSendOutputSchema,
    chatSessionSettingsInputSchema,
    chatSessionSettingsOutputSchema,
} from "../../../contracts/chat.ts";
import {
    chatAttachmentTicketPrepareInputSchema,
    chatAttachmentTicketPrepareOutputSchema,
} from "../../../contracts/chatMedia.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    capabilityProcedure,
    operationOutcomeUnknownError,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { ChatAdmissionActor } from "./repository.ts";
import { type ChatService, ChatServiceError } from "./service.ts";

function chatService(context: RequestContext): ChatService {
    if (context.chatService === undefined) {
        throw new Error("Request context is missing the chat service");
    }
    return context.chatService;
}

function chatActor(principal: {
    readonly id: string;
    readonly kind: "automation" | "session";
}): ChatAdmissionActor {
    return {
        id: principal.id,
        kind: principal.kind === "automation" ? "automation" : "user",
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof ChatServiceError)) throw error;
    switch (error.reason) {
        case "capacity": {
            throw new TRPCError({
                cause: error,
                code: "TOO_MANY_REQUESTS",
                message: "Chat capacity is temporarily full",
            });
        }
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Chat state changed; refresh before retrying",
            });
        }
        case "invalid-input": {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message: "Chat input is invalid",
            });
        }
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Chat resource was not found",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "Chat provider outcome could not be confirmed"
            );
        }
        case "provider-unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Chat provider is temporarily unavailable",
            });
        }
    }
}

async function routeFailure<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        return throwServiceFailure(error);
    }
}

const readProcedure = capabilityProcedure("chat:read");
const writeProcedure = capabilityProcedure("chat:write");
const sessionWriteProcedure = sessionCapabilityProcedure("chat:write");

export const chatRoutes = {
    abort: writeProcedure
        .input(chatAbortInputSchema)
        .output(chatAbortOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).abort(input, signal))
        ),
    companionAsk: writeProcedure
        .input(chatCompanionAskInputSchema)
        .output(chatCompanionAskOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() =>
                chatService(ctx).companionAsk(input, chatActor(ctx.principal), signal)
            )
        ),
    companionReset: writeProcedure
        .input(chatCompanionResetInputSchema)
        .output(chatCompanionResetOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).companionReset(input, signal))
        ),
    companionState: readProcedure
        .input(chatCompanionStateInputSchema)
        .output(chatCompanionStateOutputSchema)
        .query(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).companionState(input, signal))
        ),
    getMessage: readProcedure
        .input(chatMessageGetInputSchema)
        .output(chatMessageGetOutputSchema)
        .query(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).getMessage(input, signal))
        ),
    history: readProcedure
        .input(chatHistoryInputSchema)
        .output(chatHistoryOutputSchema)
        .query(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).history(input, signal))
        ),
    listModels: readProcedure
        .input(chatModelsListInputSchema)
        .output(chatModelsListOutputSchema)
        .query(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).listModels(input, signal))
        ),
    prepareAttachmentTicket: sessionWriteProcedure
        .input(chatAttachmentTicketPrepareInputSchema)
        .output(chatAttachmentTicketPrepareOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() =>
                chatService(ctx).prepareAttachmentTicket(
                    input,
                    ctx.sessionIdentity.userId,
                    signal
                )
            )
        ),
    runtime: readProcedure
        .input(chatRuntimeInputSchema)
        .output(chatRuntimeOutputSchema)
        .query(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).runtime(input, signal))
        ),
    send: writeProcedure
        .input(chatSendInputSchema)
        .output(chatSendOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() =>
                chatService(ctx).send(input, chatActor(ctx.principal), signal)
            )
        ),
    updateSessionSettings: writeProcedure
        .input(chatSessionSettingsInputSchema)
        .output(chatSessionSettingsOutputSchema)
        .mutation(({ ctx, input, signal }) =>
            routeFailure(() => chatService(ctx).updateSessionSettings(input, signal))
        ),
};
