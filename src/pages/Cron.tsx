import { Play, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { CronJobDetails, CronJobList } from "../components/features/cron";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import type { CronJob, ScheduledJob, ScheduledJobPatch } from "../hooks";
import {
    useCronJobs,
    useDeleteCronJob,
    useRunCronJobNow,
    useRunScheduledJobNow,
    useScheduledJobRuns,
    useScheduledJobs,
    useToggleCronJob,
    useUpdateCronJob,
    useUpdateScheduledJob,
} from "../hooks";
import { getCronJobId, sortCronJobs } from "../utils/cronUtils";
import { formatDate } from "../utils/format";
import { validateJsonString } from "../utils/json";

type JobsView = "scheduled" | "openclaw";

const scheduleTypeOptions = [
    { value: "interval", label: "Interval", description: "Run every N seconds" },
    { value: "daily", label: "Daily", description: "Run once per day" },
    { value: "cron", label: "Cron", description: "Use a five-field cron expression" },
];

function formatScheduledJobSchedule(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.scheduleType === "daily") return `Daily at ${job.timeOfDay || "--:--"}`;
    if (job.scheduleType === "cron") return job.cronExpression || "Cron schedule";
    const minutes = Math.round(job.intervalSeconds / 60);
    if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60}h`;
    return `Every ${minutes}m`;
}

function scheduledJobStatusVariant(job: ScheduledJob) {
    if (!job.enabled) return "warning" as const;
    if (job.isRunning || job.lastRun?.status === "running") return "info" as const;
    if (job.lastRun?.status === "failed") return "error" as const;
    if (job.lastRun?.status === "success") return "success" as const;
    return "default" as const;
}

function scheduledJobStatusLabel(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.isRunning || job.lastRun?.status === "running") return "Running";
    return job.lastRun?.status || "Never run";
}

function sortScheduledJobs(jobs: ScheduledJob[]): ScheduledJob[] {
    return [...jobs].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
}

function parsePositiveInteger(value: string): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatRunOutput(output: Record<string, unknown>): string {
    return JSON.stringify(output, null, 2);
}

interface ScheduledJobListProps {
    jobs: ScheduledJob[];
    selectedId: string;
    currentJobId: string;
    onSelect: (id: string) => void;
}

function ScheduledJobList({
    jobs,
    selectedId,
    currentJobId,
    onSelect,
}: ScheduledJobListProps) {
    return (
        <Card variant="bordered" className="min-w-0 p-0">
            <div className="border-primary-700 text-primary-200 border-b px-3 py-2 text-sm font-semibold sm:px-4 sm:py-3">
                Dashboard jobs
            </div>
            <div className="max-h-80 overflow-auto p-2 xl:max-h-[70vh]">
                {jobs.map((job) => {
                    const isSelected =
                        job.id === selectedId || (!selectedId && job.id === currentJobId);
                    return (
                        <Button
                            key={job.id}
                            type="button"
                            variant="ghost"
                            onClick={() => onSelect(job.id)}
                            className={[
                                "mb-2 w-full min-w-0 flex-col items-stretch justify-start rounded-lg border px-3 py-2 text-left transition",
                                isSelected
                                    ? "border-accent-500 bg-accent-500/10"
                                    : "border-primary-700 bg-primary-800/40 hover:border-primary-500",
                            ].join(" ")}
                        >
                            <div className="flex w-full min-w-0 items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-primary-100 truncate text-sm font-medium">
                                        {job.name}
                                    </div>
                                    <div className="text-primary-400 mt-1 truncate text-xs">
                                        {job.id}
                                    </div>
                                </div>
                                <Badge
                                    className="shrink-0 whitespace-nowrap"
                                    variant={scheduledJobStatusVariant(job)}
                                >
                                    {scheduledJobStatusLabel(job)}
                                </Badge>
                            </div>
                            <div className="text-primary-400 mt-2 grid w-full grid-cols-1 gap-x-2 gap-y-1 text-[11px] sm:grid-cols-2">
                                <span>Schedule: {formatScheduledJobSchedule(job)}</span>
                                <span>
                                    Next:{" "}
                                    {job.nextRunAt
                                        ? formatDate(job.nextRunAt)
                                        : "Not scheduled"}
                                </span>
                            </div>
                        </Button>
                    );
                })}
            </div>
        </Card>
    );
}

interface ScheduledJobDetailsProps {
    job: ScheduledJob;
    scheduleTypeDraft: ScheduledJob["scheduleType"];
    intervalDraft: string;
    timeDraft: string;
    cronDraft: string;
    editError: string | null;
    runPending: boolean;
    updatePending: boolean;
    onScheduleTypeChange: (value: ScheduledJob["scheduleType"]) => void;
    onIntervalChange: (value: string) => void;
    onTimeChange: (value: string) => void;
    onCronChange: (value: string) => void;
    onToggle: (enabled: boolean) => void;
    onRunNow: () => void;
    onSave: () => void;
}

function ScheduledJobDetails({
    job,
    scheduleTypeDraft,
    intervalDraft,
    timeDraft,
    cronDraft,
    editError,
    runPending,
    updatePending,
    onScheduleTypeChange,
    onIntervalChange,
    onTimeChange,
    onCronChange,
    onToggle,
    onRunNow,
    onSave,
}: ScheduledJobDetailsProps) {
    const runs = useScheduledJobRuns(job.id);
    const intervalInvalid =
        scheduleTypeDraft === "interval" && !parsePositiveInteger(intervalDraft);
    const dailyInvalid =
        scheduleTypeDraft === "daily" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeDraft);
    const cronInvalid = scheduleTypeDraft === "cron" && cronDraft.trim().length === 0;
    const saveDisabled =
        updatePending || intervalInvalid || dailyInvalid || cronInvalid || runPending;

    return (
        <Card variant="bordered" className="min-w-0 space-y-3 p-3 sm:space-y-4 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <CardTitle className="text-base">{job.name}</CardTitle>
                    <p className="text-primary-400 mt-1 text-xs break-all">{job.id}</p>
                    {job.description ? (
                        <p className="text-primary-300 mt-2 text-sm">{job.description}</p>
                    ) : null}
                </div>
                <Badge
                    className="shrink-0 whitespace-nowrap"
                    variant={scheduledJobStatusVariant(job)}
                >
                    {scheduledJobStatusLabel(job)}
                </Badge>
            </div>

            <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
                    Controls
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Switch
                        checked={job.enabled}
                        onChange={onToggle}
                        label="Enabled"
                        disabled={updatePending}
                        className="border-primary-700 bg-primary-800/60 rounded-lg border px-3 py-2 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0"
                    />
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={runPending || job.isRunning}
                        onClick={onRunNow}
                        className="w-full sm:w-auto"
                    >
                        <Play
                            className={[
                                "h-4 w-4",
                                runPending ? "animate-pulse" : "",
                            ].join(" ")}
                        />
                        {runPending || job.isRunning ? "Running..." : "Run now"}
                    </Button>
                </div>
            </div>

            <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                <div className="text-primary-300 mb-3 text-xs font-semibold tracking-wide uppercase">
                    Schedule
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(12rem,16rem)_1fr_auto] lg:items-end">
                    <div>
                        <label className="text-primary-300 mb-1 block text-xs">
                            Type
                        </label>
                        <Select
                            value={scheduleTypeDraft}
                            options={scheduleTypeOptions}
                            onChange={(value) =>
                                onScheduleTypeChange(
                                    value as ScheduledJob["scheduleType"]
                                )
                            }
                            width="w-full"
                            ariaLabel="Schedule type"
                        />
                    </div>
                    {scheduleTypeDraft === "interval" ? (
                        <div>
                            <label className="text-primary-300 mb-1 block text-xs">
                                Interval seconds
                            </label>
                            <Input
                                aria-label="Interval seconds"
                                inputMode="numeric"
                                value={intervalDraft}
                                onChange={(event) => onIntervalChange(event.target.value)}
                            />
                        </div>
                    ) : null}
                    {scheduleTypeDraft === "daily" ? (
                        <div>
                            <label className="text-primary-300 mb-1 block text-xs">
                                Time of day
                            </label>
                            <Input
                                aria-label="Time of day"
                                type="time"
                                value={timeDraft}
                                onChange={(event) => onTimeChange(event.target.value)}
                            />
                        </div>
                    ) : null}
                    {scheduleTypeDraft === "cron" ? (
                        <div>
                            <label className="text-primary-300 mb-1 block text-xs">
                                Cron expression
                            </label>
                            <Input
                                aria-label="Cron expression"
                                value={cronDraft}
                                onChange={(event) => onCronChange(event.target.value)}
                                placeholder="0 4 * * *"
                            />
                        </div>
                    ) : null}
                    <Button
                        size="sm"
                        disabled={saveDisabled}
                        onClick={onSave}
                        className="w-full lg:w-auto"
                    >
                        <Save className="h-4 w-4" />
                        {updatePending ? "Saving..." : "Save schedule"}
                    </Button>
                </div>
                {intervalInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Interval must be a positive number of seconds.
                    </p>
                ) : null}
                {dailyInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Daily schedules require HH:MM.
                    </p>
                ) : null}
                {cronInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Cron schedules require an expression.
                    </p>
                ) : null}
                {editError ? (
                    <p className="mt-2 text-xs text-red-400">{editError}</p>
                ) : null}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Card className="bg-primary-900/40 min-w-0 p-3">
                    <div className="text-primary-400 text-xs">Action</div>
                    <div className="text-primary-100 mt-1 text-sm break-all">
                        {job.actionKey}
                    </div>
                </Card>
                <Card className="bg-primary-900/40 min-w-0 p-3">
                    <div className="text-primary-400 text-xs">Next run</div>
                    <div className="text-primary-100 mt-1 text-sm">
                        {job.nextRunAt ? formatDate(job.nextRunAt) : "Not scheduled"}
                    </div>
                </Card>
                <Card className="bg-primary-900/40 min-w-0 p-3">
                    <div className="text-primary-400 text-xs">Last run</div>
                    <div className="text-primary-100 mt-1 text-sm">
                        {job.lastRun ? formatDate(job.lastRun.startedAt) : "Never"}
                    </div>
                </Card>
                <Card className="bg-primary-900/40 min-w-0 p-3">
                    <div className="text-primary-400 text-xs">Updated</div>
                    <div className="text-primary-100 mt-1 text-sm">
                        {formatDate(job.updatedAt)}
                    </div>
                </Card>
            </div>

            <Card className="bg-primary-900/40 min-w-0 p-3 sm:p-4">
                <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
                    Run logs
                </div>
                {runs.isLoading ? (
                    <div className="text-primary-400 text-sm">Loading runs...</div>
                ) : runs.data && runs.data.length > 0 ? (
                    <div className="space-y-3">
                        {runs.data.map((run) => (
                            <div
                                key={run.id}
                                className="border-primary-700 rounded-lg border p-3"
                            >
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="text-primary-100 text-sm font-medium">
                                            {run.triggerType} run #{run.id}
                                        </div>
                                        <div className="text-primary-400 mt-1 text-xs">
                                            Started {formatDate(run.startedAt)}
                                            {run.finishedAt
                                                ? ` · finished ${formatDate(run.finishedAt)}`
                                                : ""}
                                        </div>
                                        {run.message ? (
                                            <div className="mt-1 text-xs text-red-300">
                                                {run.message}
                                            </div>
                                        ) : null}
                                    </div>
                                    <Badge
                                        className="shrink-0 whitespace-nowrap"
                                        variant={
                                            run.status === "success"
                                                ? "success"
                                                : run.status === "failed"
                                                  ? "error"
                                                  : "info"
                                        }
                                    >
                                        {run.status}
                                    </Badge>
                                </div>
                                <pre className="text-primary-200 mt-2 max-h-48 overflow-auto rounded bg-black/30 p-2 text-xs whitespace-pre-wrap">
                                    {formatRunOutput(run.output)}
                                </pre>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-primary-400 text-sm">No run logs yet.</div>
                )}
            </Card>
        </Card>
    );
}

/** Renders the jobs UI. */
export function Cron() {
    const {
        data: scheduledJobs = [],
        isLoading: scheduledLoading,
        error: scheduledError,
        refetch: refetchScheduledJobs,
    } = useScheduledJobs();
    const {
        data: cronJobs = [],
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

    const sortedScheduledJobs = sortScheduledJobs(scheduledJobs);
    const sortedCronJobs = sortCronJobs(cronJobs);
    const [view, setView] = useState<JobsView>("scheduled");
    const [selectedScheduledJobId, setSelectedScheduledJobId] = useState("");
    const [selectedCronJobId, setSelectedCronJobId] = useState("");
    const [lastCronRunAt, setLastCronRunAt] = useState<Record<string, number>>({});
    const [cronNameDraft, setCronNameDraft] = useState("");
    const [cronScheduleDraft, setCronScheduleDraft] = useState("{}");
    const [cronPayloadDraft, setCronPayloadDraft] = useState("{}");
    const [cronDeliveryDraft, setCronDeliveryDraft] = useState("{}");
    const [cronEditError, setCronEditError] = useState<string | null>(null);
    const [isCronEditMode, setIsCronEditMode] = useState(false);
    const [deleteCandidate, setDeleteCandidate] = useState<CronJob | null>(null);
    const [scheduleTypeDraft, setScheduleTypeDraft] =
        useState<ScheduledJob["scheduleType"]>("interval");
    const [intervalDraft, setIntervalDraft] = useState("");
    const [timeDraft, setTimeDraft] = useState("");
    const [cronExpressionDraft, setCronExpressionDraft] = useState("");
    const [scheduledEditError, setScheduledEditError] = useState<string | null>(null);

    const selectedScheduledJob =
        sortedScheduledJobs.find((job) => job.id === selectedScheduledJobId) || null;
    const currentScheduledJob = selectedScheduledJob || sortedScheduledJobs[0] || null;
    const currentScheduledJobId = currentScheduledJob?.id || "";
    const selectedCronJob =
        sortedCronJobs.find((job) => getCronJobId(job) === selectedCronJobId) || null;
    const selectedCronId = selectedCronJob ? getCronJobId(selectedCronJob) : "";
    const currentCronJob = selectedCronJob || sortedCronJobs[0] || null;
    const currentCronJobId = currentCronJob ? getCronJobId(currentCronJob) : "";

    const cronScheduleValidation = validateJsonString(cronScheduleDraft);
    const cronPayloadValidation = validateJsonString(cronPayloadDraft);
    const cronDeliveryValidation = validateJsonString(cronDeliveryDraft);
    const hasInvalidCronJson =
        !cronScheduleValidation.valid ||
        !cronPayloadValidation.valid ||
        !cronDeliveryValidation.valid;

    useEffect(() => {
        if (!currentCronJob) return;
        setCronNameDraft(String(currentCronJob.name || ""));
        setCronScheduleDraft(JSON.stringify(currentCronJob.schedule || {}, null, 2));
        setCronPayloadDraft(JSON.stringify(currentCronJob.payload || {}, null, 2));
        setCronDeliveryDraft(JSON.stringify(currentCronJob.delivery || {}, null, 2));
        setCronEditError(null);
        setIsCronEditMode(false);
    }, [currentCronJob]);

    useEffect(() => {
        if (!currentScheduledJob) return;
        setScheduleTypeDraft(currentScheduledJob.scheduleType);
        setIntervalDraft(String(currentScheduledJob.intervalSeconds));
        setTimeDraft(currentScheduledJob.timeOfDay || "");
        setCronExpressionDraft(currentScheduledJob.cronExpression || "");
        setScheduledEditError(null);
    }, [currentScheduledJob]);

    async function handleScheduledToggle(job: ScheduledJob, enabled: boolean) {
        await updateScheduledJob.mutateAsync({ id: job.id, patch: { enabled } });
    }

    async function handleScheduledRun(job: ScheduledJob) {
        await runScheduledJob.mutateAsync({ id: job.id });
    }

    async function handleScheduledSave(job: ScheduledJob) {
        const patch: ScheduledJobPatch = {
            scheduleType: scheduleTypeDraft,
            intervalSeconds:
                scheduleTypeDraft === "interval"
                    ? (parsePositiveInteger(intervalDraft) ?? job.intervalSeconds)
                    : job.intervalSeconds,
            timeOfDay: scheduleTypeDraft === "daily" ? timeDraft : null,
            cronExpression:
                scheduleTypeDraft === "cron" ? cronExpressionDraft.trim() : null,
        };
        try {
            await updateScheduledJob.mutateAsync({ id: job.id, patch });
            setScheduledEditError(null);
        } catch (error) {
            setScheduledEditError(
                error instanceof Error ? error.message : "Scheduled job update failed"
            );
        }
    }

    async function handleCronToggle(job: CronJob, enabled: boolean) {
        const id = getCronJobId(job);
        if (!id) return;
        await toggleCronJob.mutateAsync({ id, enabled });
    }

    async function handleCronRunNow(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) return;
        await runCronNow.mutateAsync({ id });
        setLastCronRunAt((prev) => ({ ...prev, [id]: Date.now() }));
    }

    async function handleCronSave(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await updateCronJob.mutateAsync({
                id,
                patch: {
                    name: cronNameDraft.trim() || undefined,
                    schedule: JSON.parse(cronScheduleDraft),
                    payload: JSON.parse(cronPayloadDraft),
                    delivery: JSON.parse(cronDeliveryDraft),
                },
            });
            setCronEditError(null);
        } catch (error) {
            setCronEditError(
                error instanceof Error ? error.message : "Invalid JSON in edit fields"
            );
        }
    }

    async function handleCronDelete(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) {
            setDeleteCandidate(null);
            return;
        }
        await deleteCronJob.mutateAsync({ id });
        setSelectedCronJobId("");
        setDeleteCandidate(null);
    }

    const isLoading = scheduledLoading || cronLoading;
    const error = scheduledError || cronError;

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={error?.message ?? null}
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-3 sm:p-6">
                    <p className="text-red-400">{error?.message}</p>
                    <Button
                        variant="secondary"
                        onClick={() => {
                            void refetchScheduledJobs();
                            void refetchCronJobs();
                        }}
                    >
                        <RotateCw className="h-4 w-4" />
                        Retry
                    </Button>
                </div>
            }
            isEmpty={sortedScheduledJobs.length === 0 && sortedCronJobs.length === 0}
            empty={
                <div className="p-3 sm:p-6">
                    <Card variant="bordered">
                        <CardTitle>No jobs found</CardTitle>
                        <p className="text-primary-300 mt-2 text-sm">
                            Scheduled jobs and OpenClaw cron jobs will appear here.
                        </p>
                    </Card>
                </div>
            }
        >
            <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
                <Card variant="bordered" className="p-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Button
                            type="button"
                            variant={view === "scheduled" ? "primary" : "ghost"}
                            onClick={() => setView("scheduled")}
                            className="justify-center"
                        >
                            Dashboard jobs ({sortedScheduledJobs.length})
                        </Button>
                        <Button
                            type="button"
                            variant={view === "openclaw" ? "primary" : "ghost"}
                            onClick={() => setView("openclaw")}
                            className="justify-center"
                        >
                            OpenClaw cron ({sortedCronJobs.length})
                        </Button>
                    </div>
                </Card>

                {view === "scheduled" ? (
                    <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[380px_1fr]">
                        <ScheduledJobList
                            jobs={sortedScheduledJobs}
                            selectedId={selectedScheduledJobId}
                            currentJobId={currentScheduledJobId}
                            onSelect={setSelectedScheduledJobId}
                        />
                        {currentScheduledJob ? (
                            <ScheduledJobDetails
                                job={currentScheduledJob}
                                scheduleTypeDraft={scheduleTypeDraft}
                                intervalDraft={intervalDraft}
                                timeDraft={timeDraft}
                                cronDraft={cronExpressionDraft}
                                editError={scheduledEditError}
                                runPending={runScheduledJob.isPending}
                                updatePending={updateScheduledJob.isPending}
                                onScheduleTypeChange={setScheduleTypeDraft}
                                onIntervalChange={setIntervalDraft}
                                onTimeChange={setTimeDraft}
                                onCronChange={setCronExpressionDraft}
                                onToggle={(enabled) => {
                                    void handleScheduledToggle(
                                        currentScheduledJob,
                                        enabled
                                    );
                                }}
                                onRunNow={() => {
                                    void handleScheduledRun(currentScheduledJob);
                                }}
                                onSave={() => {
                                    void handleScheduledSave(currentScheduledJob);
                                }}
                            />
                        ) : null}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[360px_1fr]">
                        <CronJobList
                            jobs={sortedCronJobs}
                            selectedId={selectedCronId}
                            currentJobId={currentCronJobId}
                            onSelect={setSelectedCronJobId}
                        />
                        {currentCronJob ? (
                            <CronJobDetails
                                job={currentCronJob}
                                lastTriggeredAt={lastCronRunAt[currentCronJobId]}
                                togglePending={toggleCronJob.isPending}
                                runPending={runCronNow.isPending}
                                updatePending={updateCronJob.isPending}
                                deletePending={deleteCronJob.isPending}
                                onToggle={(job, enabled) => {
                                    void handleCronToggle(job, enabled);
                                }}
                                onRunNow={(job) => {
                                    void handleCronRunNow(job);
                                }}
                                isEditMode={isCronEditMode}
                                onEditModeChange={(enabled) => {
                                    setIsCronEditMode(enabled);
                                    if (!enabled) setCronEditError(null);
                                }}
                                nameDraft={cronNameDraft}
                                onNameDraftChange={setCronNameDraft}
                                scheduleDraft={cronScheduleDraft}
                                onScheduleDraftChange={setCronScheduleDraft}
                                payloadDraft={cronPayloadDraft}
                                onPayloadDraftChange={setCronPayloadDraft}
                                deliveryDraft={cronDeliveryDraft}
                                onDeliveryDraftChange={setCronDeliveryDraft}
                                scheduleValidation={cronScheduleValidation}
                                payloadValidation={cronPayloadValidation}
                                deliveryValidation={cronDeliveryValidation}
                                hasInvalidJson={hasInvalidCronJson}
                                editError={cronEditError}
                                onSave={(job) => {
                                    void handleCronSave(job);
                                }}
                                onDelete={setDeleteCandidate}
                                formatDate={formatDate}
                            />
                        ) : null}
                    </div>
                )}

                {deleteCandidate ? (
                    <ConfirmModal
                        isOpen
                        title="Delete cron job"
                        message={`Delete ${String(deleteCandidate.name || getCronJobId(deleteCandidate))}?`}
                        confirmLabel="Delete cron job"
                        confirmLoadingLabel="Deleting"
                        loading={deleteCronJob.isPending}
                        danger
                        onCancel={() => setDeleteCandidate(null)}
                        onConfirm={() => {
                            void handleCronDelete(deleteCandidate);
                        }}
                    />
                ) : null}
            </div>
        </PageState>
    );
}
