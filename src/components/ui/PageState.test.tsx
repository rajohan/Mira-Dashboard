import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageState } from "./PageState";

describe("PageState", () => {
    it("renders loading state first", () => {
        render(
            <PageState
                isLoading
                loading={<p>Loading</p>}
                error="Boom"
                isEmpty
                empty={<p>Empty</p>}
            >
                <p>Content</p>
            </PageState>
        );

        expect(screen.getByText("Loading")).toBeInTheDocument();
        expect(screen.queryByText("Content")).not.toBeInTheDocument();
    });

    it("renders error, empty, or children by priority", () => {
        const { rerender } = render(
            <PageState error="Boom" errorView={<p>Error</p>}>
                <p>Content</p>
            </PageState>
        );
        expect(screen.getByText("Error")).toBeInTheDocument();

        rerender(
            <PageState isEmpty empty={<p>Empty</p>}>
                <p>Content</p>
            </PageState>
        );
        expect(screen.getByText("Empty")).toBeInTheDocument();

        rerender(
            <PageState>
                <p>Content</p>
            </PageState>
        );
        expect(screen.getByText("Content")).toBeInTheDocument();
    });
});
