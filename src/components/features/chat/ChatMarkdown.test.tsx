import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatMarkdown } from "./ChatMarkdown";

vi.mock("@microlink/react-json-view", () => ({
    default: ({ src }: { src: unknown }) => (
        <pre data-testid="json-block">{JSON.stringify(src)}</pre>
    ),
}));

vi.mock("react-syntax-highlighter", () => ({
    default: ({ children, language }: { children: string; language: string }) => (
        <pre data-language={language} data-testid="syntax-block">
            {children}
        </pre>
    ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/hljs", () => ({
    monokai: {},
}));

describe("ChatMarkdown", () => {
    it("renders links, images as links, tables, and inline code", () => {
        render(
            <ChatMarkdown
                text={[
                    "Visit [OpenClaw](https://docs.openclaw.ai) and `ship it`.",
                    "",
                    "![diagram](https://example.com/diagram.png)",
                    "",
                    "| Name | Status |",
                    "| --- | --- |",
                    "| Mira | OK |",
                ].join("\n")}
            />
        );

        expect(screen.getByRole("link", { name: "OpenClaw" })).toHaveAttribute(
            "target",
            "_blank"
        );
        expect(screen.getByRole("link", { name: "diagram" })).toHaveAttribute(
            "href",
            "https://example.com/diagram.png"
        );
        expect(screen.getByText("ship it")).toBeInTheDocument();
        expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "Mira" })).toBeInTheDocument();
    });

    it("renders JSON-like fenced blocks with JSON viewer", () => {
        render(<ChatMarkdown text={'```json\n{"ok": true}\n```'} />);

        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByTestId("json-block")).toHaveTextContent(
            JSON.stringify({ ok: true })
        );
    });

    it("renders non-JSON fenced blocks with syntax highlighting", () => {
        render(<ChatMarkdown text={"```ts\nconst ok = true;\n```"} />);

        const block = screen.getByTestId("syntax-block");
        expect(block).toHaveAttribute("data-language", "typescript");
        expect(block).toHaveTextContent("const ok = true;");
    });
});
