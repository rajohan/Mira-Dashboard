import { useEffect, useState } from "react";

import { CronJobDetails, CronJobList } from "../components/features/cron";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { PageState } from "../components/ui/PageState";
import {
    useCronJobs,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "../hooks";
import type { CronJob } from "../hooks";
import { formatDate } from "../utils/format";
import { sortCronJobs, getCronJobId } from "../utils/cronUtils";
import { validateJsonString } from "../utils/json";

export function Cron() {
    const { data: jobs = [], isLoading, error, refetch } = useCronJobs();
    const toggleJob = useToggleCronJob();
    const runNow = useRunCronJobNow();
    const updateJob = useUpdateCronJob();

    const sortedJobs = sortCronJobs(jobs);
    const [selectedJobId, setSelectedJobId] = useState<string>("");
    const [lastRunAt, setLastRunAt] = useState<Record<string, number>>({});
    const [nameDraft, setNameDraft] = useState("");
    const [scheduleDraft, setScheduleDraft] = useState("{}");
    const [payloadDraft, setPayloadDraft] = useState("{}");
    const [deliveryDraft, setDeliveryDraft] = useState("{}");
    const [editError, setEditError] = useState<string | null>(null);
    const [isEditMode, setIsEditMode] = useState(false);

    const selectedJob =
        sortedJobs.find((job) => getCronJobId(job) === selectedJobId) || null;
    const selectedId = selectedJob ? getCronJobId(selectedJob) : "";

    const currentJob = selectedJob || sortedJobs[0] || null;
    const currentJobId = currentJob ? getCronJobId(currentJob) : "";

    const scheduleValidation = validateJsonString(scheduleDraft);
    const payloadValidation = validateJsonString(payloadDraft);
    const deliveryValidation = validateJsonString(deliveryDraft);
    const hasInvalidJson =
        !scheduleValidation.valid || !payloadValidation.valid || !deliveryValidation.valid;

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
        const id = getCronJobId(job);
        if (!id) {
            return;
        }

        await toggleJob.mutateAsync({ id, enabled });
    }

    async function handleRunNow(job: CronJob) {
        const id = getCronJobId(job);
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
        const id = getCronJobId(job);
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
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
                    <CronJobList
                        jobs={sortedJobs}
                        selectedId={selectedId}
                        currentJobId={currentJobId}
                        onSelect={setSelectedJobId}
                    />

                    {currentJob ? (
                        <CronJobDetails
                            job={currentJob}
                            lastTriggeredAt={lastRunAt[currentJobId]}
                            togglePending={toggleJob.isPending}
                            runPending={runNow.isPending}
                            updatePending={updateJob.isPending}
                            onToggle={(job, enabled) => {
                                void handleToggle(job, enabled);
                            }}
                            onRunNow={(job) => {
                                void handleRunNow(job);
                            }}
                            isEditMode={isEditMode}
                            onEditModeChange={(enabled) => {
                                setIsEditMode(enabled);
                                if (!enabled) {
                                    setEditError(null);
                                }
                            }}
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
                            onSave={(job) => {
                                void handleSaveEdits(job);
                            }}
                            formatDate={formatDate}
                        />
                    ) : null}
                </div>
            </div>
        </PageState>
    );
}
