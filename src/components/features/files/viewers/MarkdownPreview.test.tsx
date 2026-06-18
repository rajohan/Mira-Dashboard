import { render, screen } from "@testing-library/react";
import { describe, expect, it, mock } from "bun:test";

import { MarkdownPreview } from "./MarkdownPreview";

mock.module("react-markdown", () => ({
    __esModule: true,
    default: ({ children }: { children: string }) => (
        <div data-testid="react-markdown">{children}</div>
    ),
}));

mock.module("remark-gfm", () => ({
    __esModule: true,
    default: () => () => {},
}));

mock.module("remark-frontmatter", () => ({
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
