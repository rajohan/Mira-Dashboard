import { describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, within } from "@testing-library/react";

import { DocsRoute } from "./DocsRoute.tsx";

describe("DocsRoute", () => {
    test("renders the complete generated reference and filters by content", () => {
        render(<DocsRoute />);

        expect(
            screen.queryByRole("heading", { name: "Documentation" })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Search the generated API, schema, database/iu)
        ).not.toBeInTheDocument();
        expect(screen.getByText(/documents$/u)).toHaveTextContent(/of \d+ documents/u);

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            {
                target: { value: "tRPC procedures" },
            }
        );

        const navigation = screen.getByRole("navigation", {
            name: "Generated documentation",
        });
        expect(within(navigation).getByText("README")).toBeVisible();
        expect(screen.getAllByText(/tRPC procedures/iu)[0]).toHaveProperty(
            "tagName",
            "MARK"
        );
        expect(screen.getByText("README.md", { selector: "p" })).toBeVisible();
    });

    test("groups schema documents into collapsible domain menus", () => {
        render(<DocsRoute />);

        const authMenu = screen.getByRole("button", { name: /^Auth \d+$/u });
        expect(authMenu).toHaveAttribute("aria-expanded", "false");
        expect(authMenu.querySelector("svg")).toHaveClass("group-data-open:rotate-180");
        expect(authMenu).toHaveClass("data-open:bg-transparent");
        expect(authMenu).toHaveClass("data-open:hover:bg-primary-700");
        expect(authMenu).not.toHaveClass("data-open:bg-primary-800");

        fireEvent.click(authMenu);
        expect(authMenu).toHaveAttribute("aria-expanded", "true");
        expect(authMenu).toHaveAttribute("data-open");
        expect(
            screen.getByRole("button", { name: /auth\.login\.input\.schema/u })
        ).toBeVisible();

        fireEvent.click(authMenu);
        expect(authMenu).toHaveAttribute("aria-expanded", "false");
    });

    test("lets the fixed viewer own horizontal scrolling for wide tables", () => {
        render(<DocsRoute />);

        fireEvent.click(
            screen.getByRole("button", { name: /packages and runtime packages/u })
        );

        const table = screen.getAllByRole("table")[0]!;
        expect(table.parentElement).toHaveClass("w-max", "min-w-full");
        expect(table.parentElement).not.toHaveClass("overflow-x-auto");
        expect(table.closest(".prose")).toHaveClass(
            "[&_table]:w-max",
            "[&_table]:min-w-full"
        );
    });

    test("uses a fixed scrolling viewer and jumps to the first search highlight", () => {
        const originalScrollIntoView = Object.getOwnPropertyDescriptor(
            Element.prototype,
            "scrollIntoView"
        );
        const scrollIntoView = mock(() => {});
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        try {
            render(<DocsRoute />);

            const path = screen.getByText("README.md", { selector: "p" });
            const viewerCard = path.closest("section")!;
            expect(viewerCard).toHaveClass("h-[78vh]", "overflow-hidden");
            expect(viewerCard.lastElementChild).toHaveClass(
                "min-h-0",
                "overflow-auto",
                "[scrollbar-gutter:stable]",
                "[&::-webkit-scrollbar]:h-2",
                "[&::-webkit-scrollbar-thumb]:bg-primary-500"
            );

            fireEvent.change(
                screen.getByRole("searchbox", { name: "Search documentation" }),
                { target: { value: "tRPC procedures" } }
            );
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        } finally {
            if (originalScrollIntoView === undefined) {
                Reflect.deleteProperty(Element.prototype, "scrollIntoView");
            } else {
                Object.defineProperty(
                    Element.prototype,
                    "scrollIntoView",
                    originalScrollIntoView
                );
            }
        }
    });

    test("counts search matches and jumps forward with wrapping navigation", () => {
        render(<DocsRoute />);

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            { target: { value: "raw" } }
        );

        expect(screen.getByText(/^1 of \d+ matches$/u)).toBeVisible();
        expect(document.querySelector("mark[data-active='true']")).toHaveClass(
            "data-[active=true]:outline-2",
            "data-[active=true]:outline-offset-2"
        );

        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(screen.getByText(/^2 of \d+ matches$/u)).toBeVisible();

        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        expect(screen.getByText(/^1 of \d+ matches$/u)).toBeVisible();
    });

    test("navigates every logs match in routes and features", () => {
        render(<DocsRoute />);

        fireEvent.click(
            screen.getByRole("button", {
                name: /routes and features routes-and-features\.md/u,
            })
        );
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            { target: { value: "logs" } }
        );

        expect(screen.getByText("1 of 3 matches")).toBeVisible();
        const viewerCard = screen
            .getByText("routes-and-features.md", { selector: "p" })
            .closest("section")!;
        expect(viewerCard.querySelectorAll("mark")).toHaveLength(3);

        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(screen.getByText("2 of 3 matches")).toBeVisible();
        expect(viewerCard.querySelectorAll("mark[data-active='true']")).toHaveLength(1);
        expect(viewerCard.querySelectorAll("mark")[1]).toHaveAttribute(
            "data-active",
            "true"
        );
        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        expect(screen.getByText("1 of 3 matches")).toBeVisible();
        expect(viewerCard.querySelectorAll("mark[data-active='true']")).toHaveLength(1);
        expect(viewerCard.querySelectorAll("mark")[0]).toHaveAttribute(
            "data-active",
            "true"
        );
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
