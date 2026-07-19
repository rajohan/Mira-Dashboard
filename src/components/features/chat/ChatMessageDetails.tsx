import { ChevronRight } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import type {
    ChatHistoryMessage,
    ChatImageBlock,
    ChatToolCallDisplay,
    ChatToolResultDisplay,
    ChatVisibilitySettings,
} from "./chatTypes";
import { chatImageUrl } from "./chatTypes";

/** Formats tool arguments for display. */
function formatToolArguments(toolCall: ChatToolCallDisplay): string {
    if (toolCall.arguments === undefined) {
        return "";
    }

    if (typeof toolCall.arguments === "string") {
        return toolCall.arguments;
    }

    try {
        return JSON.stringify(toolCall.arguments, undefined, 2);
    } catch {
        return String(toolCall.arguments);
    }
}

/** Formats a compact tool display name. */
function formatToolDisplayName(name = "tool"): string {
    const rawName = name || "tool";
    const withoutNamespace = rawName.startsWith("functions.")
        ? rawName.slice("functions.".length)
        : rawName;
    const normalized =
        withoutNamespace === "exec_command" || withoutNamespace === "bash"
            ? "bash"
            : withoutNamespace;
    const words = normalized.replaceAll(/[_-]/g, " ").replaceAll(/\s+/g, " ").trim();
    return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Tool";
}

/** Returns a short summary for common tool arguments. */
function toolCallSummary(toolCall: ChatToolCallDisplay): string | undefined {
    const arguments_ = toolCall.arguments;
    if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
        return undefined;
    }

    const record = arguments_ as Record<string, unknown>;
    const command =
        typeof record.command === "string"
            ? record.command
            : typeof record.cmd === "string"
              ? record.cmd
              : undefined;
    if (!command) {
        return typeof record.path === "string" ? record.path : undefined;
    }

    const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
    const repoName = cwd?.split(/[\\/]/).findLast(Boolean);
    return repoName ? `${command} (${repoName})` : command;
}

/** Returns whether a result belongs with a rendered tool call. */
function isMatchingToolResult(
    toolCall: ChatToolCallDisplay,
    toolResult?: ChatToolResultDisplay
): toolResult is ChatToolResultDisplay {
    if (!toolResult) {
        return false;
    }

    if (toolCall.id && toolResult.id) {
        return toolCall.id === toolResult.id;
    }

    return Boolean(
        !toolCall.id &&
        !toolResult.id &&
        toolResult.name &&
        toolCall.name === toolResult.name
    );
}

/** Renders tool result images. */
function ToolResultImages({ images = [] }: { images?: ChatImageBlock[] }) {
    const imageUrls = images
        .map((image) => chatImageUrl(image))
        .filter((imageUrl): imageUrl is string => Boolean(imageUrl));
    if (imageUrls.length === 0) {
        return;
    }

    return (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
            {imageUrls.map((imageUrl, index) => (
                <img
                    key={`${imageUrl.slice(0, 48)}-${index}`}
                    src={imageUrl}
                    alt={`Tool output ${index + 1}`}
                    className="max-h-40 max-w-full rounded-md border border-amber-400/20 object-contain"
                />
            ))}
        </div>
    );
}

/** Renders thinking blocks while following the bottom unless the user scrolls up. */
function ThinkingBlocks({ blocks }: { blocks: ChatHistoryMessage["thinking"] }) {
    const containerReference = useRef<HTMLDivElement>(null);
    const shouldStickToBottomReference = useRef(true);
    const textSignature = blocks?.map((block) => block.text).join("\n") || "";

    useLayoutEffect(() => {
        const container = containerReference.current;
        if (!container || !shouldStickToBottomReference.current) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, [textSignature]);

    return (
        <div
            ref={containerReference}
            className="max-h-80 space-y-2 overflow-y-auto pr-1"
            onScroll={(event) => {
                const element = event.currentTarget;
                shouldStickToBottomReference.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 8;
            }}
        >
            {blocks?.map((block, index) => (
                <pre
                    key={block.id || `thinking-${index}`}
                    className="font-mono text-[11px] leading-normal wrap-break-word whitespace-pre-wrap text-primary-200"
                >
                    {block.text}
                </pre>
            ))}
        </div>
    );
}

/** Renders the detail block UI. */
function DetailBlock({
    label,
    children,
    tone = "default",
}: {
    label: string;
    children: ReactNode;
    tone?: "default" | "warning" | "danger";
}) {
    const toneClass = detailToneClass(tone);

    return (
        <div
            className={`mt-1.5 min-w-0 overflow-hidden rounded-lg border px-2 py-1.5 text-xs ${toneClass}`}
        >
            <div className="mb-0.5 font-medium tracking-wide uppercase opacity-70">
                {label}
            </div>
            {children}
        </div>
    );
}

function detailToneClass(tone: "default" | "warning" | "danger"): string {
    return tone === "danger"
        ? "border-red-500/30 bg-red-500/10 text-red-100"
        : tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
          : "border-primary-600 bg-primary-900/70 text-primary-100";
}

/** Renders a collapsible tool bubble with its status always visible. */
function ToolDetailBlock({
    label,
    status,
    summary,
    isExpanded,
    onToggle,
    tone,
    children,
}: {
    label: string;
    status: string;
    summary?: string;
    isExpanded: boolean;
    onToggle: () => void;
    tone: "default" | "warning" | "danger";
    children: ReactNode;
}) {
    return (
        <div
            className={`mt-1.5 min-w-0 overflow-hidden rounded-lg border px-2 py-1.5 text-xs ${detailToneClass(tone)}`}
        >
            <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label} tool details`}
                onClick={onToggle}
                className="flex w-full min-w-0 items-center gap-1.5 text-left"
            >
                <ChevronRight
                    className={`size-3.5 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate font-medium tracking-wide uppercase opacity-80">
                    {label}
                </span>
                <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-60">
                    {status}
                </span>
            </button>
            {!isExpanded && summary ? (
                <div className="mt-1 truncate pl-5 opacity-75" title={summary}>
                    {summary}
                </div>
            ) : undefined}
            {isExpanded ? children : undefined}
        </div>
    );
}

