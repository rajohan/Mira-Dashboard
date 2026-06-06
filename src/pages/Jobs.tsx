import { Play, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { Select } from "../components/ui/Select";
import { Switch } from "../components/ui/Switch";
import { useRunScheduledJob, useScheduledJobs, useUpdateScheduledJob } from "../hooks";
import type { ScheduledJob } from "../hooks/useJobs";
import { formatDate } from "../utils/format";

type EditableScheduleType = "interval" | "daily";

const SCHEDULE_TYPE_OPTIONS = [
    { value: "interval", label: "Interval", description: "Run every N seconds" },
    { value: "daily", label: "Daily time", description: "Run once per day at HH:mm" },
] as const;

function formatInterval(seconds: number): string {
    if (seconds % 3600 === 0) {
        const hours = seconds / 3600;
        return `${hours}h`;
    }
    if (seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

function statusVariant(status?: string): "success" | "error" | "warning" | "default" {
    if (status === "success") return "success";
    if (status === "failed") return "error";
    if (status === "running") return "warning";
    return "default";
}

function sortJobs(jobs: ScheduledJob[]): ScheduledJob[] {
    return [...jobs].sort((a, b) => a.name.localeCompare(b.name));
}

function formatSchedule(job: ScheduledJob): string {
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return `Daily at ${job.timeOfDay}`;
    }
    if (job.scheduleType === "cron") {
        return job.cronExpression ? `Cron: ${job.cronExpression}` : "Cron schedule";
    }
    return `Every ${formatInterval(job.intervalSeconds)}`;
}

/** Renders backend-native scheduled jobs UI. */
export function Jobs() {
    const { data: jobs = [], isLoading, error } = useScheduledJobs();
    const updateJob = useUpdateScheduledJob();
    const runJob = useRunScheduledJob();
    const sortedJobs = sortJobs(jobs);
    const [selectedJobId, setSelectedJobId] = useState("");
    const selectedJob =
        sortedJobs.find((job) => job.id === selectedJobId) || sortedJobs[0] || null;
    const [intervalDraft, setIntervalDraft] = useState("");
    const [scheduleTypeDraft, setScheduleTypeDraft] =
        useState<EditableScheduleType>("interval");
    const [timeOfDayDraft, setTimeOfDayDraft] = useState("");
    const [actionError, setActionError] = useState("");
    const isCronSchedule = selectedJob?.scheduleType === "cron";

    useEffect(() => {
        setActionError("");
        if (selectedJob) {
            setIntervalDraft(String(selectedJob.intervalSeconds));
            setScheduleTypeDraft(
                selectedJob.scheduleType === "daily" ? "daily" : "interval"
            );
            setTimeOfDayDraft(selectedJob.timeOfDay || "09:00");
        }
    }, [selectedJob?.id]);

    const intervalNumber = Number(intervalDraft);
    const intervalIsValid = Number.isSafeInteger(intervalNumber) && intervalNumber >= 60;
    const timeOfDayIsValid = /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDayDraft);
    const scheduleIsValid =
        scheduleTypeDraft === "interval" ? intervalIsValid : timeOfDayIsValid;

    function handleActionError(error: unknown) {
        setActionError(error instanceof Error ? error.message : String(error));
    }

    async function saveSchedule() {
        if (!selectedJob) {
            return;
        }
        const patch = {
            scheduleType: scheduleTypeDraft,
            ...(scheduleTypeDraft === "interval"
                ? { intervalSeconds: intervalNumber, timeOfDay: null }
                : { timeOfDay: timeOfDayDraft }),
        };
        setActionError("");
        try {
            await updateJob.mutateAsync({
                id: selectedJob.id,
                patch,
            });
        } catch (error) {
            handleActionError(error);
        }
    }

    async function toggleSelected(enabled: boolean) {
        if (!selectedJob) {
            return;
        }
        setActionError("");
        try {
            await updateJob.mutateAsync({
                id: selectedJob.id,
                patch: { enabled },
            });
        } catch (error) {
            handleActionError(error);
        }
    }

    async function runSelected() {
        if (!selectedJob) {
            return;
        }
        setActionError("");
        try {
            await runJob.mutateAsync({ id: selectedJob.id });
        } catch (error) {
            handleActionError(error);
        }
    }

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={error?.message ?? null}
            errorView={
                error ? (
                    <div className="p-3 sm:p-6">
                        <Card variant="bordered">
                            <CardTitle>Scheduled jobs unavailable</CardTitle>
                            <p className="text-primary-300 mt-2 text-sm">
                                {error.message}
                            </p>
                        </Card>
                    </div>
                ) : null
            }
            isEmpty={sortedJobs.length === 0}
            empty={
                <div className="p-3 sm:p-6">
                    <Card variant="bordered">
                        <CardTitle>No scheduled jobs found</CardTitle>
                        <p className="text-primary-300 mt-2 text-sm">
                            Built-in backend jobs will appear here once the backend
                            scheduler initializes.
                        </p>
                    </Card>
                </div>
            }
        >
            <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
                <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[360px_1fr]">
                    <Card variant="bordered" className="min-w-0 p-2">
                        <CardTitle className="px-2 py-2 text-base">
                            Scheduled jobs
                        </CardTitle>
                        <div className="space-y-1">
                            {sortedJobs.map((job) => (
                                <button
                                    key={job.id}
                                    type="button"
                                    onClick={() => setSelectedJobId(job.id)}
                                    className={[
                                        "border-primary-700 hover:bg-primary-800/80 block w-full rounded-lg border p-3 text-left transition",
                                        selectedJob?.id === job.id
                                            ? "bg-primary-800 ring-accent-500 ring-1"
                                            : "bg-primary-900/40",
                                    ].join(" ")}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-primary-100 font-medium">
                                                {job.name}
                                            </div>
                                            <div className="text-primary-500 mt-1 text-xs break-all">
                                                {job.actionTarget}
                                            </div>
                                        </div>
                                        <Badge
                                            variant={job.enabled ? "success" : "warning"}
                                        >
                                            {job.enabled ? "Enabled" : "Disabled"}
                                        </Badge>
                                    </div>
                                    <div className="text-primary-400 mt-2 text-xs">
                                        {formatSchedule(job)}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </Card>

                    {selectedJob ? (
                        <Card variant="bordered" className="min-w-0 space-y-4 p-4">
                            {actionError ? (
                                <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                    {actionError}
                                </p>
                            ) : null}

                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                    <CardTitle className="text-lg">
                                        {selectedJob.name}
                                    </CardTitle>
                                    <p className="text-primary-400 mt-1 text-sm">
                                        {selectedJob.description}
                                    </p>
                                    <p className="text-primary-500 mt-1 text-xs break-all">
                                        {selectedJob.id}
                                    </p>
                                </div>
                                <Badge
                                    variant={statusVariant(selectedJob.lastRun?.status)}
                                >
                                    {selectedJob.lastRun?.status ?? "never run"}
                                </Badge>
                            </div>

                            <div className="border-primary-700 bg-primary-900/40 grid gap-3 rounded-lg border p-3 md:grid-cols-3">
                                <div>
                                    <div className="text-primary-400 text-xs">Action</div>
                                    <div className="text-primary-100 mt-1 text-sm break-all">
                                        {selectedJob.actionType}:{" "}
                                        {selectedJob.actionTarget}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-primary-400 text-xs">
                                        Next run
                                    </div>
                                    <div className="text-primary-100 mt-1 text-sm">
                                        {selectedJob.nextRunAt
                                            ? formatDate(new Date(selectedJob.nextRunAt))
                                            : "Not scheduled"}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-primary-400 text-xs">
                                        Last run
                                    </div>
                                    <div className="text-primary-100 mt-1 text-sm">
                                        {selectedJob.lastRun
                                            ? formatDate(
                                                  new Date(selectedJob.lastRun.startedAt)
                                              )
                                            : "Never"}
                                    </div>
                                </div>
                            </div>

                            <div className="border-primary-700 bg-primary-900/40 space-y-3 rounded-lg border p-3">
                                <Switch
                                    checked={selectedJob.enabled}
                                    onChange={(enabled) => {
                                        void toggleSelected(enabled);
                                    }}
                                    label="Enabled"
                                    description="Disabled jobs can still be run manually."
                                    disabled={updateJob.isPending}
                                />
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr_auto]">
                                    <Select
                                        value={scheduleTypeDraft}
                                        onChange={(value) =>
                                            setScheduleTypeDraft(
                                                value === "daily" ? "daily" : "interval"
                                            )
                                        }
                                        options={[...SCHEDULE_TYPE_OPTIONS]}
                                        ariaLabel="Schedule type"
                                        width="w-full"
                                    />
                                    {scheduleTypeDraft === "daily" ? (
                                        <Input
                                            label="Time of day"
                                            value={timeOfDayDraft}
                                            onChange={(event) =>
                                                setTimeOfDayDraft(event.target.value)
                                            }
                                            placeholder="HH:mm"
                                        />
                                    ) : (
                                        <Input
                                            label="Interval seconds"
                                            value={intervalDraft}
                                            onChange={(event) =>
                                                setIntervalDraft(event.target.value)
                                            }
                                            inputMode="numeric"
                                        />
                                    )}
                                    <Button
                                        className="self-end"
                                        variant="secondary"
                                        disabled={
                                            isCronSchedule ||
                                            !scheduleIsValid ||
                                            updateJob.isPending
                                        }
                                        onClick={() => {
                                            void saveSchedule();
                                        }}
                                    >
                                        <Save className="h-4 w-4" />
                                        Save schedule
                                    </Button>
                                </div>
                                {scheduleTypeDraft === "interval" && !intervalIsValid ? (
                                    <p className="text-xs text-red-400">
                                        Interval must be an integer of at least 60
                                        seconds.
                                    </p>
                                ) : null}
                                {scheduleTypeDraft === "daily" && !timeOfDayIsValid ? (
                                    <p className="text-xs text-red-400">
                                        Time of day must use HH:mm, for example 02:40.
                                    </p>
                                ) : null}
                                {isCronSchedule ? (
                                    <p className="text-primary-400 text-xs">
                                        Cron schedules are read-only in the dashboard.
                                    </p>
                                ) : null}
                            </div>

                            <div className="flex flex-col gap-2 sm:flex-row">
                                <Button
                                    onClick={() => {
                                        void runSelected();
                                    }}
                                    disabled={selectedJob.isRunning || runJob.isPending}
                                >
                                    <Play className="h-4 w-4" />
                                    {selectedJob.isRunning || runJob.isPending
                                        ? "Running..."
                                        : "Run now"}
                                </Button>
                            </div>

                            {selectedJob.lastRun ? (
                                <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                                    <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
                                        Last run output
                                    </div>
                                    <p className="text-primary-300 mb-2 text-sm">
                                        {selectedJob.lastRun.message || "No message"}
                                    </p>
                                    <pre className="text-primary-100 max-h-72 overflow-auto rounded-lg bg-black/40 p-3 text-xs">
                                        {JSON.stringify(
                                            selectedJob.lastRun.output,
                                            null,
                                            2
                                        )}
                                    </pre>
                                </div>
                            ) : null}
                        </Card>
                    ) : null}
                </div>
            </div>
        </PageState>
    );
}
