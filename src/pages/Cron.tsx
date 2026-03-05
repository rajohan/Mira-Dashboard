import { Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import { Switch } from "../components/ui/Switch";
import { Textarea } from "../components/ui/Textarea";
import {
    useCronJobs,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "../hooks";
import type { CronJob } from "../hooks";
import { formatDate } from "../utils/format";

function getJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

function getJobName(job: CronJob): string {
    return String(job.name || getJobId(job) || "Unnamed job");
}

function sortJobs(jobs: CronJob[]): CronJob[] {
    return [...jobs].sort((a, b) => {
        const enabledA = a.enabled === false ? 1 : 0;
        const enabledB = b.enabled === false ? 1 : 0;
        if (enabledA !== enabledB) {
            return enabledA - enabledB;
        }

        return getJobName(a).localeCompare(getJobName(b));
    });
}

function getStateValue(job: CronJob, key: string): unknown {
    const state = job.state;
    if (!state || typeof state !== "object") {
        return undefined;
    }

    return (state as Record<string, unknown>)[key];
}

function formatTimestamp(value: unknown): string {
    if (typeof value !== "number") {
        return "—";
    }

    return formatDate(value);
}

function formatLastStatus(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        return "UNKNOWN";
    }

    return value.toUpperCase();
}

function getStatusVariant(value: string): "success" | "warning" | "error" | "default" {
    const normalized = value.toLowerCase();
    if (normalized === "ok" || normalized === "success") {
        return "success";
    }

    if (normalized === "running") {
        return "warning";
    }

    if (normalized === "error" || normalized === "failed") {
        return "error";
    }

    return "default";
}

export function Cron() {
    const { data: jobs = [], isLoading, error, refetch } = useCronJobs();
    const toggleJob = useToggleCronJob();
    const runNow = useRunCronJobNow();
    const updateJob = useUpdateCronJob();

    const sortedJobs = useMemo(() => sortJobs(jobs), [jobs]);
    const [selectedJobId, setSelectedJobId] = useState<string>("");
    const [lastRunAt, setLastRunAt] = useState<Record<string, number>>({});
    const [nameDraft, setNameDraft] = useState("");
    const [scheduleDraft, setScheduleDraft] = useState("{}");
    const [payloadDraft, setPayloadDraft] = useState("{}");
    const [deliveryDraft, setDeliveryDraft] = useState("{}");
    const [editError, setEditError] = useState<string | null>(null);
    const [isEditMode, setIsEditMode] = useState(false);

    const selectedJob = sortedJobs.find((job) => getJobId(job) === selectedJobId) || null;
    const selectedId = selectedJob ? getJobId(selectedJob) : "";

    const currentJob = selectedJob || sortedJobs[0] || null;

    useEffect(() => {
        if (!currentJob) {
            return;
        }

        setNameDraft(String(currentJob.name || ""));
        setScheduleDraft(JSON.stringify(currentJob.schedule || {}, null, 2));
        setPayloadDraft(JSON.stringify(currentJob.payload || {}, null, 2));
        setDeliveryDraft(JSON.stringify(currentJob.delivery || {}, null, 2));
        setEditError(null);
        setIsEditMode(false);
    }, [currentJob]);

    async function handleToggle(job: CronJob, enabled: boolean) {
        const id = getJobId(job);
        if (!id) {
            return;
        }

        await toggleJob.mutateAsync({ id, enabled });
    }

    async function handleRunNow(job: CronJob) {
        const id = getJobId(job);
        if (!id) {
            return;
        }

        await runNow.mutateAsync({ id });
        setLastRunAt((prev) => ({
            ...prev,
            [id]: Date.now(),
        }));
    }

    async function handleSaveEdits(job: CronJob) {
        const id = getJobId(job);
        if (!id) {
            return;
        }

        try {
            const patch = {
                name: nameDraft.trim() || undefined,
                schedule: JSON.parse(scheduleDraft),
                payload: JSON.parse(payloadDraft),
                delivery: JSON.parse(deliveryDraft),
            };

            await updateJob.mutateAsync({ id, patch });
            setEditError(null);
        } catch (error) {
            setEditError(error instanceof Error ? error.message : "Invalid JSON in edit fields");
        }
    }

    return (
        <PageState
            isLoading={isLoading}
            loading={<LoadingState size="lg" />}
            error={error?.message ?? null}
            errorView={
                <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6">
                    <p className="text-red-400">{error?.message}</p>
                    <Button variant="secondary" onClick={() => void refetch()}>
                        Retry
                    </Button>
                </div>
            }
            isEmpty={sortedJobs.length === 0}
            empty={
                <div className="p-6">
                    <Card variant="bordered">
                        <CardTitle>No cron jobs found</CardTitle>
                        <p className="mt-2 text-sm text-primary-300">
                            Create jobs first, then manage them here.
                        </p>
                    </Card>
                </div>
            }
        >
            <div className="space-y-4 p-6">
                <div className="flex items-center justify-end">
                    <Button variant="secondary" size="sm" onClick={() => void refetch()}>
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </Button>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
                    <Card variant="bordered" className="p-0">
                        <div className="border-b border-primary-700 px-4 py-3 text-sm font-semibold text-primary-200">
                            Cron jobs
                        </div>
                        <div className="max-h-[70vh] overflow-auto p-2">
                            {sortedJobs.map((job) => {
                                const id = getJobId(job);
                                const isSelected = id === selectedId || (!selectedId && currentJob && id === getJobId(currentJob));

                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => setSelectedJobId(id)}
                                        className={[
                                            "mb-2 w-full rounded-lg border px-3 py-2 text-left transition",
                                            isSelected
                                                ? "border-accent-500 bg-accent-500/10"
                                                : "border-primary-700 bg-primary-800/40 hover:border-primary-500",
                                        ].join(" ")}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="truncate text-sm font-medium text-primary-100">
                                                {getJobName(job)}
                                            </div>
                                            <Badge variant={job.enabled === false ? "warning" : "success"}>
                                                {job.enabled === false ? "Disabled" : "Enabled"}
                                            </Badge>
                                        </div>
                                        <div className="mt-1 truncate text-xs text-primary-400">{id}</div>
                                        <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-primary-400">
                                            <span>Last: {formatTimestamp(getStateValue(job, "lastRunAtMs"))}</span>
                                            <span>Next: {formatTimestamp(getStateValue(job, "nextRunAtMs"))}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </Card>

                    {currentJob && (
                        <Card variant="bordered" className="space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <CardTitle className="text-base">{getJobName(currentJob)}</CardTitle>
                                    <p className="mt-1 text-xs text-primary-400">{getJobId(currentJob)}</p>
                                </div>
                                <Badge variant={currentJob.enabled === false ? "warning" : "success"}>
                                    {currentJob.enabled === false ? "Disabled" : "Enabled"}
                                </Badge>
                            </div>

                            <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                    Controls
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <Switch
                                        checked={currentJob.enabled !== false}
                                        onChange={(enabled) => {
                                            void handleToggle(currentJob, enabled);
                                        }}
                                        label="Enabled"
                                        disabled={toggleJob.isPending}
                                    />
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        disabled={runNow.isPending}
                                        onClick={() => {
                                            void handleRunNow(currentJob);
                                        }}
                                    >
                                        <Play className="h-4 w-4" />
                                        Trigger now
                                    </Button>
                                    {lastRunAt[getJobId(currentJob)] && (
                                        <span className="text-xs text-primary-400">
                                            Triggered {formatDate(lastRunAt[getJobId(currentJob)])}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                    Last / next run
                                </div>
                                <div className="grid grid-cols-1 gap-3 text-sm text-primary-200 lg:grid-cols-3">
                                    <div>
                                        <div className="text-xs text-primary-400">Last run</div>
                                        <div>{formatTimestamp(getStateValue(currentJob, "lastRunAtMs"))}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-primary-400">Next run</div>
                                        <div>{formatTimestamp(getStateValue(currentJob, "nextRunAtMs"))}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-primary-400">Last status</div>
                                        <div className="mt-1">
                                            <Badge
                                                variant={getStatusVariant(
                                                    formatLastStatus(getStateValue(currentJob, "lastRunStatus"))
                                                )}
                                            >
                                                {formatLastStatus(getStateValue(currentJob, "lastRunStatus"))}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-primary-300">
                                        Job config
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {isEditMode ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                onClick={() => {
                                                    setIsEditMode(false);
                                                    setEditError(null);
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                        ) : null}
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            disabled={updateJob.isPending}
                                            onClick={() => {
                                                if (isEditMode) {
                                                    void handleSaveEdits(currentJob);
                                                    return;
                                                }

                                                setIsEditMode(true);
                                            }}
                                        >
                                            {isEditMode ? "Save edits" : "Edit"}
                                        </Button>
                                    </div>
                                </div>

                                {editError && <p className="text-xs text-red-400">{editError}</p>}

                                {isEditMode ? (
                                    <>
                                        <div>
                                            <label className="mb-1 block text-xs text-primary-300">Name</label>
                                            <Input
                                                value={nameDraft}
                                                onChange={(event) => setNameDraft(event.target.value)}
                                                placeholder="Job name"
                                            />
                                        </div>

                                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                                            <div>
                                                <label className="mb-1 block text-xs text-primary-300">Schedule (JSON)</label>
                                                <Textarea
                                                    className="h-48 font-mono text-xs"
                                                    value={scheduleDraft}
                                                    onChange={(event) => setScheduleDraft(event.target.value)}
                                                />
                                            </div>
                                            <div>
                                                <label className="mb-1 block text-xs text-primary-300">Payload (JSON)</label>
                                                <Textarea
                                                    className="h-48 font-mono text-xs"
                                                    value={payloadDraft}
                                                    onChange={(event) => setPayloadDraft(event.target.value)}
                                                />
                                            </div>
                                            <div>
                                                <label className="mb-1 block text-xs text-primary-300">Delivery (JSON)</label>
                                                <Textarea
                                                    className="h-48 font-mono text-xs"
                                                    value={deliveryDraft}
                                                    onChange={(event) => setDeliveryDraft(event.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                                        <Card className="bg-primary-900/40">
                                            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                                Schedule
                                            </div>
                                            <pre className="whitespace-pre-wrap break-words text-xs text-primary-200">
                                                {JSON.stringify(currentJob.schedule || {}, null, 2)}
                                            </pre>
                                        </Card>
                                        <Card className="bg-primary-900/40">
                                            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                                Payload
                                            </div>
                                            <pre className="whitespace-pre-wrap break-words text-xs text-primary-200">
                                                {JSON.stringify(currentJob.payload || {}, null, 2)}
                                            </pre>
                                        </Card>
                                        <Card className="bg-primary-900/40">
                                            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary-300">
                                                Delivery
                                            </div>
                                            <pre className="whitespace-pre-wrap break-words text-xs text-primary-200">
                                                {JSON.stringify(currentJob.delivery || {}, null, 2)}
                                            </pre>
                                        </Card>
                                    </div>
                                )}
                            </div>
                        </Card>
                    )}
                </div>
            </div>
        </PageState>
    );
}
