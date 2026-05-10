import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodePreview } from "./CodePreview";

vi.mock("react-syntax-highlighter", () => ({
    __esModule: true,
    default: ({
        language,
        children,
        showLineNumbers,
    }: {
        language: string;
        children: string;
        showLineNumbers: boolean;
    }) => (
        <div
            data-testid="syntax-highlighter"
            data-language={language}
            data-show-line-numbers={showLineNumbers ? "true" : "false"}
        >
            {children}
        </div>
    ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/hljs", () => ({
    monokai: {},
}));

describe("CodePreview", () => {
    it("renders code with syntax highlighting and line numbers", () => {
        render(<CodePreview language="python" content="print('hello')" />);

        const highlighter = screen.getByTestId("syntax-highlighter");
        expect(highlighter).toHaveAttribute("data-language", "python");
        expect(highlighter).toHaveAttribute("data-show-line-numbers", "true");
        expect(screen.getByText("print('hello')")).toBeInTheDocument();
    });

    it("renders different languages", () => {
        render(<CodePreview language="typescript" content="const x = 1;" />);

        const highlighter = screen.getByTestId("syntax-highlighter");
        expect(highlighter).toHaveAttribute("data-language", "typescript");
        expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    });
});
