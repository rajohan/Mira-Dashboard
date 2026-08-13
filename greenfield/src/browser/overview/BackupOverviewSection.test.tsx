import { describe, expect, test } from "bun:test";

import type { KopiaBackupStatus, WalgBackupStatus } from "../../contracts/backups.ts";
import { BackupOverviewSectionView } from "./BackupOverviewSection.tsx";

const { render, screen, within } = await import("@testing-library/react");

const nowMs = 1_800_000_000_000;
const sourceRevision = "a".repeat(64);
const kopia = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 1,
        healthy: true,
        observedAtMs: nowMs,
        providerIdle: true,
        sourceRevision,
        sources: [
            {
                health: "current",
                id: "primary",
                latestCompletedAtMs: nowMs,
                snapshotCount: 1,
            },
        ],
        type: "kopia",
    },
    state: "fresh",
} as const satisfies KopiaBackupStatus);
const walg = Object.freeze({
    activity: { state: "idle" },
    checkedAtMs: nowMs,
    payload: {
        backupCount: 1,
        healthy: true,
        latestCompletedAtMs: nowMs,
        observedAtMs: nowMs,
        providerIdle: true,
        sourceRevision,
        type: "walg",
    },
    state: "fresh",
} as const satisfies WalgBackupStatus);
const failedBusyWalg = Object.freeze({
    ...walg,
    activity: {
        finishedAtMs: nowMs,
        jobRunId: "019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
        jobsUrl: "/jobs?runId=019fc968-1a9b-7765-8f1b-d5b863b0e7b4",
        queuedAtMs: nowMs,
        state: "failed",
    },
    payload: {
        ...walg.payload,
        providerIdle: false,
    },
} as const satisfies WalgBackupStatus);

describe("BackupOverviewSectionView", () => {
    test("keeps one healthy provider visible when the other query fails", () => {
        render(
            <BackupOverviewSectionView
                error="Kopia status failed."
                kopia={undefined}
                walg={walg}
            />
        );

        expect(screen.getByText("Kopia status failed.")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Kopia" })).toBeTruthy();
        const walgCard = screen.getByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Fresh")).toBeTruthy();
        expect(
            within(walgCard).getByRole("button", { name: "Run backup" })
        ).toBeEnabled();
    });

    test("gates stale controls while preserving last-known-good data", () => {
        render(
            <BackupOverviewSectionView
                kopia={{
                    ...kopia,
                    staleSinceMs: nowMs,
                    state: "last-known-good",
                }}
                walg={walg}
            />
        );

        const kopiaCard = screen.getByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Last known good")).toBeTruthy();
        expect(within(kopiaCard).getByText("1", { selector: "strong" })).toBeTruthy();
        expect(
            within(kopiaCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();
    });

    test("keeps a terminal provider failure visible while the provider is busy", () => {
        render(<BackupOverviewSectionView kopia={kopia} walg={failedBusyWalg} />);

        const walgCard = screen.getByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Failed")).toBeTruthy();
        expect(within(walgCard).queryByText("Busy")).toBeNull();
    });
});
