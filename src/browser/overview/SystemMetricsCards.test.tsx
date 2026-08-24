import { describe, expect, test } from "bun:test";

import type { SystemMetrics } from "../../contracts/system.ts";
import {
    observedSystemApplicationMetrics,
    unavailableSystemApplicationMetrics,
} from "../test/systemMetrics.ts";
import { SystemMetricsCards } from "./SystemMetricsCards.tsx";

const { render, screen, within } = await import("@testing-library/react");

const metrics = Object.freeze({
    application: unavailableSystemApplicationMetrics,
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
        expect(
            within(card("CPU")).getByText(/Average load over 1 minute: 9\.92/u)
        ).toBeTruthy();
        expect(within(card("Memory")).getByText("75%")).toBeTruthy();
        expect(within(card("Disk")).getByText("60%")).toBeTruthy();
        expect(within(card("Uptime")).getByText("2d 3h")).toBeTruthy();
        expect(within(card("Download")).getByText("12.3 Mbit/s")).toBeTruthy();
        expect(
            screen.getByRole("heading", { name: "Application observability" })
        ).toBeTruthy();
        expect(screen.getByText("Runtime unavailable")).toBeTruthy();
        expect(within(card("Web runtime")).getByText("Unavailable")).toBeTruthy();
        expect(within(card("HTTP requests")).getByText("0")).toBeTruthy();
        expect(screen.queryByText(/hostname|interface|model/iu)).toBeNull();
    });

    test("renders every observed application component independently", () => {
        render(
            <SystemMetricsCards
                metrics={{
                    ...metrics,
                    application: observedSystemApplicationMetrics(metrics.sampledAtMs),
                }}
            />
        );

        expect(screen.getByText("All observed")).toBeTruthy();
        expect(within(card("Web runtime")).getByText("192 MiB")).toBeTruthy();
        expect(within(card("Durable operations")).getByText("2 active")).toBeTruthy();
        expect(within(card("Jobs")).getByText("2 running")).toBeTruthy();
        expect(within(card("Chat runtime")).getByText("1 active")).toBeTruthy();
        expect(within(card("SQLite runtime")).getByText("64 MiB")).toBeTruthy();
        expect(within(card("Gateway")).getByText("connected")).toBeTruthy();
        expect(within(card("Realtime")).getByText("3 subscribers")).toBeTruthy();
        expect(within(card("Cache")).getByText("14 entries")).toBeTruthy();
        expect(within(card("HTTP requests")).getByText("29")).toBeTruthy();
        expect(within(card("HTTP requests")).getByText(/1 errors/u)).toBeTruthy();
        const cacheMetrics = screen.getByRole("list", {
            name: "Cache snapshot metrics",
        });
        expect(
            screen
                .getByRole("region", { name: "Cache snapshot metrics scroll area" })
                .getAttribute("tabindex")
        ).toBe("0");
        expect(within(cacheMetrics).getByText("system.host")).toBeTruthy();
        const procedureMetrics = screen.getByRole("list", {
            name: "HTTP procedure metrics",
        });
        expect(
            screen
                .getByRole("region", { name: "HTTP procedure metrics scroll area" })
                .getAttribute("tabindex")
        ).toBe("0");
        expect(within(procedureMetrics).getByText("system.metrics")).toBeTruthy();
        expect(
            within(procedureMetrics).getByText(/25 requests · 0 errors/u)
        ).toBeTruthy();
    });

    test("marks a partial application observation without hiding healthy readers", () => {
        const application = observedSystemApplicationMetrics(metrics.sampledAtMs);
        render(
            <SystemMetricsCards
                metrics={{
                    ...metrics,
                    application: { ...application, realtime: { state: "unavailable" } },
                }}
            />
        );

        expect(screen.getByText("7 of 8 observed")).toBeTruthy();
        expect(within(card("Realtime")).getByText("Unavailable")).toBeTruthy();
        expect(within(card("Jobs")).getByText("2 running")).toBeTruthy();
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

        expect(screen.getAllByText("Measuring…")).toHaveLength(2);
        expect(screen.queryByText("0 bit/s")).toBeNull();
    });
});
