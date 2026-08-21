import { describe, expect, test } from "bun:test";

import { type BrowserRouteDocumentationInput, renderBrowserRoutes } from "./markdown.ts";

const route = {
    access: "session",
    featureOwner: "files",
    navigationLabel: "Files",
    path: "/files",
    summary: "Browses bounded files.",
} satisfies BrowserRouteDocumentationInput;

describe("browser route Markdown", () => {
    test("renders sorted source-backed route metadata without mutating it", () => {
        const routes = Object.freeze([
            Object.freeze({
                ...route,
                access: "public" as const,
                featureOwner: "security",
                navigationLabel: null,
                path: "/login",
                summary: "Starts a browser session.",
            }),
            Object.freeze({ ...route }),
        ]);

        const documentation = renderBrowserRoutes(routes);

        expect(documentation).toContain(
            "| `/files` | Browser session | Files | `files` | Browses bounded files. |"
        );
        expect(documentation).toContain(
            "| `/login` | Public | Hidden | `security` | Starts a browser session. |"
        );
        expect(documentation.indexOf("`/files`")).toBeLessThan(
            documentation.indexOf("`/login`")
        );
        expect(routes[0]?.path).toBe("/login");
    });

    test("escapes table controls and rejects missing or duplicate metadata", () => {
        expect(
            renderBrowserRoutes([
                {
                    ...route,
                    summary: String.raw`Pipe | and backslash \\ remain data.`,
                },
            ])
        ).toContain(String.raw`Pipe \| and backslash \\\\ remain data.`);
        expect(() => renderBrowserRoutes([])).toThrow("Browser route registry is empty");
        expect(() => renderBrowserRoutes([route, route])).toThrow(
            "Browser route documentation metadata is invalid"
        );
        expect(() => renderBrowserRoutes([{ ...route, featureOwner: " " }])).toThrow(
            "Browser route documentation metadata is invalid"
        );
        expect(() => renderBrowserRoutes([{ ...route, path: "files" }])).toThrow(
            "Browser route documentation metadata is invalid"
        );
        expect(() => renderBrowserRoutes([{ ...route, summary: " " }])).toThrow(
            "Browser route documentation metadata is invalid"
        );
    });
});
