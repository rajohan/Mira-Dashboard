import { describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, within } from "@testing-library/react";

import generatedDocuments from "../../../docs/generated/browser-reference.json";
import { DocsRoute } from "./DocsRoute.tsx";

const renderDocsRoute = () =>
    render(<DocsRoute documents={generatedDocuments as never} />);

describe("DocsRoute", () => {
    test("renders the complete generated reference and filters by content", () => {
        renderDocsRoute();

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
        expect(screen.getByText("generated/README.md", { selector: "p" })).toBeVisible();
    });

    test("groups schema documents into collapsible domain menus", () => {
        renderDocsRoute();

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

    test("orders every maintained group, including reference, before generated docs", () => {
        renderDocsRoute();

        const navigation = screen.getByRole("navigation", {
            name: "Generated documentation",
        });
        const groupNames = within(navigation)
            .getAllByRole("button")
            .filter((button) => button.hasAttribute("aria-expanded"))
            .map((button) => button.textContent ?? "");
        const architectureIndex = groupNames.findIndex((name) =>
            name.startsWith("Architecture")
        );
        const generatedIndex = groupNames.findIndex((name) =>
            name.startsWith("Generated")
        );
        const securityIndex = groupNames.findIndex((name) => name.startsWith("Security"));
        const schemaIndex = groupNames.findIndex((name) => name.startsWith("Auth"));
        const referenceIndex = groupNames.findIndex((name) =>
            name.startsWith("Reference")
        );

        expect(architectureIndex).toBeGreaterThanOrEqual(0);
        expect(securityIndex).toBe(architectureIndex + 1);
        expect(referenceIndex).toBeGreaterThan(architectureIndex);
        expect(generatedIndex).toBeGreaterThan(referenceIndex);
        expect(schemaIndex).toBeGreaterThan(generatedIndex);
    });

    test("lets the fixed viewer own horizontal scrolling for wide tables", () => {
        renderDocsRoute();

        fireEvent.click(
            screen.getByRole("button", {
                name: /packages and runtime generated\/packages/u,
            })
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
            renderDocsRoute();

            const path = screen.getByText("generated/README.md", { selector: "p" });
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
        renderDocsRoute();

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
        renderDocsRoute();

        fireEvent.click(
            screen.getByRole("button", {
                name: /routes and features generated\/routes-and-features\.md/u,
            })
        );
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            { target: { value: "logs" } }
        );

        const viewerCard = screen
            .getByText("generated/routes-and-features.md", { selector: "p" })
            .closest("section")!;
        const matchCount = viewerCard.querySelectorAll("mark").length;
        expect(matchCount).toBeGreaterThan(1);
        expect(viewerCard.querySelector("mark mark")).toBeNull();
        expect(screen.getByText(`1 of ${matchCount} matches`)).toBeVisible();

        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(screen.getByText(`2 of ${matchCount} matches`)).toBeVisible();
        expect(viewerCard.querySelectorAll("mark[data-active='true']")).toHaveLength(1);
        expect(viewerCard.querySelectorAll("mark")[1]).toHaveAttribute(
            "data-active",
            "true"
        );
        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        expect(screen.getByText(`1 of ${matchCount} matches`)).toBeVisible();
        expect(viewerCard.querySelectorAll("mark[data-active='true']")).toHaveLength(1);
        expect(viewerCard.querySelectorAll("mark")[0]).toHaveAttribute(
            "data-active",
            "true"
        );
    });

    test("counts only rendered matches and highlights fenced code", () => {
        render(
            <DocsRoute
                documents={[
                    {
                        content:
                            "[Visible label](hidden-target.md)\n\n```text\nfenced-only\n```\n",
                        kind: "markdown",
                        path: "README.md",
                        source: "generated",
                    },
                    {
                        content: "{}\n",
                        kind: "json",
                        path: "openapi.raw-http.json",
                        source: "generated",
                    },
                ]}
            />
        );

        const search = screen.getByRole("searchbox", {
            name: "Search documentation",
        });
        fireEvent.change(search, { target: { value: "hidden-target" } });
        expect(screen.getByText("No matches")).toBeVisible();
        expect(document.querySelectorAll("mark")).toHaveLength(0);

        fireEvent.change(search, { target: { value: "fenced-only" } });
        expect(screen.getByText("1 of 1 matches")).toBeVisible();
        expect(document.querySelector("mark[data-active='true']")).toHaveTextContent(
            "fenced-only"
        );
    });

    test("caps rendered Markdown highlights", () => {
        render(
            <DocsRoute
                documents={[
                    {
                        content: `${"match ".repeat(1200)}\n`,
                        kind: "markdown",
                        path: "README.md",
                        source: "generated",
                    },
                    {
                        content: "{}\n",
                        kind: "json",
                        path: "openapi.raw-http.json",
                        source: "generated",
                    },
                ]}
            />
        );

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search documentation" }),
            { target: { value: "match" } }
        );
        expect(screen.getByText("1 of 1000 matches", { selector: "p" })).toBeVisible();
        expect(
            screen
                .getByText("README.md", { selector: "p" })
                .closest("section")
                ?.querySelectorAll("mark")
        ).toHaveLength(1000);
    });

    test("clears search when an internal link opens a nonmatching document", () => {
        render(
            <DocsRoute
                documents={[
                    {
                        content: "[Search needle](target.md)\n",
                        kind: "markdown",
                        path: "README.md",
                        source: "generated",
                    },
                    {
                        content: "Target content\n",
                        kind: "markdown",
                        path: "target.md",
                        source: "generated",
                    },
                    {
                        content: "{}\n",
                        kind: "json",
                        path: "openapi.raw-http.json",
                        source: "generated",
                    },
                ]}
            />
        );

        const search = screen.getByRole("searchbox", {
            name: "Search documentation",
        });
        fireEvent.change(search, { target: { value: "needle" } });
        fireEvent.click(screen.getByRole("link", { name: "Search needle" }));

        expect(search).toHaveValue("");
        expect(screen.getByText("target.md", { selector: "p" })).toBeVisible();
        expect(screen.getByText("Target content")).toBeVisible();
    });

    test("opens generated Markdown links and projects individual schemas", () => {
        renderDocsRoute();

        fireEvent.click(screen.getByRole("link", { name: "tRPC procedures" }));
        expect(
            screen.getByText("generated/procedures.md", { selector: "p" })
        ).toBeVisible();

        fireEvent.click(screen.getAllByRole("link", { name: "input" })[0]!);
        expect(screen.getByTestId("source-viewer-toolbar")).toHaveTextContent("JSON");
        expect(screen.getByTestId("source-viewer-source")).toHaveTextContent("$schema");
    });
});
