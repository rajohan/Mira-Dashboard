import { type ChatHistoryMessage, extractImages, mergeChatImages } from "../chatTypes";
import { stableChatStringify } from "../chatUtilities";
import type { ChatOperationPhase } from "../domain/chatState";
import {
    argumentDetail,
    asRecord,
    compactStatus,
    formatToolName,
    isNonWorkTool,
    isThinkingItem,
    isToolCallItem,
    isToolResultItem,
    nestedItem,
    runtimeText,
    stringValue,
} from "./openClawAdapterValues";
import { normalizeOpenClawHistoryMessage } from "./openClawHistoryNormalizer";

export const OPENCLAW_WORK_STREAMS = new Set([
    "approval",
    "assistant",
    "compaction",
    "item",
    "patch",
    "plan",
    "reasoning",
    "thinking",
    "tool",
]);

/**
 * Resolves the lifecycle phase for a compaction operation.
 *
 * @param isRetrying - Whether the terminal event will be retried.
 * @param isTerminal - Whether the event ended the current attempt.
 * @param isSuccessful - Whether the terminal event completed successfully.
 * @returns Canonical compaction operation phase.
 */
function compactionOperationPhase(
    isRetrying: boolean,
    isTerminal: boolean,
    isSuccessful: boolean
): ChatOperationPhase {
    if (isRetrying) {
        return "retrying";
    }
    if (!isTerminal) {
        return "active";
    }
    return isSuccessful ? "complete" : "inactive";
}

export function openClawToolMessage(
    data: Record<string, unknown>,
    runId: string | undefined,
    timestamp: string
): { key: string; message: ChatHistoryMessage } | undefined {
    const name = stringValue(data.name) || stringValue(data.toolName) || "tool";
    if (isNonWorkTool(name)) {
        return undefined;
    }
    const id =
        stringValue(data.id) ||
        stringValue(data.toolCallId) ||
        stringValue(data.tool_call_id) ||
        stringValue(data.callId);
    const arguments_ = data.args ?? data.arguments ?? data.input;
    const result = data.result ?? data.output ?? data.content ?? data.text ?? data.error;
    const resultRecord = asRecord(result);
    const phase = stringValue(data.phase) || "";
    const status = (
        stringValue(data.status) ||
        stringValue(resultRecord?.status) ||
        ""
    ).toLowerCase();
    let exitCode =
        typeof resultRecord?.exitCode === "number" ? resultRecord.exitCode : undefined;
    if (typeof data.exitCode === "number") {
        exitCode = data.exitCode;
    }
    const hasErrorResult =
        result === data.error &&
        (typeof data.error === "string"
            ? data.error.trim().length > 0
            : Boolean(data.error));
    const isFailedResult =
        ["error", "failed", "failure"].includes(status) ||
        (exitCode !== undefined && exitCode !== 0);
    const hasResult =
        phase === "result" ||
        phase === "end" ||
        phase === "error" ||
        result !== undefined ||
        isFailedResult;
    const resultMessage = normalizeOpenClawHistoryMessage({
        MediaPath: data.MediaPath,
        MediaPaths: data.MediaPaths,
        MediaType: data.MediaType,
        MediaTypes: data.MediaTypes,
        role: "tool",
        content: result,
        runId,
        timestamp,
    });
    const resultContent = resultMessage.text || runtimeText(result);
    const resultImages = mergeChatImages(
        resultMessage.images?.length ? resultMessage.images : extractImages(result),
        extractImages(data.images)
    );
    const shouldCreateResult = Boolean(
        hasResult &&
        (phase !== "end" ||
            resultContent ||
            hasErrorResult ||
            isFailedResult ||
            resultImages.length > 0 ||
            resultMessage.attachments?.length ||
            data.isError === true)
    );
    const resultKeys = resultRecord ? Object.keys(resultRecord) : [];
    const isPlaceholderResult =
        resultKeys.length > 0 &&
        resultKeys.every((key) => ["durationMs", "exitCode", "status"].includes(key));
    const toolResult = shouldCreateResult
        ? {
              id,
              name,
              content: resultContent,
              images: resultImages,
              isError:
                  phase === "error" ||
                  data.isError === true ||
                  hasErrorResult ||
                  isFailedResult,
              isPlaceholder: isPlaceholderResult || undefined,
          }
        : undefined;
    const toolCall =
        arguments_ !== undefined || !hasResult
            ? { id, name, arguments: arguments_, toolResult }
            : undefined;
    const message: ChatHistoryMessage = toolCall
        ? {
              role: "assistant",
              content: "",
              text: "",
              attachments: resultMessage.attachments,
              images: [],
              toolCalls: [toolCall],
              toolResult,
              timestamp,
              local: true,
              runId,
          }
        : {
              ...resultMessage,
              toolResult,
              timestamp,
              local: true,
              runId,
          };
    const argumentIdentity = stableChatStringify(arguments_ ?? undefined);
    return {
        key: id ? `tool:${id}` : `tool:${name}:${argumentIdentity}`,
        message,
    };
}

