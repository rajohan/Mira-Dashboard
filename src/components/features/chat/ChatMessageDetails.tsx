import type { ReactNode } from "react";

import type {
    ChatHistoryMessage,
    ChatToolCallDisplay,
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
        return JSON.stringify(toolCall.arguments, null, 2);
    } catch {
        return String(toolCall.arguments);
    }
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

/** Renders the chat message details UI. */
export function ChatMessageDetails({
    message,
    visibility,
}: {
    message: ChatHistoryMessage;
    visibility: ChatVisibilitySettings;
}) {
    const shouldShowThinking =
        visibility.showThinking && (message.thinking?.length || 0) > 0;
    const shouldShowToolCalls =
        visibility.showTools && (message.toolCalls?.length || 0) > 0;
    const shouldShowToolResult = visibility.showTools && message.toolResult;

    if (!shouldShowThinking && !shouldShowToolCalls && !shouldShowToolResult) {
        return null;
    }

    return (
        <div className="mt-1.5 space-y-1.5">
            {shouldShowThinking
                ? message.thinking?.map((block, index) => (
                      <DetailBlock key={`thinking-${index}`} label="Thinking / working">
                          <pre className="text-primary-200 max-h-64 overflow-auto font-mono text-[11px] leading-normal break-words whitespace-pre-wrap">
                              {block.text}
                          </pre>
                      </DetailBlock>
                  ))
                : null}

            {shouldShowToolCalls
                ? message.toolCalls?.map((toolCall, index) => {
                      const formattedArguments = formatToolArguments(toolCall);
                      return (
                          <DetailBlock
                              key={toolCall.id || `tool-${index}`}
                              label={`Tool call · ${toolCall.name}`}
                              tone="warning"
                          >
                              {formattedArguments ? (
                                  <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-normal break-words whitespace-pre-wrap">
                                      {formattedArguments}
                                  </pre>
                              ) : (
                                  <span className="text-amber-200/80">No arguments</span>
                              )}
                          </DetailBlock>
                      );
                  })
                : null}

            {shouldShowToolResult ? (
                <DetailBlock
                    label={`Tool result${message.toolResult?.name ? ` · ${message.toolResult.name}` : ""}`}
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
            ) : null}
        </div>
    );
}
