import { describe, expect, test } from "bun:test";

import { dashboardNavigationItems } from "./dashboardNavigation.ts";
import {
    dashboardContentContainerClassName,
    dashboardMainClassName,
    dashboardPageContainerClassName,
} from "./dashboardShellLayout.ts";

describe("Dashboard shell layout", () => {
    test("keeps the reviewed navigation order", () => {
        expect(dashboardNavigationItems.map(({ label }) => label)).toEqual([
            "Dashboard",
            "Tasks",
            "Agents",
            "Sessions",
            "Chat",
            "Reports",
            "Jobs",
            "Delivery",
            "Files",
            "Docker",
            "Database",
            "Moltbook",
            "Terminal",
            "Logs",
            "Settings",
            "Docs",
        ]);
    });

    test("keeps the Terminal workspace scrollable with the standard responsive gutter", () => {
        expect(dashboardMainClassName("/terminal").split(" ")).toEqual(
            expect.arrayContaining([
                "min-h-0",
                "flex-1",
                "overflow-y-auto",
                "px-4",
                "pt-8",
                "pb-3",
                "sm:px-6",
                "lg:px-8",
            ])
        );
        expect(dashboardPageContainerClassName.split(" ")).toEqual(
            expect.arrayContaining(["mx-auto", "w-full", "max-w-7xl"])
        );
    });

    test("bounds desktop Files without clipping its mobile document flow", () => {
        expect(dashboardContentContainerClassName("/files").split(" ")).toEqual(
            expect.arrayContaining([
                "lg:h-full",
                "lg:min-h-0",
                "mx-auto",
                "w-full",
                "max-w-7xl",
            ])
        );
        expect(dashboardContentContainerClassName("/chat").split(" ")).not.toContain(
            "max-w-7xl"
        );
    });

    test("preserves the compact Chat canvas and scrolling document layouts", () => {
        expect(dashboardMainClassName("/chat").split(" ")).toEqual(
            expect.arrayContaining(["overflow-hidden", "p-2", "sm:p-3"])
        );
        expect(dashboardMainClassName("/logs").split(" ")).toEqual(
            expect.arrayContaining([
                "overflow-y-auto",
                "px-4",
                "py-8",
                "sm:px-6",
                "lg:px-8",
            ])
        );
        expect(dashboardMainClassName("/files").split(" ")).toEqual(
            expect.arrayContaining([
                "min-h-0",
                "flex-1",
                "overflow-y-auto",
                "lg:overflow-hidden",
                "px-4",
                "py-8",
            ])
        );
    });
});