/** Renders a labeled nested tool section. */
function ToolSection({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="mt-1 rounded-md border border-amber-400/20 bg-black/15 px-2 py-1.5">
            <div className="mb-0.5 font-medium tracking-wide text-amber-100/70 uppercase">
                {label}
            </div>
            {children}
        </div>
    );
}

/** Renders the chat message details UI. */
export function ChatMessageDetails({
    message,
    messageKey,
    shouldExpandToolDetails = false,
    toolDetailExpansionOverrides = new Map(),
    onToggleToolDetails,
    visibility,
}: {
    message: ChatHistoryMessage;
    messageKey?: string;
    shouldExpandToolDetails?: boolean;
    toolDetailExpansionOverrides?: ReadonlyMap<string, boolean>;
    onToggleToolDetails?: (toolKey: string) => void;
    visibility: ChatVisibilitySettings;
}) {
    const shouldShowThinking =
        visibility.shouldShowThinking && (message.thinking?.length || 0) > 0;
    const shouldShowToolCalls =
        visibility.shouldShowTools && (message.toolCalls?.length || 0) > 0;
    const hasToolResultInCall = Boolean(
        message.toolCalls?.some((toolCall) =>
            isMatchingToolResult(toolCall, message.toolResult)
        )
    );
    const shouldShowToolResult =
        visibility.shouldShowTools && message.toolResult && !hasToolResultInCall;
    if (!shouldShowThinking && !shouldShowToolCalls && !shouldShowToolResult) {
        return;
    }

    const toolKeyPrefix =
        messageKey ||
        message.runtimeKey ||
        `${message.runId || "message"}:${message.timestamp || "untimed"}`;
    const isToolDetailsExpanded = (toolKey: string) =>
        toolDetailExpansionOverrides.get(toolKey) ?? shouldExpandToolDetails;

    return (
        <div className="mt-1.5 space-y-1.5">
            {shouldShowThinking ? (
                <DetailBlock label="Thinking / working">
                    <ThinkingBlocks blocks={message.thinking} />
                </DetailBlock>
            ) : undefined}

            {shouldShowToolCalls
                ? message.toolCalls?.map((toolCall, index) => {
                      const formattedArguments = formatToolArguments(toolCall);
                      const summary = toolCallSummary(toolCall);
                      const toolResult =
                          toolCall.toolResult ||
                          (isMatchingToolResult(toolCall, message.toolResult)
                              ? message.toolResult
                              : undefined);
                      const label = formatToolDisplayName(toolCall.name);
                      const toolKey = `${toolKeyPrefix}:call:${toolCall.id || index}`;
                      return (
                          <ToolDetailBlock
                              key={toolCall.id || `tool-${index}`}
                              label={label}
                              status={
                                  toolResult?.isError
                                      ? "Failed"
                                      : toolResult
                                        ? "Completed"
                                        : "Running"
                              }
                              summary={summary}
                              isExpanded={isToolDetailsExpanded(toolKey)}
                              onToggle={() => onToggleToolDetails?.(toolKey)}
                              tone={toolResult?.isError ? "danger" : "warning"}
                          >
                              {summary ? (
                                  <ToolSection label="Description">
                                      <div className="text-amber-100">{summary}</div>
                                  </ToolSection>
                              ) : undefined}
                              <ToolSection label="Tool input">
                                  {formattedArguments ? (
                                      <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-normal wrap-break-word whitespace-pre-wrap">
                                          {formattedArguments}
                                      </pre>
                                  ) : (
                                      <span className="text-amber-200/80">
                                          No arguments
                                      </span>
                                  )}
                              </ToolSection>
                              {toolResult ? (
                                  <ToolSection label="Tool output">
                                      {toolResult.content.trim() ? (
                                          <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-normal wrap-break-word whitespace-pre-wrap">
                                              {toolResult.content}
                                          </pre>
                                      ) : (
                                          <span className="text-amber-200/80">
                                              No text output
                                          </span>
                                      )}
                                      <ToolResultImages images={toolResult.images} />
                                  </ToolSection>
                              ) : undefined}
                          </ToolDetailBlock>
                      );
                  })
                : undefined}

            {shouldShowToolResult ? (
                <ToolDetailBlock
                    label={`Tool result${message.toolResult?.name ? ` · ${formatToolDisplayName(message.toolResult.name)}` : ""}`}
                    status={message.toolResult?.isError ? "Failed" : "Completed"}
                    isExpanded={isToolDetailsExpanded(
                        `${toolKeyPrefix}:result:${message.toolResult?.id || message.toolResult?.name || "standalone"}`
                    )}
                    onToggle={() =>
                        onToggleToolDetails?.(
                            `${toolKeyPrefix}:result:${message.toolResult?.id || message.toolResult?.name || "standalone"}`
                        )
                    }
                    tone={message.toolResult?.isError ? "danger" : "default"}
                >
                    {message.toolResult?.content.trim() ? (
                        <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-normal wrap-break-word whitespace-pre-wrap">
                            {message.toolResult.content}
                        </pre>
                    ) : (
                        <span className="text-primary-300">No text output</span>
                    )}
                    <ToolResultImages images={message.toolResult?.images} />
                </ToolDetailBlock>
            ) : undefined}
        </div>
    );
}
