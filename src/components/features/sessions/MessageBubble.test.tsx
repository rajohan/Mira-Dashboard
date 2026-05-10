import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
    it("renders role, content, and optional timestamp", () => {
        render(
            <MessageBubble
                role="assistant"
                content="Hello\nworld"
                timestamp="2026-05-10T10:00:00.000Z"
            />
        );

        expect(screen.getByText("assistant")).toBeInTheDocument();
        const content = screen.getByText(/Hello/u);
        expect(content.textContent).toContain("Hello");
        expect(content.textContent).toContain("world");
        expect(screen.getByText(/10\.05\.2026/u)).toBeInTheDocument();
    });

    it("omits timestamp when not provided", () => {
        render(<MessageBubble role="user" content="No timestamp" />);

        expect(screen.getByText("user")).toBeInTheDocument();
        expect(screen.getByText("No timestamp")).toBeInTheDocument();
        expect(screen.queryByText(/\d{2}\.\d{2}\.\d{4}/u)).not.toBeInTheDocument();
    });
});
