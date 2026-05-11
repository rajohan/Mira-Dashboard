import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodePreview } from "./CodePreview";
import { JsonPreview } from "./JsonPreview";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("@microlink/react-json-view", () => ({
    default: ({ src }: { src: unknown }) => (
        <pre data-testid="json-preview">{JSON.stringify(src)}</pre>
    ),
}));

vi.mock("react-syntax-highlighter", () => ({
    default: ({ children, language }: { children: string; language: string }) => (
        <pre data-language={language} data-testid="code-preview">
            {children}
        </pre>
    ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/hljs", () => ({
    monokai: {},
}));

describe("file viewers", () => {
    it("renders parsed JSON5 and JSON fallback errors", () => {
        const { rerender } = render(<JsonPreview content="{name: 'Mira', ok: true}" />);

        expect(screen.getByTestId("json-preview")).toHaveTextContent(
            JSON.stringify({ name: "Mira", ok: true })
        );

        rerender(<JsonPreview content="not json" />);

        expect(screen.getByTestId("json-preview")).toHaveTextContent(
            JSON.stringify({ error: "Failed to parse JSON", raw: "not json" })
        );
    });

    it("renders markdown content", () => {
        render(<MarkdownPreview content="# Release notes\n\n- Added **tests**" />);

        expect(
            screen.getByRole("heading", { name: /Release notes/u })
        ).toBeInTheDocument();
        expect(screen.getByText("tests")).toBeInTheDocument();
    });

    it("renders code with the requested language", () => {
        render(<CodePreview language="typescript" content="const ok = true;" />);

        const preview = screen.getByTestId("code-preview");
        expect(preview).toHaveAttribute("data-language", "typescript");
        expect(preview).toHaveTextContent("const ok = true;");
    });
});
