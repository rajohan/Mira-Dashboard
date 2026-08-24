import { CloudCog } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type {
    OpenClawCronJob,
    UpdateOpenClawCronPatch,
} from "../../contracts/openClawCron.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { OpenClawCronDefinitionDialog } from "./OpenClawCronDefinitionDialog.tsx";
import { OpenClawCronDetail } from "./OpenClawCronDetail.tsx";
import {
    type OpenClawCronDisableDraft,
    OpenClawCronDisableDialog,
} from "./OpenClawCronDisableDialog.tsx";
import type {
    OpenClawCronInventoryView,
    OpenClawCronRunsView,
} from "./openClawCronQueries.ts";
import { OpenClawCronTable } from "./OpenClawCronTable.tsx";
import {
    openClawCronUnknownOutcomeMessage,
    orderOpenClawCronJobs,
} from "./presentation.ts";
import { useOpenClawCronRealtimeInvalidation } from "./useOpenClawCronRealtimeInvalidation.ts";

export type OpenClawCronSectionState =
    | Readonly<{ status: "loading" }>
    | Readonly<{ message: string; status: "error" }>
    | Readonly<{ result: OpenClawCronInventoryView; status: "ready" }>;

export interface OpenClawCronSectionProps {
    readonly backgroundError?: string;
    readonly jobsLoadingMore?: boolean;
    readonly onDelete: (job: OpenClawCronJob) => Promise<void>;
    readonly onLoadMoreJobs?: () => void;
    readonly onLoadMoreRuns?: () => void;
    readonly onReconcile?: () => Promise<boolean>;
    readonly onRetry: () => void;
    readonly onRetryRuns?: () => void;
    readonly onRun: (job: OpenClawCronJob) => Promise<void>;
    readonly onSelectJob?: (job: OpenClawCronJob) => void;
    readonly onSetEnabled: (
        job: OpenClawCronJob,
        enabled: boolean,
        disableIntent?: OpenClawCronDisableDraft
    ) => Promise<void>;
    readonly onUpdate: (
        job: OpenClawCronJob,
        patch: UpdateOpenClawCronPatch
    ) => Promise<void>;
    readonly runs?: OpenClawCronRunsView;
    readonly runsError?: string;
    readonly runsJobId?: string;
    readonly runsLoading?: boolean;
    readonly runsLoadingMore?: boolean;
    readonly selectedJobId?: string;
    readonly state: OpenClawCronSectionState;
}

type Confirmation = "delete" | "enable" | "run";

function confirmationLabel(confirmation: Confirmation): string {
    if (confirmation === "run") return "Run now";
    if (confirmation === "enable") return "Enable";
    return "Delete";
}

function confirmationDescription(
    confirmation: Confirmation,
    job: OpenClawCronJob
): string {
    if (confirmation === "run") {
        return `Request an immediate Gateway run for ${job.name}? This is not a Dashboard job run.`;
    }
    if (confirmation === "enable") {
        return `Clear the Dashboard disable intent and reconcile ${job.name} to enabled?`;
    }
    return `Delete ${job.name} from the OpenClaw Gateway? Success is reported only after absence readback.`;
}

function confirmationTitle(confirmation: Confirmation): string {
    if (confirmation === "run") return "Run OpenClaw cron job";
    if (confirmation === "enable") return "Enable OpenClaw cron job";
    return "Delete OpenClaw cron job";
}

/**
 * Independently mountable OpenClaw cron vertical for later `/jobs` composition.
 * All data fetching, recent-auth handling, and cache ownership remain with the caller.
 * @returns The OpenClaw cron inventory, detail, history, and control boundaries.
 */
