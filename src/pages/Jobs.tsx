import { Play, RotateCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CronJobDetails, CronJobList } from "../components/features/cron";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
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
import { cronExpressionIsValid, getCronJobId, sortCronJobs } from "../utils/cronUtils";
import {
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatUtcTimeOfDayInAppTimeZone,
} from "../utils/format";
import { validateJsonString } from "../utils/json";

type JobsView = "scheduled" | "openclaw";

const scheduleTypeOptions = [
    { value: "interval", label: "Interval", description: "Run every N seconds" },
    { value: "daily", label: "Daily", description: "Run once per day" },
    { value: "cron", label: "Cron", description: "Use a five-field cron expression" },
];
const hourOptions = Array.from({ length: 24 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});
const minuteOptions = Array.from({ length: 60 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});

function formatScheduledJobSchedule(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.scheduleType === "daily") {
        return `Daily at ${formatUtcTimeOfDayInAppTimeZone(job.timeOfDay, job.nextRunAt)}`;
    }
    if (job.scheduleType === "cron") return job.cronExpression || "Cron schedule";
    if (job.intervalSeconds < 60) return `Every ${job.intervalSeconds}s`;
    const minutes = Math.round(job.intervalSeconds / 60);
    if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60}h`;
    return `Every ${minutes}m`;
}

function getInitialJobsView(): JobsView {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "openclaw" ? "openclaw" : "scheduled";
}

function getInitialCronJobId(): string {
    const params = new URLSearchParams(window.location.search);
    return params.get("job") || "";
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
        <Card
            variant="bordered"
            className="flex min-w-0 flex-col p-0 xl:max-h-[calc(100vh-10rem)]"
        >
            <div className="border-primary-700 text-primary-200 border-b px-3 py-2 text-sm font-semibold sm:px-4 sm:py-3">
                Dashboard jobs
            </div>
            <div className="max-h-80 flex-1 overflow-auto p-2 xl:max-h-none">
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
    const cronInvalid = scheduleTypeDraft === "cron" && !cronExpressionIsValid(cronDraft);
    const saveDisabled =
        updatePending || intervalInvalid || dailyInvalid || cronInvalid || runPending;
    const [timeHour = "00", timeMinute = "00"] = /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(
        timeDraft
    )
        ? timeDraft.split(":", 2)
        : ["00", "00"];
    const updateTimePart = (nextHour: string, nextMinute: string) => {
        onTimeChange(`${nextHour}:${nextMinute}`);
    };

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
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                                <Select
                                    ariaLabel="Time of day hour"
                                    value={timeHour}
                                    options={hourOptions}
                                    onChange={(value) =>
                                        updateTimePart(value, timeMinute)
                                    }
                                    width="w-full"
                                    menuWidth="w-24"
                                />
                                <span className="text-primary-400 text-sm">:</span>
                                <Select
                                    ariaLabel="Time of day minute"
                                    value={timeMinute}
                                    options={minuteOptions}
                                    onChange={(value) => updateTimePart(timeHour, value)}
                                    width="w-full"
                                    menuWidth="w-24"
                                />
                            </div>
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
                        className="h-9 w-full lg:w-auto"
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
                        Cron schedules require a valid five-field expression.
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

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

/** Renders the jobs UI. */
export function Jobs() {
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
    const [view, setView] = useState<JobsView>(getInitialJobsView);
    const [selectedScheduledJobId, setSelectedScheduledJobId] = useState("");
    const [selectedCronJobId, setSelectedCronJobId] = useState(getInitialCronJobId);
    const lastScheduledDraftJobId = useRef<string | null>(null);
    const dailyTimeDraftSource = useRef<null | {
        displayTimeOfDay: string;
        jobId: string;
        utcTimeOfDay: string;
    }>(null);
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
    const [actionError, setActionError] = useState<string | null>(null);

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
        if (lastScheduledDraftJobId.current === currentScheduledJob.id) return;
        lastScheduledDraftJobId.current = currentScheduledJob.id;
        setScheduleTypeDraft(currentScheduledJob.scheduleType);
        setIntervalDraft(String(currentScheduledJob.intervalSeconds));
        const displayTimeOfDay = currentScheduledJob.timeOfDay
            ? formatUtcTimeOfDayInAppTimeZone(
                  currentScheduledJob.timeOfDay,
                  currentScheduledJob.nextRunAt
              )
            : "";
        dailyTimeDraftSource.current = currentScheduledJob.timeOfDay
            ? {
                  displayTimeOfDay,
                  jobId: currentScheduledJob.id,
                  utcTimeOfDay: currentScheduledJob.timeOfDay,
              }
            : null;
        setTimeDraft(displayTimeOfDay);
        setCronExpressionDraft(currentScheduledJob.cronExpression || "");
        setScheduledEditError(null);
    }, [currentScheduledJob]);

    async function handleScheduledToggle(job: ScheduledJob, enabled: boolean) {
        try {
            await updateScheduledJob.mutateAsync({ id: job.id, patch: { enabled } });
            setActionError(null);
        } catch (error) {
            setActionError(
                getErrorMessage(error, "Failed to update scheduled job state")
            );
        }
    }

    async function handleScheduledRun(job: ScheduledJob) {
        try {
            await runScheduledJob.mutateAsync({ id: job.id });
            setActionError(null);
        } catch (error) {
            setActionError(getErrorMessage(error, "Failed to run scheduled job"));
        }
    }

    function getDailyTimeOfDayPatch(job: ScheduledJob): string | null {
        if (scheduleTypeDraft !== "daily") return null;
        const draftSource = dailyTimeDraftSource.current;
        if (draftSource?.jobId === job.id && timeDraft === draftSource.displayTimeOfDay) {
            return draftSource.utcTimeOfDay;
        }
        return appTimeOfDayToUtcTimeOfDay(timeDraft, job.nextRunAt);
    }

    async function handleScheduledSave(job: ScheduledJob) {
        const patch: ScheduledJobPatch = {
            scheduleType: scheduleTypeDraft,
            intervalSeconds:
                scheduleTypeDraft === "interval"
                    ? Number(intervalDraft)
                    : job.intervalSeconds,
            timeOfDay: getDailyTimeOfDayPatch(job),
            cronExpression:
                scheduleTypeDraft === "cron" ? cronExpressionDraft.trim() : null,
        };
        try {
            await updateScheduledJob.mutateAsync({ id: job.id, patch });
            setScheduledEditError(null);
            setActionError(null);
        } catch (error) {
            setScheduledEditError(getErrorMessage(error, "Scheduled job update failed"));
        }
    }

    async function handleCronToggle(job: CronJob, enabled: boolean) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await toggleCronJob.mutateAsync({ id, enabled });
            setActionError(null);
        } catch (error) {
            setActionError(getErrorMessage(error, "Failed to update cron job state"));
        }
    }

    async function handleCronRunNow(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await runCronNow.mutateAsync({ id });
            setLastCronRunAt((prev) => ({ ...prev, [id]: Date.now() }));
            setActionError(null);
        } catch (error) {
            setActionError(getErrorMessage(error, "Failed to run cron job"));
        }
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
            setActionError(null);
        } catch (error) {
            setCronEditError(getErrorMessage(error, "Invalid JSON in edit fields"));
        }
    }

    async function handleCronDelete(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) {
            setDeleteCandidate(null);
            return;
        }
        try {
            await deleteCronJob.mutateAsync({ id });
            setSelectedCronJobId("");
            setDeleteCandidate(null);
            setActionError(null);
        } catch (error) {
            setActionError(getErrorMessage(error, "Failed to delete cron job"));
        }
    }

    const isLoading = view === "scheduled" ? scheduledLoading : cronLoading;
    const error = view === "scheduled" ? scheduledError : cronError;
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

    return (
        <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
            {actionError ? (
                <Card variant="bordered" className="border-red-500/40 bg-red-500/10 p-3">
                    <p className="text-sm text-red-300">{actionError}</p>
                </Card>
            ) : null}

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

            {isLoading ? (
                <div className="flex min-h-80 items-center justify-center">
                    <LoadingState size="lg" />
                </div>
            ) : error ? (
                <div className="flex min-h-80 flex-col items-center justify-center gap-4">
                    <p className="text-red-400">{error.message}</p>
                    <Button variant="secondary" onClick={retryActiveView}>
                        <RotateCw className="h-4 w-4" />
                        Retry
                    </Button>
                </div>
            ) : isEmpty ? (
                <Card variant="bordered">
                    <CardTitle>No jobs found</CardTitle>
                    <p className="text-primary-300 mt-2 text-sm">
                        {view === "scheduled"
                            ? "Dashboard scheduled jobs will appear here."
                            : "OpenClaw cron jobs will appear here."}
                    </p>
                </Card>
            ) : view === "scheduled" ? (
                <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[380px_1fr]">
                    <ScheduledJobList
                        jobs={sortedScheduledJobs}
                        selectedId={selectedScheduledJobId}
                        currentJobId={currentScheduledJobId}
                        onSelect={setSelectedScheduledJobId}
                    />
                    <ScheduledJobDetails
                        job={currentScheduledJob as ScheduledJob}
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
                                currentScheduledJob as ScheduledJob,
                                enabled
                            );
                        }}
                        onRunNow={() => {
                            void handleScheduledRun(currentScheduledJob as ScheduledJob);
                        }}
                        onSave={() => {
                            void handleScheduledSave(currentScheduledJob as ScheduledJob);
                        }}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[360px_1fr]">
                    <CronJobList
                        jobs={sortedCronJobs}
                        selectedId={selectedCronId}
                        currentJobId={currentCronJobId}
                        onSelect={setSelectedCronJobId}
                    />
                    <CronJobDetails
                        job={currentCronJob as CronJob}
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
    );
}
