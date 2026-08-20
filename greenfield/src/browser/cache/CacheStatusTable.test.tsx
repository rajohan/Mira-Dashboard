import { describe, expect, jest, test } from "bun:test";

import type { CacheEntryStatus } from "../../contracts/cache.ts";
import { CacheStatusTable } from "./CacheStatusTable.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;

function status(
    key: string,
    overrides: Partial<CacheEntryStatus> = {}
): CacheEntryStatus {
    return {
        consecutiveFailures: 0,
        expiresAtMs: timestampMs + 86_400_000,
        freshness: "fresh",
        key,
        lastAttemptAtMs: timestampMs,
        lastAttemptDurationMs: 120,
        lastAttemptNumber: 1,
        lastAttemptRunId: "019fe000-0000-7000-8000-000000000001",
        lastAttemptStatus: "succeeded",
        lastSuccessAtMs: timestampMs,
        manualRunAvailable: true,
        metadata: {},
        schemaId: "system.host.v1",
        source: "system.host",
        updatedAtMs: timestampMs,
        ...overrides,
    };
}

describe("CacheStatusTable", () => {
    test("shows freshness separately from the latest failed attempt", async () => {
        const selected: string[] = [];
        render(
            <CacheStatusTable
                entries={[
                    status("system.host", {
                        consecutiveFailures: 1,
                        failureCode: "provider.failed",
                        failureMessage: "Host projection failed.",
                        lastAttemptStatus: "failed",
                    }),
                ]}
                onSelect={(key) => selected.push(key)}
            />
        );
        expect(screen.getByText("Up to date")).toBeTruthy();
        expect(screen.getByText("Failed")).toBeTruthy();
        expect(screen.getByText("Available")).toBeTruthy();

        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "system.host" }));
        expect(selected).toEqual(["system.host"]);
    });

    test("marks the selected cache key without tabbing into a non-scrolling region", () => {
        render(
            <CacheStatusTable
                entries={[
                    status("system.host"),
                    status("weather.spydeberg", {
                        freshness: "missing",
                        lastSuccessAtMs: undefined,
                        expiresAtMs: undefined,
                        metadata: undefined,
                        schemaId: undefined,
                        source: undefined,
                        lastAttemptStatus: "failed",
                        consecutiveFailures: 1,
                        failureCode: "provider.failed",
                        failureMessage: "Weather projection failed.",
                    }),
                ]}
                onSelect={() => {
                    throw new Error("Unexpected cache selection");
                }}
                selectedKey="system.host"
            />
        );
        expect(
            screen
                .getByRole("button", { name: "system.host" })
                .getAttribute("aria-current")
        ).toBe("true");
        expect(screen.getByRole("button", { name: "system.host" })).toHaveClass(
            "min-h-8",
            "underline"
        );
        expect(
            screen.getByRole("region", { name: "Saved data sources" })
        ).not.toHaveAttribute("tabindex");
        expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
    });

    test("keeps a large bounded snapshot accessible before viewport measurement", () => {
        render(
            <CacheStatusTable
                entries={Array.from({ length: 50 }, (_, index) =>
                    status(`provider.${index.toString().padStart(3, "0")}`)
                )}
                onSelect={jest.fn()}
            />
        );
        const table = screen.getByRole("table", { name: "Saved data sources" });
        expect(table.getAttribute("aria-rowcount")).toBe("51");
        expect(table.querySelector("td[height]")).toBeTruthy();
        expect(screen.getByRole("region", { name: "Saved data sources" }).tabIndex).toBe(
            0
        );
        expect(screen.getAllByRole("button", { name: /^provider\./u })).toHaveLength(50);
    });
});
