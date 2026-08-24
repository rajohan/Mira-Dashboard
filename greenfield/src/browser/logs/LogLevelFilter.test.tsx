import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { LogLevelFilter } from "./LogLevelFilter.tsx";
import {
    allLogLevels,
    type FilterableLogLevel,
    filterableLogLevels,
    logLevelIsVisible,
} from "./logLevelFiltering.ts";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function Fixture() {
    const [levels, setLevels] = useState<ReadonlySet<FilterableLogLevel>>(allLogLevels);
    return (
        <>
            <LogLevelFilter activeLevels={levels} onChange={setLevels} />
            <output data-testid="active-levels">
                {filterableLogLevels.filter((level) => levels.has(level)).join(",")}
            </output>
        </>
    );
}

describe("log level filter", () => {
    test("filters every exact legacy level and excludes unknown from every subset", () => {
        for (const level of filterableLogLevels) {
            const active = new Set([level]);
            expect(logLevelIsVisible(level, active)).toBe(true);
            expect(logLevelIsVisible("unknown", active)).toBe(false);
            for (const other of filterableLogLevels) {
                expect(logLevelIsVisible(other, active)).toBe(other === level);
            }
        }
        expect(logLevelIsVisible("unknown", allLogLevels())).toBe(true);
        expect(logLevelIsVisible("unknown", new Set())).toBe(false);
    });

    test("exposes pressed multi-select chips plus clear and all behavior", async () => {
        const user = userEvent.setup();
        render(<Fixture />);

        const group = screen.getByRole("group", {
            name: "Log levels in current snapshot",
        });
        for (const level of filterableLogLevels) {
            expect(screen.getByRole("button", { name: level })).toHaveAttribute(
                "aria-pressed",
                "true"
            );
        }
        expect(group).toHaveTextContent("trace");
        expect(
            screen.getByRole("button", { name: "Select all log levels" })
        ).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Clear all log levels" }));
        expect(screen.getByTestId("active-levels")).toHaveTextContent("");
        expect(screen.getByRole("button", { name: "trace" })).toHaveAttribute(
            "aria-pressed",
            "false"
        );

        await user.click(screen.getByRole("button", { name: "warn" }));
        expect(screen.getByRole("button", { name: "warn" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        expect(screen.getByTestId("active-levels")).toHaveTextContent("warn");

        await user.click(screen.getByRole("button", { name: "Select all log levels" }));
        for (const level of filterableLogLevels) {
            expect(screen.getByRole("button", { name: level })).toHaveAttribute(
                "aria-pressed",
                "true"
            );
        }
    });
});
