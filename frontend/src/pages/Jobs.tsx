import { RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { CronJob } from "../../../contracts/cron";
import type {
    JobDisableIntent,
    ScheduledJob,
    ScheduledJobPatch,
} from "../../../contracts/jobs";
import { CronJobList } from "../components/features/cron/CronJobList";
import { CronJobEditor } from "../components/features/jobs/CronJobEditor";
import { JobExecutionQueueCard } from "../components/features/jobs/JobExecutionQueueCard";
import {
    type DisableCandidate,
    type DisableMode,
    disableModeOptions,
    getInitialCronJobId,
    getInitialJobsView,
    type JobsView,
    sortScheduledJobs,
} from "../components/features/jobs/jobPanelModel";
import { ScheduledJobEditor } from "../components/features/jobs/ScheduledJobEditor";
import { ScheduledJobList } from "../components/features/jobs/ScheduledJobList";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import {
    DateTimePicker,
    type DateTimePickerValue,
} from "../components/ui/DateTimePicker";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import {
    useCronJobs,
    useDeleteCronJob,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "../hooks/useCron";
import {
    useRunScheduledJobNow,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "../hooks/useScheduledJobs";
import { messageFromError } from "../lib/errorMessage";
import { getCronJobId, sortCronJobs } from "../utils/cronUtilities";
import {
    defaultDisableUntilDraft,
    parseDisableUntilDraft,
    toDisableUntilDraft,
} from "./jobPageUtilities";

export function Jobs() {
    const {
        data: scheduledJobsData,
        isLoading: scheduledLoading,
        error: scheduledError,
        refetch: refetchScheduledJobs,
    } = useScheduledJobs();
    const {
        data: cronJobsData,
        isLoading: cronLoading,
        error: cronError,
        refetch: refetchCronJobs,
    } = useCronJobs();
    const updateScheduledJob = useUpdateScheduledJob();
    const runScheduledJob = useRunScheduledJobNow();
    const toggleCronJob = useToggleCronJob();
    const runCronNow = useRunCronJobNow();
    const updateCronJob = useUpdateCronJob();
    const deleteCronJob = useDeleteCronJob();

    const scheduledJobs = scheduledJobsData ?? [];
    const cronJobs = cronJobsData ?? [];
    const sortedScheduledJobs = sortScheduledJobs(scheduledJobs);
    const sortedCronJobs = sortCronJobs(cronJobs);
    const [view, setView] = useState<JobsView>(getInitialJobsView);
    const [selectedScheduledJobId, setSelectedScheduledJobId] = useState("");
    const [selectedCronJobId, setSelectedCronJobId] = useState(getInitialCronJobId);
    const [lastCronRunAt, setLastCronRunAt] = useState<Record<string, number>>({});
    const [deleteCandidate, setDeleteCandidate] = useState<CronJob | undefined>();
    const [disableCandidate, setDisableCandidate] = useState<
        DisableCandidate | undefined
    >();
    const [disableMode, setDisableMode] = useState<DisableMode>("until");
    const [disableComment, setDisableComment] = useState("");
    const [disableUntil, setDisableUntil] = useState<DateTimePickerValue>(() =>
        defaultDisableUntilDraft()
    );
    const [disableCommentError, setDisableCommentError] = useState<string | undefined>();
    const [disableUntilError, setDisableUntilError] = useState<string | undefined>();
    const [actionError, setActionError] = useState<string | undefined>();

    const selectedScheduledJob =
        sortedScheduledJobs.find((job) => job.id === selectedScheduledJobId) || undefined;
    const currentScheduledJob =
        selectedScheduledJob || sortedScheduledJobs[0] || undefined;
    const currentScheduledJobId = currentScheduledJob?.id || "";
    const selectedCronJob =
        sortedCronJobs.find((job) => getCronJobId(job) === selectedCronJobId) ||
        undefined;
    const selectedCronId = selectedCronJob ? getCronJobId(selectedCronJob) : "";
    const currentCronJob = selectedCronJob || sortedCronJobs[0] || undefined;
    const currentCronJobId = currentCronJob ? getCronJobId(currentCronJob) : "";
    const isDisablePending =
        disableCandidate?.kind === "scheduled"
            ? updateScheduledJob.isPending
            : toggleCronJob.isPending;

    async function persistScheduledToggle(
        job: ScheduledJob,
        isEnabled: boolean,
        disableIntent?: JobDisableIntent
    ) {
        try {
            await updateScheduledJob.mutateAsync({
                id: job.id,
                patch: { enabled: isEnabled, disableIntent },
            });
            setActionError(undefined);
            setDisableCandidate(undefined);
        } catch (error) {
            setActionError(
                messageFromError(error, "Failed to update scheduled job state")
            );
        }
    }

    function handleScheduledToggle(job: ScheduledJob, isEnabled: boolean) {
        if (!isEnabled) {
            openDisableModal({ kind: "scheduled", job });
            return;
        }
        void persistScheduledToggle(job, true);
    }

    async function handleScheduledRun(job: ScheduledJob) {
        try {
            await runScheduledJob.mutateAsync({ id: job.id });
            setActionError(undefined);
        } catch (error) {
            setActionError(messageFromError(error, "Failed to run scheduled job"));
        }
    }

    async function persistScheduledEdit(
        job: ScheduledJob,
        patch: ScheduledJobPatch
    ): Promise<void> {
        await updateScheduledJob.mutateAsync({ id: job.id, patch });
        setActionError(undefined);
    }

    function openDisableModal(candidate: DisableCandidate) {
        const existingIntent = candidate.job.disableIntent;
        setDisableCandidate(candidate);
        setDisableMode(existingIntent?.mode ?? "until");
        setDisableComment(existingIntent?.comment ?? "");
        let untilTimestamp: number | undefined;
        if (existingIntent?.mode === "until" && existingIntent.until) {
            const parsedUntilTimestamp = Date.parse(existingIntent.until);
            if (Number.isFinite(parsedUntilTimestamp)) {
                untilTimestamp = parsedUntilTimestamp;
            }
        }
        setDisableUntil(
            untilTimestamp === undefined
                ? defaultDisableUntilDraft()
                : toDisableUntilDraft(untilTimestamp)
        );
        setDisableCommentError(undefined);
        setDisableUntilError(undefined);
    }

    async function persistCronToggle(
        job: CronJob,
        isEnabled: boolean,
        disableIntent?: JobDisableIntent
    ) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await toggleCronJob.mutateAsync({
                id,
                enabled: isEnabled,
                disableIntent,
            });
            setActionError(undefined);
            setDisableCandidate(undefined);
        } catch (error) {
            setActionError(messageFromError(error, "Failed to update cron job state"));
        }
    }

    function handleCronToggle(job: CronJob, isEnabled: boolean) {
        if (!isEnabled) {
            openDisableModal({ kind: "cron", job });
            return;
        }
        void persistCronToggle(job, isEnabled);
    }

    async function handleIntentionalDisable() {
        if (!disableCandidate) return;
        setDisableCommentError(undefined);
        setDisableUntilError(undefined);
        const comment = disableComment.trim();
        if (!comment) {
            setDisableCommentError("A comment is required for an intentional disable.");
            return;
        }
        let disableIntent: JobDisableIntent;
        if (disableMode === "indefinite") {
            disableIntent = {
                mode: "indefinite",
                comment,
            };
        } else {
            const untilTimestamp = parseDisableUntilDraft(disableUntil);
            if (untilTimestamp === undefined || untilTimestamp <= Date.now()) {
                setDisableUntilError("Choose a future date and time.");
                return;
            }
            disableIntent = {
                mode: "until",
                comment,
                until: new Date(untilTimestamp).toISOString(),
            };
        }
        await (disableCandidate.kind === "scheduled"
            ? persistScheduledToggle(disableCandidate.job, false, disableIntent)
            : persistCronToggle(disableCandidate.job, false, disableIntent));
    }

    async function handleCronRunNow(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await runCronNow.mutateAsync({ id });
            setLastCronRunAt((wasPrevious) => ({ ...wasPrevious, [id]: Date.now() }));
            setActionError(undefined);
        } catch (error) {
            setActionError(messageFromError(error, "Failed to run cron job"));
        }
    }

    async function persistCronEdit(
        job: CronJob,
        patch: Record<string, unknown>
    ): Promise<void> {
        const id = getCronJobId(job);
        if (!id) return;
        await updateCronJob.mutateAsync({ id, patch });
        setActionError(undefined);
    }

    async function handleCronDelete(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) {
            setDeleteCandidate(undefined);
            return;
        }
        try {
            await deleteCronJob.mutateAsync({ id });
            setSelectedCronJobId("");
            setDeleteCandidate(undefined);
            setActionError(undefined);
        } catch (error) {
            setActionError(messageFromError(error, "Failed to delete cron job"));
        }
    }

    const isLoading = view === "scheduled" ? scheduledLoading : cronLoading;
    const error = view === "scheduled" ? scheduledError : cronError;
    const hasLoadedJobs =
        (view === "scheduled" ? scheduledJobsData : cronJobsData) !== undefined;
    const activeViewLabel = view === "scheduled" ? "Dashboard jobs" : "OpenClaw cron";
    const isEmpty =
        (view === "scheduled" && sortedScheduledJobs.length === 0) ||
        (view === "openclaw" && sortedCronJobs.length === 0);
    const retryActiveView = () => {
        if (view === "scheduled") {
            void refetchScheduledJobs();
            return;
        }
        void refetchCronJobs();
    };
    let jobsContent: ReactNode;
    if (isLoading) {
        jobsContent = (
            <div className="flex min-h-80 items-center justify-center">
                <LoadingState size="lg" />
            </div>
        );
    } else if (error && !hasLoadedJobs) {
        jobsContent = (
            <div className="flex min-h-80 flex-col items-center justify-center gap-4">
                <p className="text-red-400">
                    {messageFromError(error, `Failed to load ${activeViewLabel}`)}
                </p>
                <Button variant="secondary" onClick={retryActiveView}>
                    <RotateCw className="size-4" />
                    Retry
                </Button>
            </div>
        );
    } else if (isEmpty) {
        const emptyMessage =
            view === "scheduled"
                ? "Dashboard scheduled jobs will appear here."
                : "OpenClaw cron jobs will appear here.";
        jobsContent = (
            <Card variant="bordered">
                <CardTitle>No jobs found</CardTitle>
                <p className="mt-2 text-sm text-primary-300">{emptyMessage}</p>
            </Card>
        );
    } else if (view === "scheduled") {
        jobsContent = (
            <div className="space-y-3 sm:space-y-4">
                <JobExecutionQueueCard />
                <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[380px_1fr]">
                    <ScheduledJobList
                        jobs={sortedScheduledJobs}
                        selectedId={selectedScheduledJobId}
                        currentJobId={currentScheduledJobId}
                        onSelect={setSelectedScheduledJobId}
                    />
                    <ScheduledJobEditor
                        key={currentScheduledJobId}
                        job={currentScheduledJob as ScheduledJob}
                        runPending={runScheduledJob.isPending}
                        updatePending={updateScheduledJob.isPending}
                        onToggle={(isEnabled) => {
                            handleScheduledToggle(
                                currentScheduledJob as ScheduledJob,
                                isEnabled
                            );
                        }}
                        onConfigureDisable={() =>
                            openDisableModal({
                                kind: "scheduled",
                                job: currentScheduledJob as ScheduledJob,
                            })
                        }
                        onRunNow={() => {
                            void handleScheduledRun(currentScheduledJob as ScheduledJob);
                        }}
                        onSave={persistScheduledEdit}
                    />
                </div>
            </div>
        );
    } else {
        jobsContent = (
            <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[360px_1fr]">
                <CronJobList
                    jobs={sortedCronJobs}
                    selectedId={selectedCronId}
                    currentJobId={currentCronJobId}
                    onSelect={setSelectedCronJobId}
                />
                <CronJobEditor
                    key={currentCronJobId}
                    job={currentCronJob as CronJob}
                    lastTriggeredAt={lastCronRunAt[currentCronJobId]}
                    togglePending={toggleCronJob.isPending}
                    runPending={runCronNow.isPending}
                    updatePending={updateCronJob.isPending}
                    deletePending={deleteCronJob.isPending}
                    onToggle={(job, enabled) => {
                        handleCronToggle(job, enabled);
                    }}
                    onConfigureDisable={(job) => openDisableModal({ kind: "cron", job })}
                    onRunNow={(job) => {
                        void handleCronRunNow(job);
                    }}
                    onSave={persistCronEdit}
                    onDelete={setDeleteCandidate}
                />
            </div>
        );
    }

    let disableActionLabel = "Disable job";
    if (isDisablePending) {
        disableActionLabel = "Saving...";
    } else if (disableCandidate?.job.enabled === false) {
        disableActionLabel = "Save disabled state";
    }
    const linkedTaskCount =
        disableCandidate?.kind === "cron"
            ? (disableCandidate.job.taskLinks?.length ?? 0)
            : 0;
    const linkedTaskSuffix = linkedTaskCount === 1 ? "" : "s";
    const linkedTaskNotice =
        linkedTaskCount > 0
            ? ` It is linked to ${linkedTaskCount} open task${linkedTaskSuffix}.`
            : "";

    return (
        <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
            {actionError ? (
                <Card variant="bordered" className="border-red-500/40 bg-red-500/10 p-3">
                    <p className="text-sm text-red-300">{actionError}</p>
                </Card>
            ) : undefined}

            {error && hasLoadedJobs ? (
                <Alert variant="warning">
                    {activeViewLabel} refresh failed. Showing the last loaded jobs.{" "}
                    {messageFromError(error, `${activeViewLabel} refresh failed`)}
                </Alert>
            ) : undefined}

            <Card variant="bordered" className="p-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                        type="button"
                        variant={view === "scheduled" ? "primary" : "ghost"}
                        aria-pressed={view === "scheduled"}
                        onClick={() => setView("scheduled")}
                        className="justify-center"
                    >
                        Dashboard jobs ({sortedScheduledJobs.length})
                    </Button>
                    <Button
                        type="button"
                        variant={view === "openclaw" ? "primary" : "ghost"}
                        aria-pressed={view === "openclaw"}
                        onClick={() => setView("openclaw")}
                        className="justify-center"
                    >
                        OpenClaw cron ({sortedCronJobs.length})
                    </Button>
                </div>
            </Card>

            {jobsContent}

            {deleteCandidate ? (
                <ConfirmModal
                    isOpen
                    title="Delete cron job"
                    message={`Delete ${deleteCandidate.name || getCronJobId(deleteCandidate)}?`}
                    confirmLabel="Delete cron job"
                    confirmLoadingLabel="Deleting"
                    loading={deleteCronJob.isPending}
                    danger
                    onCancel={() => setDeleteCandidate(undefined)}
                    onConfirm={() => {
                        void handleCronDelete(deleteCandidate);
                    }}
                />
            ) : undefined}

            {disableCandidate ? (
                <Modal
                    isOpen
                    title={
                        disableCandidate.job.enabled === false
                            ? "Edit disabled state"
                            : "Disable job"
                    }
                    onClose={() => {
                        if (!isDisablePending) setDisableCandidate(undefined);
                    }}
                >
                    <div className="space-y-4">
                        <p className="text-sm text-primary-300">
                            Heartbeat will treat this{" "}
                            {disableCandidate.kind === "scheduled"
                                ? "Dashboard job"
                                : "OpenClaw cron job"}{" "}
                            as intentionally disabled while this annotation is active.
                            {linkedTaskNotice}
                        </p>
                        <Select
                            ariaLabel="Disabled duration"
                            value={disableMode}
                            options={disableModeOptions}
                            onChange={(value) => setDisableMode(value as DisableMode)}
                            width="w-full"
                        />
                        {disableMode === "until" ? (
                            <DateTimePicker
                                label="Disabled until"
                                value={disableUntil}
                                error={disableUntilError}
                                onChange={setDisableUntil}
                            />
                        ) : undefined}
                        <Textarea
                            label="Comment"
                            description="Required. Explain why the job is disabled and what should happen before it is enabled again."
                            value={disableComment}
                            onChange={(event) => setDisableComment(event.target.value)}
                            maxLength={1000}
                            rows={4}
                            error={disableCommentError}
                        />
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="secondary"
                                disabled={isDisablePending}
                                onClick={() => setDisableCandidate(undefined)}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                disabled={isDisablePending}
                                onClick={() => {
                                    void handleIntentionalDisable();
                                }}
                            >
                                {disableActionLabel}
                            </Button>
                        </div>
                    </div>
                </Modal>
            ) : undefined}
        </div>
    );
}
