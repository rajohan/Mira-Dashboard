import { Play, RotateCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CronJobDetails, CronJobList } from "../components/features/cron";
import { JobDisableIntentStatus } from "../components/features/jobs/JobDisableIntentStatus";
import { Alert } from "../components/ui/Alert";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import {
    DateTimePicker,
    type DateTimePickerValue,
} from "../components/ui/DateTimePicker";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { Textarea } from "../components/ui/Textarea";
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
import type { JobDisableIntent } from "../types/job";
import {
    getCronJobId,
    isCronExpressionValid,
    sortCronJobs,
} from "../utils/cronUtilities";
import { appTimeZoneParts } from "../utils/date";
import {
    appDateTimeToTimestamp,
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatUtcTimeOfDayInAppTimeZone,
} from "../utils/format";
import { validateJsonString } from "../utils/json";

const CLEAR_SCHEDULE_FIELD = JSON.parse("null") as null;
const DEFAULT_DISABLE_FALLBACK_MS = 60 * 60 * 1000;

type JobsView = "scheduled" | "openclaw";
type DisableMode = JobDisableIntent["mode"];
type DisableCandidate =
    { kind: "cron"; job: CronJob } | { kind: "scheduled"; job: ScheduledJob };

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
const disableModeOptions = [
    {
        value: "until",
        label: "Until a date",
        description: "Heartbeat warns again after this time",
    },
    {
        value: "indefinite",
        label: "Indefinitely",
        description:
            "Heartbeat stays quiet until this annotation changes or the job is enabled",
    },
];

function toDisableUntilDraft(timestamp: number): DateTimePickerValue {
    const parts = appTimeZoneParts(new Date(timestamp));
    return {
        day: parts.day,
        hour: String(parts.hour).padStart(2, "0"),
        minute: String(parts.minute).padStart(2, "0"),
        month: parts.month,
        year: parts.year,
    };
}

function parseDisableUntilDraft(draft: DateTimePickerValue): number | undefined {
    return appDateTimeToTimestamp(
        draft.year,
        draft.month,
        draft.day,
        Number(draft.hour),
        Number(draft.minute)
    );
}

/** Starts a new temporary disable at the end of today's app-time-zone date. */
function defaultDisableUntilDraft(now = Date.now()): DateTimePickerValue {
    const today = appTimeZoneParts(new Date(now));
    const endOfToday = {
        day: today.day,
        hour: "23",
        minute: "59",
        month: today.month,
        year: today.year,
    };
    const endOfTodayTimestamp = parseDisableUntilDraft(endOfToday);
    return endOfTodayTimestamp !== undefined && endOfTodayTimestamp > now
        ? endOfToday
        : toDisableUntilDraft(now + DEFAULT_DISABLE_FALLBACK_MS);
}

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
    const parameters = new URLSearchParams(location.search);
    return parameters.get("view") === "openclaw" ? "openclaw" : "scheduled";
}

