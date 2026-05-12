import { Play } from "lucide-react";

import type { CronJob } from "../../../hooks";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
} from "../../../utils/cronUtils";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { Input } from "../../ui/Input";
import { Switch } from "../../ui/Switch";
import { Textarea } from "../../ui/Textarea";

/** Represents JSON valIDation state. */
interface JsonValidationState {
    valid: boolean;
    error: string | null;
}

/** Provides props for cron job details. */
interface CronJobDetailsProps {
    job: CronJob;
    lastTriggeredAt?: number;
    togglePending: boolean;
    runPending: boolean;
    updatePending: boolean;
    onToggle: (job: CronJob, enabled: boolean) => void;
    onRunNow: (job: CronJob) => void;
    isEditMode: boolean;
    onEditModeChange: (enabled: boolean) => void;
    nameDraft: string;
    onNameDraftChange: (value: string) => void;
    scheduleDraft: string;
    onScheduleDraftChange: (value: string) => void;
    payloadDraft: string;
    onPayloadDraftChange: (value: string) => void;
    deliveryDraft: string;
    onDeliveryDraftChange: (value: string) => void;
    scheduleValidation: JsonValidationState;
    payloadValidation: JsonValidationState;
    deliveryValidation: JsonValidationState;
    hasInvalidJson: boolean;
    editError: string | null;
    onSave: (job: CronJob) => void;
    formatDate: (value: number) => string;
}

