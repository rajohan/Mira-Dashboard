import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatMessageDetails } from "./ChatMessageDetails";
import type { ChatHistoryMessage } from "./chatTypes";

const message: ChatHistoryMessage = {
    content: [],
    role: "assistant",
    text: "Done",
    thinking: [{ text: "I should inspect the cache first." }],
    toolCalls: [
        { arguments: { key: "system.host" }, id: "tool-1", name: "cache.read" },
        { id: "tool-2", name: "noop" },
    ],
    toolResult: { content: "cache fresh", name: "cache.read" },
};

describe("ChatMessageDetails", () => {
    it("hides details when visibility toggles are off", () => {
        const { container } = render(
            <ChatMessageDetails
                message={message}
                visibility={{ showThinking: false, showTools: false }}
            />
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("renders thinking, tool calls, empty arguments, and tool results", () => {
        render(
            <ChatMessageDetails
                message={message}
                visibility={{ showThinking: true, showTools: true }}
            />
        );

        expect(screen.getByText("Thinking / working")).toBeInTheDocument();
        expect(screen.getByText("I should inspect the cache first.")).toBeInTheDocument();
        expect(screen.getByText("Tool call · cache.read")).toBeInTheDocument();
        expect(screen.getByText(/"system\.host"/u)).toBeInTheDocument();
        expect(screen.getByText("Tool call · noop")).toBeInTheDocument();
        expect(screen.getByText("No arguments")).toBeInTheDocument();
        expect(screen.getByText("Tool result · cache.read")).toBeInTheDocument();
        expect(screen.getByText("cache fresh")).toBeInTheDocument();
    });

    it("renders string and non-json tool argument fallbacks", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        render(
            <ChatMessageDetails
                message={{
                    content: [],
                    role: "assistant",
                    text: "",
                    toolCalls: [
                        { arguments: "raw args", name: "raw.tool" },
                        { arguments: circular, name: "circular.tool" },
                    ],
                }}
                visibility={{ showThinking: false, showTools: true }}
            />
        );

        expect(screen.getByText("raw args")).toBeInTheDocument();
        expect(screen.getByText("[object Object]")).toBeInTheDocument();
    });

    it("renders tool result fallbacks and errors", () => {
        render(
            <ChatMessageDetails
                message={{
                    content: [],
                    role: "tool",
                    text: "",
                    toolResult: { content: "", isError: true, name: "exec" },
                }}
                visibility={{ showThinking: false, showTools: true }}
            />
        );

        expect(screen.getByText("Tool result · exec")).toBeInTheDocument();
        expect(screen.getByText("No text output")).toBeInTheDocument();
    });
});
