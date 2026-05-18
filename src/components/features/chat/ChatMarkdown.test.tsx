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

    it("falls back to syntax highlighting when JSON fences are invalid", () => {
        render(<ChatMarkdown text={"```json\n{not valid}\n```"} />);

        const block = screen.getByTestId("syntax-block");
        expect(block).toHaveAttribute("data-language", "json");
        expect(block).toHaveTextContent("{not valid}");
    });

    it("detects JSON-like blocks without an explicit language", () => {
        render(<ChatMarkdown text={'```\n["alpha", "beta"]\n```'} />);

        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByTestId("json-block")).toHaveTextContent(
            JSON.stringify(["alpha", "beta"])
        );
    });

    it("wraps primitive JSON values and normalizes shell aliases", () => {
        const { rerender } = render(<ChatMarkdown text={"```json5\n42\n```"} />);

        expect(screen.getByTestId("json-block")).toHaveTextContent(
            JSON.stringify({ value: 42 })
        );

        rerender(<ChatMarkdown text={"```sh\necho hi\n```"} />);

        const block = screen.getByTestId("syntax-block");
        expect(block).toHaveAttribute("data-language", "bash");
        expect(block).toHaveTextContent("echo hi");
    });

    it("renders blockquotes and image links without alt text", () => {
        render(
            <ChatMarkdown
                text={["> quoted", "", "![](https://example.com/raw.png)"].join("\n")}
            />
        );

        expect(screen.getByText("quoted").closest("blockquote")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "https://example.com/raw.png" })
        ).toHaveAttribute("href", "https://example.com/raw.png");
    });

    it("renders nested inline content inside code and detects JSON objects", () => {
        render(
            <ChatMarkdown
                text={[
                    "`before **nested** after`",
                    "",
                    "```",
                    "{answer: 'yes'}",
                    "```",
                ].join("\n")}
            />
        );

        expect(screen.getByText("before **nested** after")).toBeInTheDocument();
        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByTestId("json-block")).toHaveTextContent(
            JSON.stringify({ answer: "yes" })
        );
    });

    it("falls back for JSON-like non-JSON blocks", () => {
        render(<ChatMarkdown text={"```text\n[not valid\n```"} />);

        const block = screen.getByTestId("syntax-block");
        expect(block).toHaveAttribute("data-language", "text");
        expect(block).toHaveTextContent("[not valid");
    });

    it("handles additional language aliases and JSONC fences", () => {
        const { rerender } = render(
            <ChatMarkdown text={'```jsonc\n{"ok": true, // yes\n}\n```'} />
        );

        expect(screen.getByText("jsonc")).toBeInTheDocument();
        expect(screen.getByTestId("json-block")).toHaveTextContent(
            JSON.stringify({ ok: true })
        );

        rerender(<ChatMarkdown text={"```py\nprint('hi')\n```"} />);
        expect(screen.getByTestId("syntax-block")).toHaveAttribute(
            "data-language",
            "python"
        );

        rerender(<ChatMarkdown text={"```rs\nfn main() {}\n```"} />);
        expect(screen.getByTestId("syntax-block")).toHaveAttribute(
            "data-language",
            "rust"
        );

        rerender(<ChatMarkdown text={"```yml\nok: true\n```"} />);
        expect(screen.getByTestId("syntax-block")).toHaveAttribute(
            "data-language",
            "yaml"
        );
    });

    it("renders raw pre blocks and ignores images without sources", () => {
        render(<ChatMarkdown text={["<pre>raw pre</pre>", "", "![]()"].join("\n")} />);

        expect(screen.getByText("<pre>raw pre</pre>")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "" })).not.toBeInTheDocument();
    });
});
