import { Play, RotateCw, Save } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import type { CronJob } from "../../../contracts/cron";
import type {
    JobDisableIntent,
    ScheduledJob,
    ScheduledJobPatch,
    ScheduledJobRunStatus,
} from "../../../contracts/jobs";
import { CronJobDetails, CronJobList } from "../components/features/cron";
import { JobDisableIntentStatus } from "../components/features/jobs/JobDisableIntentStatus";
import { JobExecutionQueueCard } from "../components/features/jobs/JobExecutionQueueCard";
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
import { messageFromError } from "../lib/errorMessage";
import {
    getCronJobId,
    isCronExpressionValid,
    sortCronJobs,
} from "../utils/cronUtilities";
import {
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatUtcTimeOfDayInAppTimeZone,
} from "../utils/format";
import { validateJsonString } from "../utils/json";
import {
    defaultDisableUntilDraft,
    parseDisableUntilDraft,
    toDisableUntilDraft,
} from "./jobPageUtilities";

type JobsView = "scheduled" | "openclaw";
type DisableMode = JobDisableIntent["mode"];
type DisableCandidate =
    | { kind: "cron"; job: CronJob }
    | { kind: "scheduled"; job: ScheduledJob };

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
    if (job.isQueued || job.lastRun?.status === "queued") return "info" as const;
    if (job.isRunning || job.lastRun?.status === "running") return "info" as const;
    if (job.lastRun?.status === "cancelled") return "warning" as const;
    if (job.lastRun?.status === "failed") return "error" as const;
    if (job.lastRun?.status === "success") return "success" as const;
    return "default" as const;
}

function scheduledJobStatusLabel(job: ScheduledJob): string {
    if (!job.enabled) return "Disabled";
    if (job.isQueued || job.lastRun?.status === "queued") return "Queued";
    if (job.isRunning || job.lastRun?.status === "running") return "Running";
    return job.lastRun?.status || "Never run";
}

function scheduledRunButtonLabel(job: ScheduledJob, runPending: boolean): string {
    if (runPending) return "Queueing...";
    if (job.isQueued) return "Queued";
    if (job.isRunning) return "Running...";
    return "Run now";
}

function scheduledRunStatusVariant(status: ScheduledJobRunStatus) {
    if (status === "success") return "success" as const;
    if (status === "failed") return "error" as const;
    if (status === "cancelled") return "warning" as const;
    return "info" as const;
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
    const isSaveDisabled =
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
    const runButtonLabel = scheduledRunButtonLabel(job, runPending);
    let runLogsContent: ReactNode;
    if (runs.isLoading) {
        runLogsContent = <div className="text-sm text-primary-400">Loading runs...</div>;
    } else if (runs.data && runs.data.length > 0) {
        runLogsContent = (
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
                                    Queued {formatDate(run.queuedAt)}
                                    {run.status === "queued"
                                        ? ""
                                        : ` · started ${formatDate(run.startedAt)}`}
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
                                variant={scheduledRunStatusVariant(run.status)}
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
        );
    } else {
        runLogsContent = <div className="text-sm text-primary-400">No run logs yet.</div>;
    }

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
                        disabled={runPending || job.isQueued || job.isRunning}
                        onClick={onRunNow}
                        className="w-full sm:w-auto"
                    >
                        <Play
                            className={[
                                "h-4 w-4",
                                runPending ? "animate-pulse" : "",
                            ].join(" ")}
                        />
                        {runButtonLabel}
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
                        disabled={isSaveDisabled}
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

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                <Card className="min-w-0 bg-primary-900/40 p-3">
                    <div className="text-xs text-primary-400">Resource class</div>
                    <div className="mt-1 text-sm text-primary-100 capitalize">
                        {(job.resourceClass ?? "light").replace("-", " ")}
                    </div>
                </Card>
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
                {runLogsContent}
            </Card>
        </Card>
    );
}

interface ScheduledJobEditorProperties {
    job: ScheduledJob;
    runPending: boolean;
    updatePending: boolean;
    onConfigureDisable: () => void;
    onRunNow: () => void;
    onSave: (job: ScheduledJob, patch: ScheduledJobPatch) => Promise<void>;
    onToggle: (isEnabled: boolean) => void;
}

