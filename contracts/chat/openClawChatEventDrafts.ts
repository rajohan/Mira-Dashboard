import type { CanonicalChatLifecycle } from "./canonical";
import { asRecord, normalizeAssistant, stringValue } from "./openClawAdapterValues";
import { type CanonicalChatEventDraft, isToolFailureError } from "./openClawRuntimeDraft";

/**
 * Converts an OpenClaw chat envelope into canonical event drafts.
 * @param state Provider chat state.
 * @param payload Provider chat payload.
 * @param common Shared run identity and timestamp.
 * @returns Canonical event drafts.
 */
export function chatEventDrafts(
    state: string | undefined,
    payload: Record<string, unknown>,
    common: {
        runId?: string;
        sessionKey: string;
        timestamp: string;
    }
): CanonicalChatEventDraft[] {
    if (state === "delta") {
        const message = normalizeAssistant(
            payload.message ??
                payload.deltaText ??
                payload.delta ??
                payload.content ??
                payload.text,
            common.runId
        );
        return [
            {
                ...common,
                kind: "assistant",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
                mode: payload.replace === true ? "replace" : "merge",
                source: "chat",
            },
        ];
    }
    if (!["final", "aborted", "error"].includes(state || "")) {
        return [];
    }
    const rawMessage = payload.message ?? payload.content ?? payload.text;
    const message =
        rawMessage === undefined
            ? undefined
            : normalizeAssistant(rawMessage, common.runId);
    if (state === "final" && message?.intent === "control") {
        const controlId = message.controlId || common.runId?.replace(/^inject-/u, "");
        return [
            {
                kind: "control",
                message: {
                    ...message,
                    controlId,
                    runId: undefined,
                    timestamp: common.timestamp,
                },
                sessionKey: common.sessionKey,
                timestamp: common.timestamp,
            },
        ];
    }
    const isCommand = asRecord(payload.message)?.command === true;
    const explicitError = stringValue(payload.errorMessage) || stringValue(payload.error);
    const isMessageToolFailure = state === "error" && isToolFailureError(message?.text);
    let error = state === "error" ? "Chat run failed" : undefined;
    if (isMessageToolFailure) {
        error = message?.text;
    }
    if (explicitError) {
        error = explicitError;
    }
    const isToolFailure = isToolFailureError(explicitError) || isMessageToolFailure;
    const isDuplicateToolFailureMessage = Boolean(
        isToolFailure &&
        message &&
        (message.text.trim() === error?.trim() || isToolFailureError(message.text))
    );
    let outcome: Exclude<CanonicalChatLifecycle, "active"> = "error";
    if (state === "aborted") {
        outcome = "aborted";
    }
    if (state === "final") {
        outcome = "completed";
    }
    return [
        {
            ...common,
            authoritative: true,
            kind: "finish",
            error,
            message:
                message && !isDuplicateToolFailureMessage
                    ? {
                          ...message,
                          content: "",
                          role: isCommand ? "system" : message.role,
                          local: isCommand || undefined,
                          timestamp: common.timestamp,
                      }
                    : undefined,
            outcome,
            toolFailure: isToolFailure || undefined,
        },
    ];
}
