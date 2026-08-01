import { Play, Save } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import type { CronJob } from "../../../../../contracts/cron";
import type {
    ScheduledJob,
    ScheduledJobPatch,
    ScheduledJobRunStatus,
} from "../../../../../contracts/jobs";
import { useScheduledJobRuns } from "../../../hooks";
import { messageFromError } from "../../../lib/errorMessage";
import { isCronExpressionValid } from "../../../utils/cronUtilities";
import {
    appTimeOfDayToUtcTimeOfDay,
    formatDate,
    formatUtcTimeOfDayInAppTimeZone,
} from "../../../utils/format";
import { validateJsonString } from "../../../utils/json";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { CronJobDetails } from "../cron";
import { JobDisableIntentStatus } from "./JobDisableIntentStatus";

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

export function ScheduledJobList({
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

export function ScheduledJobEditor({
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

export function CronJobEditor({
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