function getInitialCronJobId(): string {
    const parameters = new URLSearchParams(location.search);
    return parameters.get("job") || "";
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
    return jobs.toSorted(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
}

function parsePositiveInteger(value: string): number | undefined {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatRunOutput(output: Record<string, unknown>): string {
    return JSON.stringify(output, undefined, 2);
}

interface ScheduledJobListProperties {
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
}: ScheduledJobListProperties) {
    return (
        <Card
            variant="bordered"
            className="flex min-w-0 flex-col p-0 xl:max-h-[calc(100vh-10rem)]"
        >
            <div className="border-b border-primary-700 px-3 py-2 text-sm font-semibold text-primary-200 sm:px-4 sm:py-3">
                Dashboard jobs
            </div>
            <div className="min-h-0 flex-1 overflow-visible p-2 xl:overflow-auto">
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
                                    <div className="truncate text-sm font-medium text-primary-100">
                                        {job.name}
                                    </div>
                                    <div className="mt-1 truncate text-xs text-primary-400">
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
                            <div className="mt-2 grid w-full grid-cols-1 gap-x-2 gap-y-1 text-[11px] text-primary-400 sm:grid-cols-2">
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

interface ScheduledJobDetailsProperties {
    job: ScheduledJob;
    scheduleTypeDraft: ScheduledJob["scheduleType"];
    intervalDraft: string;
    timeDraft: string;
    cronDraft: string;
    editError: string | undefined;
    runPending: boolean;
    updatePending: boolean;
    onScheduleTypeChange: (value: ScheduledJob["scheduleType"]) => void;
    onIntervalChange: (value: string) => void;
    onTimeChange: (value: string) => void;
    onCronChange: (value: string) => void;
    onToggle: (isEnabled: boolean) => void;
    onConfigureDisable: () => void;
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
    onConfigureDisable,
    onRunNow,
    onSave,
}: ScheduledJobDetailsProperties) {
    const runs = useScheduledJobRuns(job.id);
    const isIntervalInvalid =
        scheduleTypeDraft === "interval" && !parsePositiveInteger(intervalDraft);
    const isDailyInvalid =
        scheduleTypeDraft === "daily" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeDraft);
    const isCronInvalid =
        scheduleTypeDraft === "cron" && !isCronExpressionValid(cronDraft);
    const saveDisabled =
        updatePending ||
        isIntervalInvalid ||
        isDailyInvalid ||
        isCronInvalid ||
        runPending;
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
                    <p className="mt-1 text-xs break-all text-primary-400">{job.id}</p>
                    {job.description ? (
                        <p className="mt-2 text-sm text-primary-300">{job.description}</p>
                    ) : undefined}
                </div>
                <Badge
                    className="shrink-0 whitespace-nowrap"
                    variant={scheduledJobStatusVariant(job)}
                >
                    {scheduledJobStatusLabel(job)}
                </Badge>
            </div>

            <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                <div className="mb-2 text-xs font-semibold tracking-wide text-primary-300 uppercase">
                    Controls
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Switch
                        isChecked={job.enabled}
                        onChange={onToggle}
                        label="Enabled"
                        disabled={updatePending}
                        className="rounded-lg border border-primary-700 bg-primary-800/60 px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0"
                    />
                    {job.enabled ? undefined : (
                        <JobDisableIntentStatus
                            disableIntent={job.disableIntent}
                            disabled={updatePending}
                            onConfigureDisable={onConfigureDisable}
                        />
                    )}
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

            <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                <div className="mb-3 text-xs font-semibold tracking-wide text-primary-300 uppercase">
                    Schedule
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(12rem,16rem)_1fr_auto] lg:items-end">
                    <div>
                        <div className="mb-1 block text-xs text-primary-300">Type</div>
                        <Select
                            value={scheduleTypeDraft}
                            options={scheduleTypeOptions}
                            onChange={(isValue) =>
                                onScheduleTypeChange(
                                    isValue as ScheduledJob["scheduleType"]
                                )
                            }
                            width="w-full"
                            ariaLabel="Schedule type"
                        />
                    </div>
                    {scheduleTypeDraft === "interval" ? (
                        <Input
                            label="Interval seconds"
                            inputMode="numeric"
                            value={intervalDraft}
                            onChange={(event) => onIntervalChange(event.target.value)}
                        />
                    ) : undefined}
                    {scheduleTypeDraft === "daily" ? (
                        <div>
                            <div className="mb-1 block text-xs text-primary-300">
                                Time of day
                            </div>
                            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                                <Select
                                    ariaLabel="Time of day hour"
                                    value={timeHour}
                                    options={hourOptions}
                                    onChange={(isValue) =>
                                        updateTimePart(isValue, timeMinute)
                                    }
                                    width="w-full"
                                    menuWidth="w-24"
                                />
                                <span className="text-sm text-primary-400">:</span>
                                <Select
                                    ariaLabel="Time of day minute"
                                    value={timeMinute}
                                    options={minuteOptions}
                                    onChange={(isValue) =>
                                        updateTimePart(timeHour, isValue)
                                    }
                                    width="w-full"
                                    menuWidth="w-24"
                                />
                            </div>
                        </div>
                    ) : undefined}
                    {scheduleTypeDraft === "cron" ? (
                        <Input
                            label="Cron expression"
                            value={cronDraft}
                            onChange={(event) => onCronChange(event.target.value)}
                            placeholder="0 4 * * *"
                        />
                    ) : undefined}
                    <Button
                        size="sm"
                        disabled={saveDisabled}
                        onClick={onSave}
                        className="h-9 w-full lg:w-auto"
                    >
                        <Save className="size-4" />
                        {updatePending ? "Saving..." : "Save schedule"}
                    </Button>
                </div>
                {isIntervalInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Interval must be a positive number of seconds.
                    </p>
                ) : undefined}
                {isDailyInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Daily schedules require HH:MM.
                    </p>
                ) : undefined}
                {isCronInvalid ? (
                    <p className="mt-2 text-xs text-red-400">
                        Cron schedules require a valid five-field expression.
                    </p>
                ) : undefined}
                {editError ? (
                    <p className="mt-2 text-xs text-red-400">{editError}</p>
                ) : undefined}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Card className="min-w-0 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Action</div>
                    <div className="mt-1 text-sm break-all text-primary-100">
                        {job.actionKey}
                    </div>
                </Card>
                <Card className="min-w-0 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Next run</div>
                    <div className="mt-1 text-sm text-primary-100">
                        {job.nextRunAt ? formatDate(job.nextRunAt) : "Not scheduled"}
                    </div>
                </Card>
                <Card className="min-w-0 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Last run</div>
                    <div className="mt-1 text-sm text-primary-100">
                        {job.lastRun ? formatDate(job.lastRun.startedAt) : "Never"}
                    </div>
                </Card>
                <Card className="min-w-0 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Updated</div>
                    <div className="mt-1 text-sm text-primary-100">
                        {formatDate(job.updatedAt)}
                    </div>
                </Card>
            </div>

            <Card className="min-w-0 bg-primary-900/40 p-3 sm:p-4">
                <div className="mb-2 text-xs font-semibold tracking-wide text-primary-300 uppercase">
                    Run logs
                </div>
                {runs.isLoading ? (
                    <div className="text-sm text-primary-400">Loading runs...</div>
                ) : runs.data && runs.data.length > 0 ? (
                    <div className="space-y-3">
                        {runs.data.map((run) => (
                            <div
                                key={run.id}
                                className="rounded-lg border border-primary-700 p-3"
                            >
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium text-primary-100">
                                            {run.triggerType} run #{run.id}
                                        </div>
                                        <div className="mt-1 text-xs text-primary-400">
                                            Started {formatDate(run.startedAt)}
                                            {run.finishedAt
                                                ? ` · finished ${formatDate(run.finishedAt)}`
                                                : ""}
                                        </div>
                                        {run.message ? (
                                            <div className="mt-1 text-xs text-red-300">
                                                {run.message}
                                            </div>
                                        ) : undefined}
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
                                <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/30 p-2 text-xs whitespace-pre-wrap text-primary-200">
                                    {formatRunOutput(run.output)}
                                </pre>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-sm text-primary-400">No run logs yet.</div>
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
    const lastScheduledDraftJobId = useRef<string | undefined>(undefined);
    const dailyTimeDraftSource = useRef<
        | undefined
        | {
              displayTimeOfDay: string;
              jobId: string;
              utcTimeOfDay: string;
          }
    >(undefined);
    const [lastCronRunAt, setLastCronRunAt] = useState<Record<string, number>>({});
    const [cronNameDraft, setCronNameDraft] = useState("");
    const [cronScheduleDraft, setCronScheduleDraft] = useState("{}");
    const [cronPayloadDraft, setCronPayloadDraft] = useState("{}");
    const [cronDeliveryDraft, setCronDeliveryDraft] = useState("{}");
    const [cronEditError, setCronEditError] = useState<string | undefined>(undefined);
    const [isCronEditMode, setIsCronEditMode] = useState(false);
    const [deleteCandidate, setDeleteCandidate] = useState<CronJob | undefined>(
        undefined
    );
    const [disableCandidate, setDisableCandidate] = useState<
        DisableCandidate | undefined
    >(undefined);
    const [disableMode, setDisableMode] = useState<DisableMode>("until");
    const [disableComment, setDisableComment] = useState("");
    const [disableUntil, setDisableUntil] = useState<DateTimePickerValue>(() =>
        defaultDisableUntilDraft()
    );
    const [disableCommentError, setDisableCommentError] = useState<string | undefined>(
        undefined
    );
    const [disableUntilError, setDisableUntilError] = useState<string | undefined>(
        undefined
    );
    const [scheduleTypeDraft, setScheduleTypeDraft] =
        useState<ScheduledJob["scheduleType"]>("interval");
    const [intervalDraft, setIntervalDraft] = useState("");
    const [timeDraft, setTimeDraft] = useState("");
    const [cronExpressionDraft, setCronExpressionDraft] = useState("");
    const [scheduledEditError, setScheduledEditError] = useState<string | undefined>(
        undefined
    );
    const [actionError, setActionError] = useState<string | undefined>(undefined);

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
    const disablePending =
        disableCandidate?.kind === "scheduled"
            ? updateScheduledJob.isPending
            : toggleCronJob.isPending;

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
        setCronScheduleDraft(JSON.stringify(currentCronJob.schedule || {}, undefined, 2));
        setCronPayloadDraft(JSON.stringify(currentCronJob.payload || {}, undefined, 2));
        setCronDeliveryDraft(JSON.stringify(currentCronJob.delivery || {}, undefined, 2));
        setCronEditError(undefined);
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
            : undefined;
        setTimeDraft(displayTimeOfDay);
        setCronExpressionDraft(currentScheduledJob.cronExpression || "");
        setScheduledEditError(undefined);
    }, [currentScheduledJob]);

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
                getErrorMessage(error, "Failed to update scheduled job state")
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
            setActionError(getErrorMessage(error, "Failed to run scheduled job"));
        }
    }

    function getDailyTimeOfDayPatch(job: ScheduledJob): string | null {
        if (scheduleTypeDraft !== "daily") return CLEAR_SCHEDULE_FIELD;
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
                scheduleTypeDraft === "cron"
                    ? cronExpressionDraft.trim()
                    : CLEAR_SCHEDULE_FIELD,
        };
        try {
            await updateScheduledJob.mutateAsync({ id: job.id, patch });
            setScheduledEditError(undefined);
            setActionError(undefined);
        } catch (error) {
            setScheduledEditError(getErrorMessage(error, "Scheduled job update failed"));
        }
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
            setActionError(getErrorMessage(error, "Failed to update cron job state"));
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
        if (disableCandidate.kind === "scheduled") {
            await persistScheduledToggle(disableCandidate.job, false, disableIntent);
        } else {
            await persistCronToggle(disableCandidate.job, false, disableIntent);
        }
    }

    async function handleCronRunNow(job: CronJob) {
        const id = getCronJobId(job);
        if (!id) return;
        try {
            await runCronNow.mutateAsync({ id });
            setLastCronRunAt((wasPrevious) => ({ ...wasPrevious, [id]: Date.now() }));
            setActionError(undefined);
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
            setCronEditError(undefined);
            setActionError(undefined);
        } catch (error) {
            setCronEditError(getErrorMessage(error, "Invalid JSON in edit fields"));
        }
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
            setActionError(getErrorMessage(error, "Failed to delete cron job"));
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
                    {error.message}
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

            {isLoading ? (
                <div className="flex min-h-80 items-center justify-center">
                    <LoadingState size="lg" />
                </div>
            ) : error && !hasLoadedJobs ? (
                <div className="flex min-h-80 flex-col items-center justify-center gap-4">
                    <p className="text-red-400">{error.message}</p>
                    <Button variant="secondary" onClick={retryActiveView}>
                        <RotateCw className="size-4" />
                        Retry
                    </Button>
                </div>
            ) : isEmpty ? (
                <Card variant="bordered">
                    <CardTitle>No jobs found</CardTitle>
                    <p className="mt-2 text-sm text-primary-300">
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
                            handleCronToggle(job, enabled);
                        }}
                        onConfigureDisable={(job) =>
                            openDisableModal({ kind: "cron", job })
                        }
                        onRunNow={(job) => {
                            void handleCronRunNow(job);
                        }}
                        isEditMode={isCronEditMode}
                        onEditModeChange={(isEnabled) => {
                            setIsCronEditMode(isEnabled);
                            if (!isEnabled) setCronEditError(undefined);
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
                        if (!disablePending) setDisableCandidate(undefined);
                    }}
                >
                    <div className="space-y-4">
                        <p className="text-sm text-primary-300">
                            Heartbeat will treat this{" "}
                            {disableCandidate.kind === "scheduled"
                                ? "Dashboard job"
                                : "OpenClaw cron job"}{" "}
                            as intentionally disabled while this annotation is active.
                            {disableCandidate.kind === "cron" &&
                            (disableCandidate.job.taskLinks?.length ?? 0) > 0
                                ? ` It is linked to ${disableCandidate.job.taskLinks?.length} open task${disableCandidate.job.taskLinks?.length === 1 ? "" : "s"}.`
                                : ""}
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
                                disabled={disablePending}
                                onClick={() => setDisableCandidate(undefined)}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                disabled={disablePending}
                                onClick={() => {
                                    void handleIntentionalDisable();
                                }}
                            >
                                {disablePending
                                    ? "Saving..."
                                    : disableCandidate.job.enabled === false
                                      ? "Save disabled state"
                                      : "Disable job"}
                            </Button>
                        </div>
                    </div>
                </Modal>
            ) : undefined}
        </div>
    );
}