/** Renders the cron job details UI. */
export function CronJobDetails({
    job,
    lastTriggeredAt,
    togglePending,
    runPending,
    updatePending,
    onToggle,
    onRunNow,
    isEditMode,
    onEditModeChange,
    nameDraft,
    onNameDraftChange,
    scheduleDraft,
    onScheduleDraftChange,
    payloadDraft,
    onPayloadDraftChange,
    deliveryDraft,
    onDeliveryDraftChange,
    scheduleValidation,
    payloadValidation,
    deliveryValidation,
    hasInvalidJson,
    editError,
    onSave,
    formatDate,
}: CronJobDetailsProps) {
    return (
        <Card variant="bordered" className="min-w-0 space-y-3 p-3 sm:space-y-4 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <CardTitle className="text-base">{getCronJobName(job)}</CardTitle>
                    <p className="text-primary-400 mt-1 text-xs break-all">
                        {getCronJobId(job)}
                    </p>
                </div>
                <Badge
                    className="shrink-0"
                    variant={job.enabled === false ? "warning" : "success"}
                >
                    {job.enabled === false ? "Disabled" : "Enabled"}
                </Badge>
            </div>

            <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
                    Controls
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Switch
                        checked={job.enabled !== false}
                        onChange={(enabled) => onToggle(job, enabled)}
                        label="Enabled"
                        disabled={togglePending}
                        className="border-primary-700 bg-primary-800/60 rounded-lg border px-3 py-2 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0"
                    />
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={runPending}
                        onClick={() => onRunNow(job)}
                        className="w-full sm:w-auto"
                    >
                        <Play
                            className={[
                                "h-4 w-4",
                                runPending ? "animate-pulse" : "",
                            ].join(" ")}
                        />
                        {runPending ? "Triggering..." : "Trigger now"}
                    </Button>
                    {runPending ? (
                        <span className="text-primary-400 text-xs">Running job...</span>
                    ) : lastTriggeredAt ? (
                        <span className="text-primary-400 text-xs">
                            Triggered {formatDate(lastTriggeredAt)}
                        </span>
                    ) : null}
                </div>
            </div>

            <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
                <div className="text-primary-300 mb-2 text-xs font-semibold tracking-wide uppercase">
                    Last / next run
                </div>
                <div className="text-primary-200 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                    <div>
                        <div className="text-primary-400 text-xs">Last run</div>
                        <div>
                            {formatCronTimestamp(getCronStateValue(job, "lastRunAtMs"))}
                        </div>
                    </div>
                    <div>
                        <div className="text-primary-400 text-xs">Next run</div>
                        <div>
                            {formatCronTimestamp(getCronStateValue(job, "nextRunAtMs"))}
                        </div>
                    </div>
                    <div>
                        <div className="text-primary-400 text-xs">Last status</div>
                        <div className="mt-1">
                            <Badge
                                variant={getCronStatusVariant(
                                    formatCronLastStatus(
                                        getCronStateValue(job, "lastRunStatus")
                                    )
                                )}
                            >
                                {formatCronLastStatus(
                                    getCronStateValue(job, "lastRunStatus")
                                )}
                            </Badge>
                        </div>
                    </div>
                </div>
            </div>

            <div className="border-primary-700 bg-primary-900/40 space-y-3 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="text-primary-300 text-xs font-semibold tracking-wide uppercase">
                        Job config
                    </div>
                    <div className="flex items-center gap-2">
                        {isEditMode ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => onEditModeChange(false)}
                                className="px-3"
                            >
                                Cancel
                            </Button>
                        ) : null}
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={updatePending || (isEditMode && hasInvalidJson)}
                            className="px-3"
                            onClick={() => {
                                if (isEditMode) {
                                    onSave(job);
                                    return;
                                }

                                onEditModeChange(true);
                            }}
                        >
                            {isEditMode ? "Save edits" : "Edit"}
                        </Button>
                    </div>
                </div>

                {editError ? <p className="text-xs text-red-400">{editError}</p> : null}

                {isEditMode ? (
                    <>
                        <div>
                            <label className="text-primary-300 mb-1 block text-xs">
                                Name
                            </label>
                            <Input
                                value={nameDraft}
                                onChange={(event) =>
                                    onNameDraftChange(event.target.value)
                                }
                                placeholder="Job name"
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                            <div>
                                <label className="text-primary-300 mb-1 block text-xs">
                                    Schedule (JSON)
                                </label>
                                <Textarea
                                    className="h-40 font-mono text-xs sm:h-48"
                                    value={scheduleDraft}
                                    onChange={(event) =>
                                        onScheduleDraftChange(event.target.value)
                                    }
                                />
                                <p
                                    className={
                                        scheduleValidation.valid
                                            ? "mt-1 text-xs text-green-400"
                                            : "mt-1 text-xs text-red-400"
                                    }
                                >
                                    {scheduleValidation.valid
                                        ? "Valid JSON"
                                        : `Invalid JSON: ${scheduleValidation.error || "parse error"}`}
                                </p>
                            </div>
                            <div>
                                <label className="text-primary-300 mb-1 block text-xs">
                                    Payload (JSON)
                                </label>
                                <Textarea
                                    className="h-40 font-mono text-xs sm:h-48"
                                    value={payloadDraft}
                                    onChange={(event) =>
                                        onPayloadDraftChange(event.target.value)
                                    }
                                />
                                <p
                                    className={
                                        payloadValidation.valid
                                            ? "mt-1 text-xs text-green-400"
                                            : "mt-1 text-xs text-red-400"
                                    }
                                >
                                    {payloadValidation.valid
                                        ? "Valid JSON"
                                        : `Invalid JSON: ${payloadValidation.error || "parse error"}`}
                                </p>
                            </div>
                            <div>
                                <label className="text-primary-300 mb-1 block text-xs">
                                    Delivery (JSON)
                                </label>
                                <Textarea
                                    className="h-40 font-mono text-xs sm:h-48"
                                    value={deliveryDraft}
                                    onChange={(event) =>
                                        onDeliveryDraftChange(event.target.value)
                                    }
                                />
                                <p
                                    className={
                                        deliveryValidation.valid
                                            ? "mt-1 text-xs text-green-400"
                                            : "mt-1 text-xs text-red-400"
                                    }
                                >
                                    {deliveryValidation.valid
                                        ? "Valid JSON"
                                        : `Invalid JSON: ${deliveryValidation.error || "parse error"}`}
                                </p>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                        <Card className="bg-primary-900/40 min-w-0 p-3 sm:p-4">
                            <div className="text-primary-300 mb-1 text-xs font-semibold tracking-wide uppercase">
                                Schedule
                            </div>
                            <pre className="text-primary-200 text-xs break-words whitespace-pre-wrap">
                                {JSON.stringify(job.schedule || {}, null, 2)}
                            </pre>
                        </Card>
                        <Card className="bg-primary-900/40 min-w-0 p-3 sm:p-4">
                            <div className="text-primary-300 mb-1 text-xs font-semibold tracking-wide uppercase">
                                Payload
                            </div>
                            <pre className="text-primary-200 text-xs break-words whitespace-pre-wrap">
                                {JSON.stringify(job.payload || {}, null, 2)}
                            </pre>
                        </Card>
                        <Card className="bg-primary-900/40 min-w-0 p-3 sm:p-4">
                            <div className="text-primary-300 mb-1 text-xs font-semibold tracking-wide uppercase">
                                Delivery
                            </div>
                            <pre className="text-primary-200 text-xs break-words whitespace-pre-wrap">
                                {JSON.stringify(job.delivery || {}, null, 2)}
                            </pre>
                        </Card>
                    </div>
                )}
            </div>
        </Card>
    );
}
