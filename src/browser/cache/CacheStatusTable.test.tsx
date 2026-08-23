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

        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "View system.host" }));
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
                .getByRole("button", { name: "View system.host" })
                .getAttribute("aria-current")
        ).toBe("true");
        expect(screen.getByRole("button", { name: "View system.host" })).toHaveClass(
            "border-accent-500/60",
            "bg-primary-800/70"
        );
        expect(
            screen.getByRole("navigation", { name: "Saved data sources" })
        ).toBeTruthy();
        expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
    });

    test("keeps a large bounded snapshot in one compact scrollable list", () => {
        render(
            <CacheStatusTable
                entries={Array.from({ length: 50 }, (_, index) =>
                    status(`provider.${index.toString().padStart(3, "0")}`)
                )}
                onSelect={jest.fn()}
            />
        );
        const navigation = screen.getByRole("navigation", {
            name: "Saved data sources",
        });
        expect(navigation.querySelector("ul")).toHaveClass(
            "max-h-176",
            "overflow-y-auto"
        );
        expect(screen.getAllByRole("button", { name: /^View provider\./u })).toHaveLength(
            50
        );
    });
});
