import { CloudCog } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { GatewaySession } from "../../contracts/gatewaySessions.ts";
import type {
    OpenClawCronJob,
    UpdateOpenClawCronPatch,
} from "../../contracts/openClawCron.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OpenClawCronConfirmationDialog } from "./OpenClawCronConfirmationDialog.tsx";
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
    readonly jobsPaginationError?: string;
    readonly heartbeatSession?: GatewaySession;
    readonly heartbeatSessionStatus?: "loading" | "ready" | "unavailable";
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
        return `Run ${job.name} in OpenClaw now? This is separate from Dashboard background jobs.`;
    }
    if (confirmation === "enable") {
        return `Enable ${job.name} in OpenClaw now?`;
    }
    return `Delete ${job.name} from OpenClaw? Dashboard will confirm that it was removed before reporting success.`;
}

function confirmationTitle(confirmation: Confirmation): string {
    if (confirmation === "run") return "Run OpenClaw scheduled job";
    if (confirmation === "enable") return "Enable OpenClaw scheduled job";
    return "Delete OpenClaw scheduled job";
}

/**
 * Independently mountable OpenClaw cron vertical for later `/jobs` composition.
 * All data fetching, recent-auth handling, and cache ownership remain with the caller.
 * @returns The OpenClaw cron inventory, detail, history, and control boundaries.
 */
export function OpenClawCronSectionView({
    backgroundError,
    jobsLoadingMore = false,
    jobsPaginationError,
    heartbeatSession,
    heartbeatSessionStatus,
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
            <section aria-labelledby={headingId} className="max-w-full min-w-0">
                <Heading id={headingId} level={2}>
                    OpenClaw scheduled jobs
                </Heading>
                <PageState label="Loading OpenClaw scheduled jobs…" status="loading" />
            </section>
        );
    }
    if (state.status === "error") {
        return (
            <section aria-labelledby={headingId} className="max-w-full min-w-0">
                <Heading className="sr-only" id={headingId} level={2}>
                    OpenClaw scheduled jobs
                </Heading>
                <PageState
                    headingLevel={2}
                    message={state.message}
                    onRetry={onRetry}
                    retryLabel="Try again"
                    status="error"
                    title="OpenClaw scheduled jobs unavailable"
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
                setActionError("The OpenClaw action failed. Refresh and try again.");
                throw error;
            }
            setActionError(openClawCronUnknownOutcomeMessage);
            setReconciliation("checking");
            try {
                const reconciled = await reconcileAuthoritativeState();
                if (!reconciled) throw error;
                setActionError(
                    "Dashboard could not confirm the result, so it refreshed the current OpenClaw status. Check the status before taking another action."
                );
                setReconciliation("ready");
                return "reconciled";
            } catch {
                setActionError(
                    `${openClawCronUnknownOutcomeMessage} The refresh also failed, so actions remain unavailable.`
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
        setActionError("Refreshing the current OpenClaw status…");
        try {
            const reconciled = await reconcileAuthoritativeState();
            if (!reconciled) {
                setReconciliation("blocked");
                setActionError(
                    `${openClawCronUnknownOutcomeMessage} The refresh also failed, so actions remain unavailable.`
                );
                return;
            }
            setReconciliation("ready");
            setActionError(
                "The current OpenClaw status was refreshed. Check it before trying again."
            );
            setConfirmation(undefined);
            setDisableOpen(false);
            setEditorOpen(false);
        } catch {
            setReconciliation("blocked");
            setActionError(
                `${openClawCronUnknownOutcomeMessage} The refresh also failed, so actions remain unavailable.`
            );
        }
    }

    function requiresConfigRevision(job: OpenClawCronJob): string {
        if (job.configRevision !== undefined) return job.configRevision;
        setActionError(
            "OpenClaw did not provide the version needed to change this job. Refresh and try again."
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
        <section aria-labelledby={headingId} className="max-w-full min-w-0">
            <div ref={inventoryHeadingContainerRef}>
                <Heading className="sr-only" id={headingId} level={2} tabIndex={-1}>
                    OpenClaw scheduled jobs
                </Heading>
            </div>
            {reconciliation === "blocked" && (
                <div className="flex justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        onClick={() => void retryReconciliation()}
                        variant="secondary"
                    >
                        Refresh current status
                    </Button>
                </div>
            )}

            <Alert className="my-4" focusOnError={false} message={backgroundError} />
            {result.freshness.kind === "last-known-good" && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message="The latest refresh failed, so the last available OpenClaw data is shown. Refresh successfully before trying an action."
                    variant="warning"
                />
            )}

            {result.jobs.length === 0 ? (
                <div className="mt-4">
                    <PageState
                        description="OpenClaw returned no scheduled jobs. Dashboard schedules may still exist above this section."
                        headingLevel={3}
                        icon={CloudCog}
                        status="empty"
                        title="No OpenClaw scheduled jobs"
                    />
                </div>
            ) : (
                <div className="grid max-w-full min-w-0 grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                    <div className="border-primary-700 bg-primary-800/80 flex min-w-0 flex-col rounded-xl border p-2 xl:max-h-[calc(100vh-10rem)]">
                        <div className="border-primary-700 flex items-center gap-2 border-b p-2">
                            <Icon icon={CloudCog} tone="accent" />
                            <Heading level={3} size="subsection">
                                Schedules
                            </Heading>
                        </div>
                        <div className="min-h-0 flex-1 pt-2">
                            <OpenClawCronTable
                                jobs={orderedJobs}
                                onSelect={(id) => {
                                    setSelectedId(id);
                                    setActionError(undefined);
                                    const next = orderedJobs.find((job) => job.id === id);
                                    if (next !== undefined) onSelectJob?.(next);
                                }}
                                pagination={
                                    onLoadMoreJobs === undefined
                                        ? undefined
                                        : {
                                              ...(jobsPaginationError === undefined
                                                  ? {}
                                                  : { error: jobsPaginationError }),
                                              hasMore: result.hasMore,
                                              loading: jobsLoadingMore,
                                              loadingLabel: "Loading more OpenClaw jobs…",
                                              onLoadMore: onLoadMoreJobs,
                                          }
                                }
                                selectedId={selected?.id}
                            />
                        </div>
                    </div>
                    {selected !== undefined && (
                        <OpenClawCronDetail
                            actionBusy={actionBusy || reconciliation !== "ready"}
                            actionError={actionError}
                            definitionControlsAvailable={
                                result.freshness.kind === "fresh" &&
                                selected.configRevision !== undefined
                            }
                            job={selected}
                            heartbeatSession={heartbeatSession}
                            heartbeatSessionStatus={heartbeatSessionStatus}
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
                <OpenClawCronConfirmationDialog
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
                    retryBusy={reconciliation === "checking"}
                    retryLabel="Refresh current status"
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