function ScheduledJobEditor({
    job,
    runPending,
    updatePending,
    onConfigureDisable,
    onRunNow,
    onSave,
    onToggle,
}: ScheduledJobEditorProperties) {
    const initialTimeDraft = job.timeOfDay
        ? formatUtcTimeOfDayInAppTimeZone(job.timeOfDay, job.nextRunAt)
        : "";
    const [scheduleTypeDraft, setScheduleTypeDraft] = useState(job.scheduleType);
    const [intervalDraft, setIntervalDraft] = useState(String(job.intervalSeconds));
    const [timeDraft, setTimeDraft] = useState(initialTimeDraft);
    const [cronExpressionDraft, setCronExpressionDraft] = useState(
        job.cronExpression || ""
    );
    const [editError, setEditError] = useState<string | undefined>();
    const dailyTimeDraftSourceRef = useRef(
        job.timeOfDay
            ? {
                  displayTimeOfDay: initialTimeDraft,
                  utcTimeOfDay: job.timeOfDay,
              }
            : undefined
    );

    function getDailyTimeOfDayPatch(): string | null {
        if (scheduleTypeDraft !== "daily") {
            return null;
        }
        const draftSource = dailyTimeDraftSourceRef.current;
        if (draftSource && timeDraft === draftSource.displayTimeOfDay) {
            return draftSource.utcTimeOfDay;
        }
        return appTimeOfDayToUtcTimeOfDay(timeDraft, job.nextRunAt);
    }

    async function saveSchedule(): Promise<void> {
        const patch: ScheduledJobPatch = {
            cronExpression:
                scheduleTypeDraft === "cron" ? cronExpressionDraft.trim() : null,
            intervalSeconds:
                scheduleTypeDraft === "interval"
                    ? Number(intervalDraft)
                    : job.intervalSeconds,
            scheduleType: scheduleTypeDraft,
            timeOfDay: getDailyTimeOfDayPatch(),
        };
        try {
            await onSave(job, patch);
            setEditError(undefined);
        } catch (error) {
            setEditError(messageFromError(error, "Scheduled job update failed"));
        }
    }

    return (
        <ScheduledJobDetails
            job={job}
            scheduleTypeDraft={scheduleTypeDraft}
            intervalDraft={intervalDraft}
            timeDraft={timeDraft}
            cronDraft={cronExpressionDraft}
            editError={editError}
            runPending={runPending}
            updatePending={updatePending}
            onScheduleTypeChange={setScheduleTypeDraft}
            onIntervalChange={setIntervalDraft}
            onTimeChange={setTimeDraft}
            onCronChange={setCronExpressionDraft}
            onToggle={onToggle}
            onConfigureDisable={onConfigureDisable}
            onRunNow={onRunNow}
            onSave={() => void saveSchedule()}
        />
    );
}

interface CronJobEditorProperties {
    deletePending: boolean;
    job: CronJob;
    lastTriggeredAt: number | undefined;
    runPending: boolean;
    togglePending: boolean;
    updatePending: boolean;
    onConfigureDisable: (job: CronJob) => void;
    onDelete: (job: CronJob) => void;
    onRunNow: (job: CronJob) => void;
    onSave: (job: CronJob, patch: Record<string, unknown>) => Promise<void>;
    onToggle: (job: CronJob, isEnabled: boolean) => void;
}

function CronJobEditor({
    deletePending,
    job,
    lastTriggeredAt,
    runPending,
    togglePending,
    updatePending,
    onConfigureDisable,
    onDelete,
    onRunNow,
    onSave,
    onToggle,
}: CronJobEditorProperties) {
    const [isEditMode, setIsEditMode] = useState(false);
    const [nameDraft, setNameDraft] = useState(job.name || "");
    const [scheduleDraft, setScheduleDraft] = useState(
        JSON.stringify(job.schedule || {}, undefined, 2)
    );
    const [payloadDraft, setPayloadDraft] = useState(
        JSON.stringify(job.payload || {}, undefined, 2)
    );
    const [deliveryDraft, setDeliveryDraft] = useState(
        JSON.stringify(job.delivery || {}, undefined, 2)
    );
    const [editError, setEditError] = useState<string | undefined>();
    const scheduleValidation = validateJsonString(scheduleDraft);
    const payloadValidation = validateJsonString(payloadDraft);
    const deliveryValidation = validateJsonString(deliveryDraft);
    const hasInvalidJson =
        !scheduleValidation.valid ||
        !payloadValidation.valid ||
        !deliveryValidation.valid;

    function setEditMode(isEnabled: boolean): void {
        setEditError(undefined);
        if (isEnabled) {
            setNameDraft(job.name || "");
            setScheduleDraft(JSON.stringify(job.schedule || {}, undefined, 2));
            setPayloadDraft(JSON.stringify(job.payload || {}, undefined, 2));
            setDeliveryDraft(JSON.stringify(job.delivery || {}, undefined, 2));
        }
        setIsEditMode(isEnabled);
    }

    async function saveCronJob(): Promise<void> {
        try {
            await onSave(job, {
                delivery: JSON.parse(deliveryDraft),
                name: nameDraft.trim() || undefined,
                payload: JSON.parse(payloadDraft),
                schedule: JSON.parse(scheduleDraft),
            });
            setEditError(undefined);
        } catch (error) {
            setEditError(messageFromError(error, "Invalid JSON in edit fields"));
        }
    }

    return (
        <CronJobDetails
            job={job}
            lastTriggeredAt={lastTriggeredAt}
            togglePending={togglePending}
            runPending={runPending}
            updatePending={updatePending}
            deletePending={deletePending}
            onToggle={onToggle}
            onConfigureDisable={onConfigureDisable}
            onRunNow={onRunNow}
            isEditMode={isEditMode}
            onEditModeChange={setEditMode}
            nameDraft={nameDraft}
            onNameDraftChange={setNameDraft}
            scheduleDraft={scheduleDraft}
            onScheduleDraftChange={setScheduleDraft}
            payloadDraft={payloadDraft}
            onPayloadDraftChange={setPayloadDraft}
            deliveryDraft={deliveryDraft}
            onDeliveryDraftChange={setDeliveryDraft}
            scheduleValidation={scheduleValidation}
            payloadValidation={payloadValidation}
            deliveryValidation={deliveryValidation}
            hasInvalidJson={hasInvalidJson}
            editError={editError}
            onSave={() => void saveCronJob()}
            onDelete={onDelete}
            formatDate={formatDate}
        />
    );
}

/**
 * Renders the jobs UI.
 * @returns Rendered the jobs UI.
 */
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
