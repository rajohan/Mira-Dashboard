import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("react-markdown", () => ({
    __esModule: true,
    default: ({ children }: { children: string }) => (
        <div data-testid="react-markdown">{children}</div>
    ),
}));

vi.mock("remark-gfm", () => ({
    __esModule: true,
    default: () => () => {},
}));

vi.mock("remark-frontmatter", () => ({
    __esModule: true,
    default: () => () => {},
}));

describe("MarkdownPreview", () => {
    it("renders markdown content", () => {
        render(<MarkdownPreview content="# Hello World" />);

        expect(screen.getByTestId("react-markdown")).toBeInTheDocument();
        expect(screen.getByText("# Hello World")).toBeInTheDocument();
    });

    it("renders different markdown content", () => {
        render(<MarkdownPreview content="- item 1\n- item 2" />);

        expect(screen.getByTestId("react-markdown")).toHaveTextContent(
            String.raw`- item 1\n- item 2`
        );
    });
});
