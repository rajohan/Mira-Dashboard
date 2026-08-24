import { useId, useState } from "react";
import * as v from "valibot";

import {
    type OpenClawCronJob,
    openClawCronDisableReasonSchema,
} from "../../contracts/openClawCron.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { openClawCronUnknownOutcomeMessage } from "./presentation.ts";

export interface OpenClawCronDisableDraft {
    readonly expiresAtMs?: number;
    readonly reason: string;
}

interface OpenClawCronDisableDialogProps {
    readonly job: OpenClawCronJob;
    readonly onClose: () => void;
    readonly onReconcile?: () => Promise<void>;
    readonly onSubmit: (draft: OpenClawCronDisableDraft) => Promise<void>;
    readonly reconciliationBlocked?: boolean;
    readonly reconciliationBusy?: boolean;
    readonly reconciliationError?: string;
}

function localDateTimeValue(timestampMs: number | undefined): string {
    if (timestampMs === undefined) return "";
    const date = new Date(timestampMs);
    const local = new Date(timestampMs - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

/** @returns Explicit reason and optional expiry boundary for disabling OpenClaw cron. */
export function OpenClawCronDisableDialog({
    job,
    onClose,
    onReconcile,
    onSubmit,
    reconciliationBlocked = false,
    reconciliationBusy = false,
    reconciliationError,
}: OpenClawCronDisableDialogProps) {
    const formId = useId();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [reason, setReason] = useState(job.synchronization.disableIntent?.reason ?? "");
    const [expiresAt, setExpiresAt] = useState(() =>
        localDateTimeValue(job.synchronization.disableIntent?.expiresAtMs)
    );
    const [reasonError, setReasonError] = useState<string>();
    const [expiryError, setExpiryError] = useState<string>();

    async function submit(): Promise<void> {
        if (reconciliationBlocked || reconciliationBusy) return;
        const parsedReason = v.safeParse(openClawCronDisableReasonSchema, reason);
        const expiresAtMs =
            expiresAt.length === 0 ? undefined : new Date(expiresAt).getTime();
        const nextReasonError = parsedReason.success
            ? undefined
            : "Use 1–1000 visible characters without control characters.";
        const nextExpiryError =
            expiresAtMs !== undefined &&
            (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())
                ? "Choose a future date and time, or leave this blank for no expiry."
                : undefined;
        setReasonError(nextReasonError);
        setExpiryError(nextExpiryError);
        if (!parsedReason.success || nextExpiryError !== undefined) return;

        setBusy(true);
        setError(undefined);
        try {
            await onSubmit({
                ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
                reason: parsedReason.output,
            });
            onClose();
        } catch (error) {
            setError(
                isDashboardOperationOutcomeUnknown(error)
                    ? openClawCronUnknownOutcomeMessage
                    : "The desired disabled state could not be saved. Refresh and try again."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            dismissible={!busy && !reconciliationBusy}
            onClose={onClose}
            open
            title={`Disable ${job.name}`}
        >
            <Form aria-label="Disable OpenClaw cron job" id={formId} onSubmit={submit}>
                <Alert className="mb-4" message={error} />
                <Alert className="mb-4" message={reconciliationError} />
                <p className="text-primary-300 mb-4 text-sm leading-6">
                    This records Dashboard operator intent separately from the
                    Gateway-owned enabled state. The section will show pending or conflict
                    until readback confirms both agree.
                </p>
                {job.dashboardOpenLinkedTask !== undefined && (
                    <div className="border-primary-700 bg-primary-900/40 mb-4 rounded-lg border p-3">
                        <p className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            Dashboard open linked task
                        </p>
                        <p className="text-primary-100 mt-1 text-sm font-medium">
                            {job.dashboardOpenLinkedTask.title}
                        </p>
                        <p className="text-primary-400 mt-1 text-xs">
                            Status: {job.dashboardOpenLinkedTask.status}. This
                            relationship comes from the Dashboard task database, not the
                            OpenClaw Gateway. Disabling the cron job does not close the
                            task.
                        </p>
                    </div>
                )}
                <div className="grid gap-4">
                    <FormField
                        error={reasonError}
                        label="Disable reason"
                        description="Required operator annotation."
                    >
                        <Textarea
                            disabled={busy || reconciliationBlocked || reconciliationBusy}
                            maxLength={1000}
                            onChange={(event) => {
                                setReason(event.target.value);
                                setReasonError(undefined);
                            }}
                            value={reason}
                        />
                    </FormField>
                    <FormField
                        error={expiryError}
                        label="Disabled until"
                        description="Optional. Leave blank to keep the desired state disabled indefinitely."
                    >
                        <Input
                            disabled={busy || reconciliationBlocked || reconciliationBusy}
                            onChange={(event) => {
                                setExpiresAt(event.target.value);
                                setExpiryError(undefined);
                            }}
                            type="datetime-local"
                            value={expiresAt}
                        />
                    </FormField>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                    <Button
                        disabled={busy || reconciliationBusy}
                        onClick={onClose}
                        type="button"
                        variant="secondary"
                    >
                        Cancel
                    </Button>
                    {reconciliationBlocked && onReconcile !== undefined && (
                        <Button
                            busy={reconciliationBusy}
                            busyLabel="Refreshing…"
                            onClick={() => void onReconcile()}
                            type="button"
                            variant="secondary"
                        >
                            Refresh authoritative state
                        </Button>
                    )}
                    <Button
                        busy={busy}
                        busyLabel="Saving…"
                        disabled={busy || reconciliationBlocked || reconciliationBusy}
                        type="submit"
                        variant="danger"
                    >
                        Save disabled state
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
