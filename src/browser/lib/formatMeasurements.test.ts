import { describe, expect, test } from "bun:test";

import {
    formatBitsPerSecond,
    formatByteCount,
    formatCompactCount,
    formatLoadValue,
    formatPercent,
    formatUptime,
} from "./formatMeasurements.ts";

describe("measurement formatting", () => {
    test("formats validated capacity, load and uptime values compactly", () => {
        expect(formatByteCount(0)).toBe("0 B");
        expect(formatByteCount(1536)).toBe("1.5 KiB");
        expect(formatPercent(75)).toBe("75%");
        expect(formatPercent(248.1)).toBe("248.1%");
        expect(formatLoadValue(9.9)).toBe("9.9");
        expect(formatUptime(183_600)).toBe("2d 3h");
    });

    test("uses decimal network units without noisy trailing zeros", () => {
        expect(formatBitsPerSecond(0)).toBe("0 bit/s");
        expect(formatBitsPerSecond(800)).toBe("800 bit/s");
        expect(formatBitsPerSecond(12_300_000)).toBe("12.3 Mbit/s");
        expect(formatBitsPerSecond(1_250_000_000)).toBe("1.25 Gbit/s");
    });

    test("formats compact decimal counts for constrained UI chrome", () => {
        expect(formatCompactCount(999)).toBe("999");
        expect(formatCompactCount(40_000)).toBe("40k");
        expect(formatCompactCount(272_000)).toBe("272k");
        expect(formatCompactCount(999_999)).toBe("1m");
        expect(formatCompactCount(1_250_000)).toBe("1.3m");
    });
});
