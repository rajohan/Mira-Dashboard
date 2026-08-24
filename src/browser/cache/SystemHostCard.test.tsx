import { describe, expect, test } from "bun:test";

import type { CacheEntry } from "../../contracts/cache.ts";
import { SystemHostCard } from "./SystemHostCard.tsx";

const { render, screen } = await import("@testing-library/react");

const timestampMs = 1_800_000_000_000;

function entry(payload: CacheEntry["payload"]): CacheEntry {
    return {
        consecutiveFailures: 1,
        expiresAtMs: timestampMs + 60_000,
        failureCode: "provider.failed",
        failureMessage: "The latest refresh failed.",
        freshness: "fresh",
        key: "system.host",
        lastAttemptAtMs: timestampMs,
        lastAttemptDurationMs: 200,
        lastAttemptNumber: 2,
        lastAttemptRunId: "019fe000-0000-7000-8000-000000000002",
        lastAttemptStatus: "failed",
        lastSuccessAtMs: timestampMs - 1000,
        manualRunAvailable: true,
        metadata: {},
        payload,
        schemaId: "system.host.v1",
        source: "system.host",
        updatedAtMs: timestampMs,
    };
}

describe("SystemHostCard", () => {
    test("renders only reviewed system.host fields and independent statuses", () => {
        render(
            <SystemHostCard
                entry={entry({
                    architecture: "x64",
                    disk: {
                        freeBytes: 40 * 1024 ** 3,
                        path: "/",
                        totalBytes: 100 * 1024 ** 3,
                    },
                    hostname: "mira-vps",
                    memory: {
                        freeBytes: 2 * 1024 ** 3,
                        totalBytes: 8 * 1024 ** 3,
                    },
                    platform: "linux",
                    release: "6.8.0",
                    uptimeSeconds: 183_600,
                })}
            />
        );
        expect(screen.getByRole("heading", { name: "mira-vps" })).toBeTruthy();
        expect(screen.getByText("Up to date")).toBeTruthy();
        expect(screen.getByText("Last refresh Failed")).toBeTruthy();
        expect(screen.getByRole("progressbar", { name: "Memory used" })).toBeTruthy();
        expect(screen.getByText("75% used · 2.0 GiB free")).toBeTruthy();
        expect(screen.getByText("Uptime 2d 3h")).toBeTruthy();
    });

    test("fails closed when a generic cache payload is not a system.host payload", () => {
        render(<SystemHostCard entry={entry({ unexpected: "value" })} />);
        expect(
            screen.getByRole("heading", { name: "Host data unavailable" })
        ).toBeTruthy();
        expect(screen.queryByText("value")).toBeNull();
    });

    test("fails closed when the payload shape is not bound to the reviewed schema", () => {
        const validPayload = {
            architecture: "x64",
            disk: { freeBytes: 40, path: "/" as const, totalBytes: 100 },
            hostname: "must-not-render",
            memory: { freeBytes: 20, totalBytes: 100 },
            platform: "linux",
            release: "6.8.0",
            uptimeSeconds: 60,
        };
        render(
            <SystemHostCard
                entry={{
                    ...entry(validPayload),
                    schemaId: "system.host.v2",
                    source: "another.provider",
                }}
            />
        );
        expect(
            screen.getByRole("heading", { name: "Host data unavailable" })
        ).toBeTruthy();
        expect(screen.queryByText("must-not-render")).toBeNull();
    });
});
