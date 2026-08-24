import { describe, expect, test } from "bun:test";

import type { SystemMetrics } from "../../contracts/system.ts";
import { SystemMetricsCards } from "./SystemMetricsCards.tsx";

const { render, screen, within } = await import("@testing-library/react");

const metrics = Object.freeze({
    cpu: {
        loadAverage: [9.92, 4.2, 2.1],
        loadPercent: 248,
        logicalCoreCount: 4,
    },
    disk: {
        freeBytes: 40 * 1024 ** 3,
        totalBytes: 100 * 1024 ** 3,
        usedBytes: 60 * 1024 ** 3,
        usedPercent: 60,
    },
    freshness: "fresh",
    memory: {
        freeBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        usedBytes: 6 * 1024 ** 3,
        usedPercent: 75,
    },
    network: {
        downloadBitsPerSecond: 12_300_000,
        state: "ready",
        uploadBitsPerSecond: 1_250_000,
    },
    sampledAtMs: 1_800_000_000_000,
    uptimeSeconds: 183_600,
} as const satisfies SystemMetrics);

function card(title: string): HTMLElement {
    const heading = screen.getByRole("heading", { level: 3, name: title });
    const element = heading.closest("section");
    if (!(element instanceof HTMLElement)) throw new TypeError("Missing metric card");
    return element;
}

describe("SystemMetricsCards", () => {
    test("renders reviewed values without host or interface identity", () => {
        render(<SystemMetricsCards metrics={metrics} />);

        expect(within(card("CPU")).getByText("248%")).toBeTruthy();
        expect(within(card("CPU")).getByText(/1 minute load 9\.92/u)).toBeTruthy();
        expect(within(card("Memory")).getByText("75%")).toBeTruthy();
        expect(within(card("Disk")).getByText("60%")).toBeTruthy();
        expect(within(card("Uptime")).getByText("2d 3h")).toBeTruthy();
        expect(within(card("Download")).getByText("12.3 Mbit/s")).toBeTruthy();
        expect(screen.queryByText(/hostname|interface|model/iu)).toBeNull();
    });

    test("discloses the first network sample as warming", () => {
        render(
            <SystemMetricsCards
                metrics={{
                    ...metrics,
                    network: {
                        downloadBitsPerSecond: 0,
                        state: "warming",
                        uploadBitsPerSecond: 0,
                    },
                }}
            />
        );

        expect(screen.getAllByText("Sampling…")).toHaveLength(2);
        expect(screen.queryByText("0 bit/s")).toBeNull();
    });
});
