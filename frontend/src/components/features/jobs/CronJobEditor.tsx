import { useState } from "react";

import type { CronJob } from "../../../../../contracts/cron";
import { messageFromError } from "../../../lib/errorMessage";
import { formatDate } from "../../../utils/format";
import { validateJsonString } from "../../../utils/json";
import { CronJobDetails } from "../cron";

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
