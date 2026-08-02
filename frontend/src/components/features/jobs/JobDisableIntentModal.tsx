import { useState } from "react";

import type { JobDisableIntent } from "../../../../../contracts/jobs/scheduled";
import { Button } from "../../ui/Button";
import { DateTimePicker } from "../../ui/DateTimePicker";
import { Modal } from "../../ui/Modal";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import {
    type DisableCandidate,
    type DisableMode,
    disableModeOptions,
    disableUntilDraftForCandidate,
    parseDisableUntilDraft,
} from "./jobDisableIntentModel";

interface JobDisableIntentModalProperties {
    candidate: DisableCandidate;
    isPending: boolean;
    onCancel: () => void;
    onSubmit: (intent: JobDisableIntent) => Promise<void>;
}

/**
 * Collects and validates the annotation for an intentional job disable.
 * @param properties Disable candidate, mutation state, and callbacks.
 * @returns Rendered disable-intent modal.
 */
export function JobDisableIntentModal({
    candidate,
    isPending,
    onCancel,
    onSubmit,
}: JobDisableIntentModalProperties) {
    const [mode, setMode] = useState<DisableMode>(
        candidate.job.disableIntent?.mode ?? "until"
    );
    const [comment, setComment] = useState(candidate.job.disableIntent?.comment ?? "");
    const [until, setUntil] = useState(() => disableUntilDraftForCandidate(candidate));
    const [commentError, setCommentError] = useState<string | undefined>();
    const [untilError, setUntilError] = useState<string | undefined>();

    const linkedTaskCount =
        candidate.kind === "cron" ? (candidate.job.taskLinks?.length ?? 0) : 0;
    const linkedTaskNotice =
        linkedTaskCount > 0
            ? ` It is linked to ${linkedTaskCount} open task${linkedTaskCount === 1 ? "" : "s"}.`
            : "";
    let actionLabel = "Disable job";
    if (isPending) actionLabel = "Saving...";
    else if (candidate.job.enabled === false) actionLabel = "Save disabled state";

    async function submit(): Promise<void> {
        setCommentError(undefined);
        setUntilError(undefined);
        const normalizedComment = comment.trim();
        if (!normalizedComment) {
            setCommentError("A comment is required for an intentional disable.");
            return;
        }

        if (mode === "indefinite") {
            await onSubmit({ mode: "indefinite", comment: normalizedComment });
            return;
        }

        const untilTimestamp = parseDisableUntilDraft(until);
        if (untilTimestamp === undefined || untilTimestamp <= Date.now()) {
            setUntilError("Choose a future date and time.");
            return;
        }
        await onSubmit({
            mode: "until",
            comment: normalizedComment,
            until: new Date(untilTimestamp).toISOString(),
        });
    }

    return (
        <Modal
            isOpen
            title={
                candidate.job.enabled === false ? "Edit disabled state" : "Disable job"
            }
            onClose={() => {
                if (!isPending) onCancel();
            }}
        >
            <div className="space-y-4">
                <p className="text-sm text-primary-300">
                    Heartbeat will treat this{" "}
                    {candidate.kind === "scheduled"
                        ? "Dashboard job"
                        : "OpenClaw cron job"}{" "}
                    as intentionally disabled while this annotation is active.
                    {linkedTaskNotice}
                </p>
                <Select
                    ariaLabel="Disabled duration"
                    value={mode}
                    options={disableModeOptions}
                    onChange={(value) => setMode(value as DisableMode)}
                    width="w-full"
                />
                {mode === "until" ? (
                    <DateTimePicker
                        label="Disabled until"
                        value={until}
                        error={untilError}
                        onChange={setUntil}
                    />
                ) : undefined}
                <Textarea
                    label="Comment"
                    description="Required. Explain why the job is disabled and what should happen before it is enabled again."
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    maxLength={1000}
                    rows={4}
                    error={commentError}
                />
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" disabled={isPending} onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        disabled={isPending}
                        onClick={() => void submit()}
                    >
                        {actionLabel}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
