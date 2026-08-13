import { describe, expect, mock, test } from "bun:test";

import type { KopiaBackupStatus, WalgBackupStatus } from "../../contracts/backups.ts";
import { BackupOverviewSectionView } from "./BackupOverviewSection.tsx";

const { fireEvent, render, screen, within } = await import("@testing-library/react");

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

    test("exposes attention recovery while independently gating a busy provider", () => {
        const runId = "019fc968-1a9b-7765-8f1b-d5b863b0e7b4";
        const onClearKopiaAttention = mock(() => {});
        render(
            <BackupOverviewSectionView
                kopia={{
                    ...kopia,
                    activity: {
                        finishedAtMs: nowMs,
                        jobRunId: runId,
                        jobsUrl: `/jobs?runId=${runId}`,
                        queuedAtMs: nowMs - 2000,
                        startedAtMs: nowMs - 1000,
                        state: "needs-attention",
                    },
                }}
                onClearKopiaAttention={onClearKopiaAttention}
                walg={{
                    ...walg,
                    payload: { ...walg.payload, providerIdle: false },
                }}
            />
        );

        const kopiaCard = screen.getByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Needs attention")).toBeTruthy();
        const clearAttention = within(kopiaCard).getByRole("button", {
            name: "Clear attention",
        });
        fireEvent.click(clearAttention);
        expect(onClearKopiaAttention).toHaveBeenCalledTimes(1);
        expect(
            within(kopiaCard).getByRole("link", { name: "View job" }).getAttribute("href")
        ).toBe(`/jobs?runId=${runId}`);

        const walgCard = screen.getByLabelText("WAL-G backup");
        expect(within(walgCard).getByText("Busy")).toBeTruthy();
        expect(
            within(walgCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();
    });

    test("keeps unavailable and missing providers actionable without enabling backup controls", () => {
        const onRetryWalg = mock(() => {});
        render(
            <BackupOverviewSectionView
                controlsDisabled
                kopia={{
                    activity: { state: "idle" },
                    checkedAtMs: nowMs,
                    state: "unavailable",
                    type: "kopia",
                }}
                onRetryWalg={onRetryWalg}
                walg={undefined}
            />
        );

        const kopiaCard = screen.getByLabelText("Kopia backup");
        expect(within(kopiaCard).getByText("Unavailable")).toBeTruthy();
        expect(
            within(kopiaCard).getByText(
                "No trustworthy provider status is currently available."
            )
        ).toBeTruthy();
        expect(
            within(kopiaCard).getByText("Backup controls are disabled for this session.")
        ).toBeTruthy();
        expect(
            within(kopiaCard).getByRole("button", { name: "Run backup" })
        ).toBeDisabled();

        const walgCard = screen.getByLabelText("WAL-G backup");
        const retry = within(walgCard).getByRole("button", { name: "Retry" });
        fireEvent.click(retry);
        expect(onRetryWalg).toHaveBeenCalledTimes(1);
    });

    test("shows per-provider loading while preserving available status", () => {
        render(<BackupOverviewSectionView kopia={kopia} loading walg={undefined} />);

        expect(screen.getByLabelText("Kopia backup")).toBeTruthy();
        expect(
            screen.getByRole("status", { name: "Loading WAL-G backup status…" })
        ).toBeTruthy();
    });
});