export function openClawItemToolData(
    data: Record<string, unknown>
): Record<string, unknown> | undefined {
    const item = nestedItem(data);
    if (!isToolCallItem(item) && !isToolResultItem(item)) {
        return undefined;
    }
    return {
        ...item,
        args: item.args ?? item.arguments ?? item.input,
        id: item.call_id ?? item.callId ?? item.toolCallId ?? item.id,
        name: item.name ?? item.toolName,
        phase: isToolResultItem(item) ? "result" : (data.phase ?? item.phase),
        result: item.output ?? item.result ?? item.content ?? item.text,
    };
}

export function openClawProgress(
    eventName: string,
    stream: string,
    phase: string,
    data: Record<string, unknown>
): { operation?: "compact"; operationPhase?: ChatOperationPhase; text?: string } {
    if (eventName === "session.started") {
        return { text: "Thinking" };
    }
    if (stream === "lifecycle") {
        return { text: phase === "start" ? "Thinking" : undefined };
    }
    if (stream === "thinking" || stream === "reasoning") {
        return { text: "Thinking" };
    }
    if (stream === "tool" || eventName === "session.tool") {
        const name = stringValue(data.name) || stringValue(data.toolName) || "tool";
        if (isNonWorkTool(name)) {
            return {};
        }
        const detail =
            argumentDetail(data.args) ||
            stringValue(data.title) ||
            stringValue(data.summary) ||
            stringValue(data.progressText);
        return {
            text: compactStatus(
                detail ? `${formatToolName(name)}: ${detail}` : formatToolName(name)
            ),
        };
    }
    if (stream === "item") {
        if (data.suppressChannelProgress === true || isThinkingItem(data)) {
            return {};
        }
        const name = stringValue(data.name) || stringValue(data.itemKind);
        const detail =
            stringValue(data.meta) ||
            stringValue(data.summary) ||
            stringValue(data.progressText) ||
            stringValue(data.title);
        return {
            text:
                name || detail
                    ? compactStatus(
                          [name ? formatToolName(name) : undefined, detail]
                              .filter(Boolean)
                              .join(": ")
                      )
                    : undefined,
        };
    }
    if (stream === "plan") {
        return {
            text: compactStatus(
                stringValue(data.explanation) ||
                    stringValue(data.title) ||
                    "Updating plan"
            ),
        };
    }
    if (stream === "approval") {
        return {
            text: compactStatus(
                stringValue(data.command) ||
                    stringValue(data.message) ||
                    stringValue(data.reason) ||
                    "Waiting for approval"
            ),
        };
    }
    if (stream === "patch") {
        return {
            text: compactStatus(
                stringValue(data.summary) || stringValue(data.title) || "Applying patch"
            ),
        };
    }
    if (stream === "compaction") {
        if (
            eventName === "session.compaction" &&
            (stringValue(data.operation) || "").toLowerCase() !== "compact"
        ) {
            return {};
        }
        const normalizedPhase = phase.toLowerCase();
        const status = (stringValue(data.status) || "").toLowerCase();
        const isFailure =
            data.aborted === true ||
            ["aborted", "error", "failed", "failure"].includes(normalizedPhase) ||
            ["aborted", "error", "failed", "failure"].includes(status);
        const isSessionEnd =
            eventName === "session.compaction" &&
            (normalizedPhase === "end" || status === "end");
        const isTerminal =
            isFailure ||
            ["complete", "completed", "end", "finished"].includes(normalizedPhase) ||
            ["complete", "completed", "end", "finished"].includes(status);
        const isSuccessful =
            !isFailure &&
            (data.completed === true ||
                isSessionEnd ||
                ["complete", "completed", "finished"].includes(normalizedPhase) ||
                ["complete", "completed", "finished"].includes(status));
        const isRetrying = isTerminal && data.willRetry === true;
        const operationPhase = compactionOperationPhase(
            isRetrying,
            isTerminal,
            isSuccessful
        );
        let text: string | undefined;
        if (operationPhase === "active" || operationPhase === "retrying") {
            text = "Compacting context";
        }
        if (operationPhase === "complete") {
            text = "Context compacted";
        }
        return {
            operation: "compact",
            operationPhase,
            text,
        };
    }
    if (stream === "command-output" && (!phase || phase === "end")) {
        const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
        let status =
            exitCode === undefined ? stringValue(data.status) : `exit ${exitCode}`;
        if (exitCode === 0) {
            status = "completed";
        }
        return {
            text: compactStatus(
                [formatToolName(stringValue(data.name) || "exec"), status]
                    .filter(Boolean)
                    .join(": ")
            ),
        };
    }
    return {};
}
