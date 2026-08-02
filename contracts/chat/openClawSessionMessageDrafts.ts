import type { CanonicalChatMessage, CanonicalChatToolCall } from "./canonical";
import { stableCanonicalChatStringify } from "./canonicalUtilities";
import { asRecord, normalizeAssistant, stringValue } from "./openClawAdapterValues";
import type { CanonicalChatEventDraft } from "./openClawRuntimeDraft";

/**
 * Converts an OpenClaw session message into canonical event drafts.
 * @param data Normalized provider message payload.
 * @param common Shared run identity and timestamp.
 * @param sequence Canonical sequence base.
 * @returns Canonical event drafts.
 */
export function sessionMessageDrafts(
    data: Record<string, unknown>,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number
): CanonicalChatEventDraft[] {
    const nestedMessage = asRecord(data.message);
    const stopReason =
        stringValue(nestedMessage?.stopReason) || stringValue(data.stopReason);
    const isTerminalAssistantMessage = stopReason?.toLowerCase() === "stop";
    const isToolUseAssistantMessage = stopReason?.toLowerCase() === "tooluse";
    const topLevelRole = stringValue(data.role);
    const rawMessage = topLevelRole
        ? {
              ...data,
              ...nestedMessage,
              content:
                  nestedMessage?.content ??
                  (nestedMessage
                      ? undefined
                      : (data.message ?? data.content ?? data.deltaText ?? data.text)),
              role: topLevelRole,
          }
        : (data.message ?? data.content ?? data.deltaText ?? data.text);
    const message = normalizeAssistant(rawMessage, common.runId);
    const role = message.role.toLowerCase();
    if (role === "assistant") {
        const diagnosticDrafts = sessionAssistantDiagnosticDrafts(
            message,
            common,
            sequence,
            isToolUseAssistantMessage
        );
        const hasPrimaryContent = Boolean(
            message.text.trim() || message.images?.length || message.attachments?.length
        );
        const drafts: CanonicalChatEventDraft[] = [];
        if (hasPrimaryContent && !isToolUseAssistantMessage) {
            const assistantDraft: CanonicalChatEventDraft = {
                ...common,
                kind: "assistant",
                message: {
                    ...message,
                    content: "",
                    text: message.text,
                    thinking: undefined,
                    toolCalls: undefined,
                    toolResult: undefined,
                    timestamp: common.timestamp,
                },
                mode: isTerminalAssistantMessage ? "replace" : "merge",
                source: "session",
            };
            if (isTerminalAssistantMessage) {
                drafts.push(assistantDraft);
            } else {
                diagnosticDrafts.push(assistantDraft);
            }
        }
        drafts.push(...diagnosticDrafts);
        if (isTerminalAssistantMessage) {
            drafts.push({
                ...common,
                kind: "finish",
                outcome: "completed",
            });
        }
        return drafts;
    }
    if (role === "user") {
        return [
            {
                ...common,
                kind: "user",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
            },
        ];
    }
    if (role.startsWith("tool") && message.toolResult) {
        return [
            {
                ...common,
                kind: "tool",
                message: {
                    ...message,
                    content: "",
                    timestamp: common.timestamp,
                },
                toolKey: sessionToolKey(
                    message.toolResult.id,
                    message.toolResult.name || "tool"
                ),
            },
        ];
    }
    return [];
}

function sessionToolKey(
    id: string | undefined,
    name: string,
    arguments_?: unknown
): string {
    return id
        ? `tool:${id}`
        : `tool:${name}:${stableCanonicalChatStringify(arguments_ ?? undefined)}`;
}

function sessionAssistantDiagnosticDrafts(
    message: CanonicalChatMessage,
    common: { runId?: string; sessionKey: string; timestamp: string },
    sequence: number,
    shouldCarryPrimaryMedia = false
): CanonicalChatEventDraft[] {
    const drafts: CanonicalChatEventDraft[] = [];
    if (message.thinking?.length) {
        const thinking = message.thinking.map((block, index) => ({
            ...block,
            id: block.id || `session-thinking:${sequence}:${index}`,
        }));
        drafts.push({
            ...common,
            kind: "thinking",
            message: {
                role: "assistant",
                content: "",
                text: "",
                thinking,
                timestamp: common.timestamp,
                runId: common.runId,
            },
        });
    }
    const toolCalls = message.toolCalls || [];
    for (const [index, toolCall] of toolCalls.entries()) {
        // Media belongs to the provider turn, so one draft owns it to avoid
        // rendering the same image or attachment once per sibling tool call.
        drafts.push(
            sessionToolCallDraft(
                toolCall,
                common,
                shouldCarryPrimaryMedia && index === 0 ? message : undefined
            )
        );
    }
    if (
        shouldCarryPrimaryMedia &&
        toolCalls.length === 0 &&
        (message.images?.length || message.attachments?.length)
    ) {
        drafts.push({
            ...common,
            kind: "assistant",
            message: {
                ...message,
                content: "",
                text: "",
                thinking: undefined,
                toolCalls: undefined,
                toolResult: undefined,
                timestamp: common.timestamp,
            },
            mode: "merge",
            source: "session",
        });
    }
    return drafts;
}

function sessionToolCallDraft(
    toolCall: CanonicalChatToolCall,
    common: { runId?: string; sessionKey: string; timestamp: string },
    primaryMedia?: CanonicalChatMessage
): CanonicalChatEventDraft {
    return {
        ...common,
        kind: "tool",
        message: {
            role: "assistant",
            content: "",
            text: "",
            attachments: primaryMedia?.attachments,
            images: primaryMedia?.images,
            isToolUse: primaryMedia?.isToolUse,
            toolCalls: [toolCall],
            timestamp: common.timestamp,
            runId: common.runId,
        },
        toolKey: sessionToolKey(toolCall.id, toolCall.name, toolCall.arguments),
    };
}