export function OpenClawCronSectionView({
    backgroundError,
    jobsLoadingMore = false,
    onDelete,
    onLoadMoreJobs,
    onLoadMoreRuns,
    onReconcile,
    onRetry,
    onRetryRuns,
    onRun,
    onSelectJob,
    onSetEnabled,
    onUpdate,
    runs,
    runsError,
    runsJobId,
    runsLoading,
    runsLoadingMore,
    selectedJobId,
    state,
}: OpenClawCronSectionProps) {
    const headingId = useId();
    const [selectedId, setSelectedId] = useState<string>();
    const [confirmation, setConfirmation] = useState<Confirmation>();
    const [disableOpen, setDisableOpen] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState<string>();
    const [reconciliation, setReconciliation] = useState<
        "blocked" | "checking" | "ready"
    >("ready");
    const focusInventoryAfterDelete = useRef(false);
    const inventoryHeadingContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!focusInventoryAfterDelete.current) return;
        focusInventoryAfterDelete.current = false;
        inventoryHeadingContainerRef.current?.querySelector("h2")?.focus();
    });

    if (state.status === "loading") {
        return (
            <section aria-labelledby={headingId}>
                <Heading id={headingId} level={2}>
                    OpenClaw cron
                </Heading>
                <PageState label="Loading OpenClaw cron jobs…" status="loading" />
            </section>
        );
    }
    if (state.status === "error") {
        return (
            <section aria-labelledby={headingId}>
                <Heading className="sr-only" id={headingId} level={2}>
                    OpenClaw cron
                </Heading>
                <PageState
                    headingLevel={2}
                    message={state.message}
                    onRetry={onRetry}
                    retryLabel="Retry OpenClaw cron"
                    status="error"
                    title="OpenClaw cron unavailable"
                />
            </section>
        );
    }

    const result = state.result;
    const orderedJobs = orderOpenClawCronJobs(result.jobs);
    const requestedSelectedId = selectedJobId ?? selectedId;
    const selected =
        requestedSelectedId === undefined
            ? orderedJobs.at(0)
            : orderedJobs.find((job) => job.id === requestedSelectedId);

    async function reconcileAuthoritativeState(): Promise<boolean> {
        if (onReconcile !== undefined) {
            return await onReconcile();
        }
        await Promise.resolve(onRetry());
        return false;
    }

    async function execute(
        operation: () => Promise<void>
    ): Promise<"confirmed" | "reconciled"> {
        setActionBusy(true);
        setActionError(undefined);
        try {
            await operation();
            setReconciliation("ready");
            return "confirmed";
        } catch (error) {
            if (!isDashboardOperationOutcomeUnknown(error)) {
                setActionError("The OpenClaw cron action failed. Refresh and try again.");
                throw error;
            }
            setActionError(openClawCronUnknownOutcomeMessage);
            setReconciliation("checking");
            try {
                const reconciled = await reconcileAuthoritativeState();
                if (!reconciled) throw error;
                setActionError(
                    "The OpenClaw cron outcome was uncertain. Authoritative data was refreshed; review the current state before another action."
                );
                setReconciliation("ready");
                return "reconciled";
            } catch {
                setActionError(
                    `${openClawCronUnknownOutcomeMessage} The authoritative refresh failed; refresh successfully before another control.`
                );
                setReconciliation("blocked");
                throw error;
            }
        } finally {
            setActionBusy(false);
        }
    }

    async function retryReconciliation(): Promise<void> {
        setReconciliation("checking");
        setActionError("Refreshing authoritative OpenClaw cron state…");
        try {
            const reconciled = await reconcileAuthoritativeState();
            if (!reconciled) {
                setReconciliation("blocked");
                setActionError(
                    `${openClawCronUnknownOutcomeMessage} The authoritative refresh failed; refresh successfully before another control.`
                );
                return;
            }
            setReconciliation("ready");
            setActionError(
                "Authoritative OpenClaw cron data was refreshed. Review the current state before retrying."
            );
            setConfirmation(undefined);
            setDisableOpen(false);
            setEditorOpen(false);
        } catch {
            setReconciliation("blocked");
            setActionError(
                `${openClawCronUnknownOutcomeMessage} The authoritative refresh failed; refresh successfully before another control.`
            );
        }
    }

    function requiresConfigRevision(job: OpenClawCronJob): string {
        if (job.configRevision !== undefined) return job.configRevision;
        setActionError(
            "The Gateway did not provide a configuration revision. Refresh before changing this definition."
        );
        throw new Error("OpenClaw cron configuration revision is unavailable");
    }

    async function confirmAction(): Promise<void> {
        if (selected === undefined || confirmation === undefined) return;
        const operation = confirmation;
        try {
            const execution = await execute(async () => {
                if (operation === "run") await onRun(selected);
                else if (operation === "enable") {
                    requiresConfigRevision(selected);
                    await onSetEnabled(selected, true);
                } else {
                    requiresConfigRevision(selected);
                    await onDelete(selected);
                }
            });
            if (operation === "delete" && execution === "confirmed") {
                focusInventoryAfterDelete.current = true;
            }
            setConfirmation(undefined);
        } catch (error) {
            if (!isDashboardOperationOutcomeUnknown(error)) {
                setConfirmation(undefined);
            }
        }
    }

    return (
        <section aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div ref={inventoryHeadingContainerRef}>
                    <div className="flex items-center gap-2">
                        <Icon icon={CloudCog} tone="accent" />
                        <Heading id={headingId} level={2} tabIndex={-1}>
                            OpenClaw cron
                        </Heading>
                    </div>
                    <Text className="mt-2 max-w-3xl" tone="muted">
                        Gateway-owned automations and their Gateway run history. These are
                        separate from Dashboard schedules, durable queues, workers, and
                        job runs.
                    </Text>
                    <Text className="mt-1 max-w-3xl" size="sm" tone="muted">
                        Showing {result.jobs.length} of {result.total} Gateway jobs from
                        this bounded browser window.
                    </Text>
                </div>
                <Button
                    busy={reconciliation === "checking"}
                    busyLabel="Refreshing…"
                    onClick={
                        reconciliation === "blocked"
                            ? () => void retryReconciliation()
                            : onRetry
                    }
                    variant="secondary"
                >
                    {reconciliation === "blocked"
                        ? "Refresh authoritative state"
                        : "Refresh OpenClaw"}
                </Button>
            </div>

            <Alert className="mt-5" focusOnError={false} message={backgroundError} />
            {result.freshness.kind === "last-known-good" && (
                <Alert
                    className="mt-5"
                    focusOnError={false}
                    message="Showing last-known-good OpenClaw cron data while the Gateway refresh is unavailable. Controls should be retried only after a fresh preflight."
                    variant="info"
                />
            )}

            {result.jobs.length === 0 ? (
                <div className="mt-6">
                    <PageState
                        description="The authoritative Gateway inventory returned no jobs for this bounded page. Dashboard schedules may still exist above this section."
                        headingLevel={3}
                        icon={CloudCog}
                        status="empty"
                        title="No OpenClaw cron jobs"
                    />
                </div>
            ) : (
                <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,0.9fr)]">
                    <div className="min-w-0">
                        <OpenClawCronTable
                            jobs={orderedJobs}
                            onSelect={(id) => {
                                setSelectedId(id);
                                setActionError(undefined);
                                const next = orderedJobs.find((job) => job.id === id);
                                if (next !== undefined) onSelectJob?.(next);
                            }}
                            selectedId={selected?.id}
                        />
                        {result.hasMore && onLoadMoreJobs !== undefined && (
                            <Button
                                busy={jobsLoadingMore}
                                busyLabel="Loading…"
                                className="mt-4"
                                onClick={onLoadMoreJobs}
                                variant="secondary"
                            >
                                Load more OpenClaw jobs
                            </Button>
                        )}
                        {result.hasMore && onLoadMoreJobs === undefined && (
                            <Text className="mt-3" size="sm" tone="muted">
                                More Gateway jobs exist beyond this bounded browser
                                window.
                            </Text>
                        )}
                    </div>
                    {selected !== undefined && (
                        <OpenClawCronDetail
                            actionBusy={actionBusy || reconciliation !== "ready"}
                            actionError={actionError}
                            definitionControlsAvailable={
                                selected.configRevision !== undefined
                            }
                            job={selected}
                            onDelete={() => {
                                setSelectedId(selected.id);
                                setConfirmation("delete");
                            }}
                            onEdit={() => {
                                setSelectedId(selected.id);
                                setEditorOpen(true);
                            }}
                            onLoadMoreRuns={onLoadMoreRuns}
                            onRetryRuns={onRetryRuns}
                            onRun={() => {
                                setSelectedId(selected.id);
                                setConfirmation("run");
                            }}
                            onSetEnabled={() => {
                                setSelectedId(selected.id);
                                if (selected.enabled) setDisableOpen(true);
                                else setConfirmation("enable");
                            }}
                            runs={
                                runsJobId === undefined || runsJobId === selected.id
                                    ? runs
                                    : undefined
                            }
                            runsError={
                                runsJobId === undefined || runsJobId === selected.id
                                    ? runsError
                                    : undefined
                            }
                            runsLoading={
                                runsJobId !== undefined && runsJobId !== selected.id
                                    ? true
                                    : runsLoading
                            }
                            runsLoadingMore={runsLoadingMore}
                        />
                    )}
                </div>
            )}

            {selected !== undefined && disableOpen && (
                <OpenClawCronDisableDialog
                    job={selected}
                    onClose={() => setDisableOpen(false)}
                    onSubmit={async (draft) => {
                        requiresConfigRevision(selected);
                        await execute(() => onSetEnabled(selected, false, draft));
                    }}
                    onReconcile={() => retryReconciliation()}
                    reconciliationBlocked={reconciliation === "blocked"}
                    reconciliationBusy={reconciliation === "checking"}
                    reconciliationError={
                        reconciliation === "blocked" ? actionError : undefined
                    }
                />
            )}
            {selected !== undefined && editorOpen && (
                <OpenClawCronDefinitionDialog
                    job={selected}
                    onClose={() => setEditorOpen(false)}
                    onSubmit={async (patch) => {
                        requiresConfigRevision(selected);
                        await execute(() => onUpdate(selected, patch));
                    }}
                    onReconcile={() => retryReconciliation()}
                    reconciliationBlocked={reconciliation === "blocked"}
                    reconciliationBusy={reconciliation === "checking"}
                    reconciliationError={
                        reconciliation === "blocked" ? actionError : undefined
                    }
                />
            )}
            {selected !== undefined && confirmation !== undefined && (
                <ConfirmModal
                    busy={actionBusy}
                    confirmLabel={confirmationLabel(confirmation)}
                    danger={confirmation === "delete"}
                    description={confirmationDescription(confirmation, selected)}
                    error={reconciliation === "blocked" ? actionError : undefined}
                    confirmDisabled={reconciliation !== "ready"}
                    onCancel={() => setConfirmation(undefined)}
                    onConfirm={() => void confirmAction()}
                    onRetry={
                        reconciliation === "blocked"
                            ? () => void retryReconciliation()
                            : undefined
                    }
                    open
                    retryBusy={reconciliation === "checking"}
                    retryLabel="Refresh authoritative state"
                    title={confirmationTitle(confirmation)}
                />
            )}
        </section>
    );
}

/**
 * Mounts the OpenClaw cron realtime invalidation exactly once around its pure view.
 * @returns The realtime-connected OpenClaw cron section.
 */
export function OpenClawCronSection(props: OpenClawCronSectionProps) {
    useOpenClawCronRealtimeInvalidation();
    return <OpenClawCronSectionView {...props} />;
}
