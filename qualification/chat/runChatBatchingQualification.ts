import { loadReviewedOpenClawFixtures } from "../openclaw/reviewedFixtures.ts";
import { qualifyChatBatching } from "./chatBatchingQualification.ts";

/** Prints deterministic reviewed evidence without reading host runtime state. */
export async function runChatBatchingQualification(): Promise<void> {
    const { audit, manifest } = await loadReviewedOpenClawFixtures();
    const evidence = qualifyChatBatching(audit.chat);
    process.stdout.write(
        `${JSON.stringify(
            {
                candidates: evidence.candidates.map(
                    ({ accepted, concurrency, metrics, rejectionReasons }) => ({
                        accepted,
                        boundaryMaximumCommitDelayMs:
                            metrics.boundaryMaximumCommitDelayMs,
                        concurrency,
                        durableBytes: metrics.durableBytes,
                        durableRows: metrics.durableRows,
                        inputBytes: metrics.inputBytes,
                        inputEvents: metrics.inputEvents,
                        intervalMs: metrics.intervalMs,
                        maximumCommitDelayMs: metrics.maximumCommitDelayMs,
                        maximumPendingBytes: metrics.maximumPendingBytes,
                        p95CommitDelayMs: metrics.p95CommitDelayMs,
                        peakScheduledTransactionsPerSecond:
                            metrics.peakScheduledTransactionsPerSecond,
                        rejectionReasons,
                        scheduledTransactions: metrics.scheduledTransactions,
                        terminalMaximumCommitDelayMs:
                            metrics.terminalMaximumCommitDelayMs,
                        transactions: metrics.transactions,
                    })
                ),
                maximumAdditionalVisualDelayMs: evidence.maximumAdditionalVisualDelayMs,
                maximumCrashWindowMs: evidence.maximumCrashWindowMs,
                maximumScheduledTransactionsPerSecond:
                    evidence.maximumScheduledTransactionsPerSecond,
                openClawCommit: manifest.source.commit,
                openClawVersion: manifest.source.version,
                selectedIntervalMs: evidence.selectedIntervalMs,
                sourceDeltaThrottleMs: evidence.sourceDeltaThrottleMs,
            },
            null,
            2
        )}\n`
    );
}

if (import.meta.main) await runChatBatchingQualification();
