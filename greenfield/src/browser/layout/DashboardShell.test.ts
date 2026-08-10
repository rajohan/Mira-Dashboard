import { describe, expect, test } from "bun:test";

import {
    dashboardContentContainerClassName,
    dashboardMainClassName,
    dashboardPageContainerClassName,
} from "./dashboardShellLayout.ts";

describe("Dashboard shell layout", () => {
    test("keeps the Terminal workspace full-height with the standard responsive gutter", () => {
        expect(dashboardMainClassName("/terminal").split(" ")).toEqual(
            expect.arrayContaining([
                "min-h-0",
                "flex-1",
                "overflow-hidden",
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

    test("bounds Files to the viewport without losing normal page centering", () => {
        expect(dashboardContentContainerClassName("/files").split(" ")).toEqual(
            expect.arrayContaining([
                "h-full",
                "min-h-0",
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
