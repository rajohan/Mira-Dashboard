import type { ReactNode } from "react";

import type {
    ChatHistoryMessage,
    ChatToolCallDisplay,
    ChatToolResultDisplay,
    ChatVisibilitySettings,
} from "./chatTypes";

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
        return undefined;
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

    return Boolean(toolResult.name && toolCall.name === toolResult.name);
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
    const toneClass =
        tone === "danger"
            ? "border-red-500/30 bg-red-500/10 text-red-100"
            : tone === "warning"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
              : "border-primary-600 bg-primary-900/70 text-primary-100";

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
    visibility,
}: {
    message: ChatHistoryMessage;
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

    return (
        <div className="mt-1.5 space-y-1.5">
            {shouldShowThinking ? (
                <DetailBlock label="Thinking / working">
                    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {message.thinking?.map((block, index) => (
                            <pre
                                key={block.id || `thinking-${index}`}
                                className="text-primary-200 font-mono text-[11px] leading-normal break-words whitespace-pre-wrap"
                            >
                                {block.text}
                            </pre>
                        ))}
                    </div>
                </DetailBlock>
            ) : undefined}

            {shouldShowToolCalls
                ? message.toolCalls?.map((toolCall, index) => {
                      const formattedArguments = formatToolArguments(toolCall);
                      const summary = toolCallSummary(toolCall);
                      const toolResult = isMatchingToolResult(
                          toolCall,
                          message.toolResult
                      )
                          ? message.toolResult
                          : undefined;
                      return (
                          <DetailBlock
                              key={toolCall.id || `tool-${index}`}
                              label={formatToolDisplayName(toolCall.name)}
                              tone="warning"
                          >
                              {summary ? (
                                  <ToolSection label="Description">
                                      <div className="text-amber-100">{summary}</div>
                                  </ToolSection>
                              ) : undefined}
                              <ToolSection label="Tool input">
                                  {formattedArguments ? (
                                      <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-normal break-words whitespace-pre-wrap">
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
                                          <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-normal break-words whitespace-pre-wrap">
                                              {toolResult.content}
                                          </pre>
                                      ) : (
                                          <span className="text-amber-200/80">
                                              No text output
                                          </span>
                                      )}
                                  </ToolSection>
                              ) : undefined}
                          </DetailBlock>
                      );
                  })
                : undefined}

            {shouldShowToolResult ? (
                <DetailBlock
                    label={`Tool result${message.toolResult?.name ? ` · ${formatToolDisplayName(message.toolResult.name)}` : ""}`}
                    tone={message.toolResult?.isError ? "danger" : "default"}
                >
                    {message.toolResult?.content.trim() ? (
                        <pre className="max-h-72 overflow-auto font-mono text-[11px] leading-normal break-words whitespace-pre-wrap">
                            {message.toolResult.content}
                        </pre>
                    ) : (
                        <span className="text-primary-300">No text output</span>
                    )}
                </DetailBlock>
            ) : undefined}
        </div>
    );
}
