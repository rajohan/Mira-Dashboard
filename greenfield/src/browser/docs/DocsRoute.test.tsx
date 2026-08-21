import { describe, expect, test } from "bun:test";

import { fireEvent, render, screen, within } from "@testing-library/react";

import { DocsRoute } from "./DocsRoute.tsx";

describe("DocsRoute", () => {
    test("renders the complete generated reference and filters by content", () => {
        render(<DocsRoute />);

        expect(screen.getByRole("heading", { name: "Documentation" })).toBeVisible();
        expect(screen.getByText(/documents$/u)).toHaveTextContent(/of \d+ documents/u);

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            {
                target: { value: "Mira Dashboard raw HTTP API" },
            }
        );

        const navigation = screen.getByRole("navigation", {
            name: "Generated documentation",
        });
        expect(within(navigation).getByText("openapi.raw http")).toBeVisible();
    });

    test("opens generated Markdown links and projects individual schemas", () => {
        render(<DocsRoute />);

        fireEvent.click(screen.getByRole("link", { name: "tRPC procedures" }));
        expect(screen.getByText("procedures.md", { selector: "p" })).toBeVisible();

        fireEvent.click(screen.getAllByRole("link", { name: "input" })[0]!);
        expect(screen.getByTestId("source-viewer-toolbar")).toHaveTextContent("JSON");
        expect(screen.getByTestId("source-viewer-source")).toHaveTextContent("$schema");
    });
});
