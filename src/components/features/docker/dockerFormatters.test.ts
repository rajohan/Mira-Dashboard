import { describe, expect, it } from "vitest";

import {
    formatBytes,
    formatDockerMemory,
    formatFullVersionDisplay,
    formatTimestamp,
    formatUpdaterTransition,
    formatVersionDisplay,
} from "./dockerFormatters";

describe("docker formatters", () => {
    it("formats byte values with stable units and fallbacks", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(Number.NaN)).toBe("0 B");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatBytes(10 * 1024 ** 2)).toBe("10 MB");
        expect(formatBytes(1.25 * 1024 ** 4)).toBe("1.3 TB");
    });

    it("normalizes docker memory pairs when both sides can be parsed", () => {
        const missingMemory: string | undefined = undefined;
        expect(formatDockerMemory(missingMemory)).toBe("—");
        expect(formatDockerMemory("bad value")).toBe("bad value");
        expect(formatDockerMemory("512KiB / 2MiB")).toBe("512 KB / 2.0 MB");
        expect(formatDockerMemory("1.5 GiB / 10 GB")).toBe("1.5 GB / 10 GB");
        expect(formatDockerMemory("0 B / 2 MiB")).toBe("0 B / 2 MiB");
    });

    it("formats timestamps and keeps invalid input visible", () => {
        expect(formatTimestamp(null)).toBe("—");
        expect(formatTimestamp("not-a-date")).toBe("not-a-date");
        expect(formatTimestamp("2026-05-10T10:00:00.000Z")).toContain("2026");
    });

    it("formats image version transitions from tags and digests", () => {
        expect(formatVersionDisplay("v1", "sha256:abcdef")).toBe("v1");
        expect(formatVersionDisplay(null, "sha256:abcdef1234567890")).toBe(
            "sha256:abcde"
        );
        expect(formatVersionDisplay(null, null)).toBe("—");

        expect(formatFullVersionDisplay("v2", "sha256:def")).toBe("v2 (sha256:def)");
        expect(formatFullVersionDisplay("v2", null)).toBe("v2");
        expect(formatFullVersionDisplay(null, "sha256:def")).toBe("sha256:def");
        expect(formatFullVersionDisplay(null, null)).toBe("—");

        expect(
            formatUpdaterTransition({
                fromTag: "v1",
                toTag: null,
                fromDigest: null,
                toDigest: "sha256:abcdef1234567890",
            })
        ).toBe("v1 → sha256:abcde");
    });
});
