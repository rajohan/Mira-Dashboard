import { useId, useState } from "react";
import * as v from "valibot";

import {
    type OpenClawCronJob,
    openClawCronDisableReasonSchema,
} from "../../contracts/openClawCron.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { DateTimePicker, type DateTimePickerValue } from "../ui/DateTimePicker.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RadioGroup, type RadioGroupOption } from "../ui/RadioGroup.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { openClawCronUnknownOutcomeMessage } from "./presentation.ts";

type DisableExpiryMode = "indefinite" | "until";

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

const disableExpiryModeOptions = Object.freeze([
    {
        description:
            "Dashboard will enable the OpenClaw job again at this local date and time.",
        label: "Until a date",
        value: "until",
    },
    {
        description: "The job stays disabled until someone enables it.",
        label: "Indefinitely",
        value: "indefinite",
    },
] satisfies readonly RadioGroupOption<DisableExpiryMode>[]);

const minimumDefaultDisableWindowMs = 5 * 60 * 1000;
const defaultDisableFallbackMs = 60 * 60 * 1000;
const timeValuePattern = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

function pickerValueFromTimestamp(timestampMs: number): DateTimePickerValue {
    const date = new Date(timestampMs);
    return {
        date,
        time: `${date.getHours().toString().padStart(2, "0")}:${date
            .getMinutes()
            .toString()
            .padStart(2, "0")}`,
    };
}

function defaultDisableExpiry(nowMs = Date.now()): DateTimePickerValue {
    const endOfToday = new Date(nowMs);
    endOfToday.setHours(23, 59, 0, 0);
    if (endOfToday.getTime() - nowMs >= minimumDefaultDisableWindowMs) {
        return pickerValueFromTimestamp(endOfToday.getTime());
    }

    const fallback = new Date(nowMs + defaultDisableFallbackMs);
    fallback.setSeconds(0, 0);
    return pickerValueFromTimestamp(fallback.getTime());
}

function pickerTimestamp(value: DateTimePickerValue): number | undefined {
    const match = timeValuePattern.exec(value.time);
    const hourText = match?.groups?.hour;
    const minuteText = match?.groups?.minute;
    if (hourText === undefined || minuteText === undefined) return;

    const year = value.date.getFullYear();
    const month = value.date.getMonth();
    const day = value.date.getDate();
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(hour, minute, 0, 0);
    const timestamp = date.getTime();
    if (
        !Number.isSafeInteger(timestamp) ||
        date.getFullYear() !== year ||
        date.getMonth() !== month ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute
    ) {
        return;
    }
    return timestamp;
}

function pickerMatchesTimestamp(
    value: DateTimePickerValue,
    timestampMs: number
): boolean {
    const timestampValue = pickerValueFromTimestamp(timestampMs);
    return (
        value.date.getFullYear() === timestampValue.date.getFullYear() &&
        value.date.getMonth() === timestampValue.date.getMonth() &&
        value.date.getDate() === timestampValue.date.getDate() &&
        value.time === timestampValue.time
    );
}

function startOfToday(): Date {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
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
    const existingExpiryMs = job.synchronization.disableIntent?.expiresAtMs;
    const [expiryMode, setExpiryMode] = useState<DisableExpiryMode>(() =>
        existingExpiryMs === undefined ? "indefinite" : "until"
    );
    const [expiry, setExpiry] = useState<DateTimePickerValue>(() =>
        existingExpiryMs === undefined
            ? defaultDisableExpiry()
            : pickerValueFromTimestamp(existingExpiryMs)
    );
    const [reasonError, setReasonError] = useState<string>();
    const [expiryError, setExpiryError] = useState<string>();

    async function submit(): Promise<void> {
        if (reconciliationBlocked || reconciliationBusy) return;
        const parsedReason = v.safeParse(openClawCronDisableReasonSchema, reason);
        let expiresAtMs: number | undefined;
        if (expiryMode === "until") {
            expiresAtMs =
                existingExpiryMs !== undefined &&
                pickerMatchesTimestamp(expiry, existingExpiryMs)
                    ? existingExpiryMs
                    : pickerTimestamp(expiry);
        }
        const nextReasonError = parsedReason.success
            ? undefined
            : "Use 1–1000 visible characters without control characters.";
        const nextExpiryError =
            expiryMode === "until" &&
            (expiresAtMs === undefined || expiresAtMs <= Date.now())
                ? "Choose a future date and time."
                : undefined;
        setReasonError(nextReasonError);
        setExpiryError(nextExpiryError);
        if (!parsedReason.success || nextExpiryError !== undefined) {
            setTimeout(() => {
                document
                    .querySelector<HTMLElement>(`[id="${formId}"]`)
                    ?.querySelector<HTMLElement>(
                        "[data-invalid]:is(button, input, textarea)"
                    )
                    ?.focus();
            }, 0);
            return;
        }

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
                    : "This job could not be disabled. Refresh and try again."
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
            title={<span className="wrap-anywhere">Disable {job.name}</span>}
        >
            <Form
                aria-label="Disable OpenClaw scheduled job"
                id={formId}
                onSubmit={submit}
            >
                <Alert className="mb-4" message={error} />
                <Alert className="mb-4" message={reconciliationError} />
                <p className="text-primary-300 mb-4 text-sm leading-6">
                    Dashboard saves the requested change and then asks OpenClaw to apply
                    it. The status shows Updating or Needs attention until both agree.
                </p>
                {job.dashboardOpenLinkedTask !== undefined && (
                    <div className="border-primary-700 bg-primary-900/40 mb-4 max-w-full min-w-0 rounded-lg border p-3">
                        <p className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            Linked Dashboard task
                        </p>
                        <p className="text-primary-100 mt-1 max-w-full text-sm font-medium wrap-anywhere">
                            {job.dashboardOpenLinkedTask.title}
                        </p>
                        <p className="text-primary-400 mt-1 max-w-full text-xs wrap-anywhere">
                            Status: {job.dashboardOpenLinkedTask.status}. Disabling the
                            OpenClaw job does not close this Dashboard task.
                        </p>
                    </div>
                )}
                <div className="grid gap-4">
                    <RadioGroup
                        disabled={busy || reconciliationBlocked || reconciliationBusy}
                        label="Disabled duration"
                        onChange={(nextMode) => {
                            setExpiryMode(nextMode);
                            setExpiryError(undefined);
                        }}
                        options={disableExpiryModeOptions}
                        orientation="horizontal"
                        value={expiryMode}
                    />
                    {expiryMode === "until" && (
                        <DateTimePicker
                            disabled={busy || reconciliationBlocked || reconciliationBusy}
                            error={expiryError}
                            label="Disabled until"
                            minimumDate={startOfToday()}
                            onChange={(nextExpiry) => {
                                setExpiry(nextExpiry);
                                setExpiryError(undefined);
                            }}
                            value={expiry}
                        />
                    )}
                    <FormField
                        error={reasonError}
                        label="Disable reason"
                        description="Required. Explain why this job is being disabled."
                    >
                        <Textarea
                            disabled={busy || reconciliationBlocked || reconciliationBusy}
                            maxLength={1000}
                            onChange={(event) => {
                                setReason(event.target.value);
                                setReasonError(undefined);
                            }}
                            placeholder="Paused during database maintenance"
                            value={reason}
                        />
                    </FormField>
                </div>
                <div className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                    <Button
                        className="w-full sm:w-auto"
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
                            className="w-full sm:w-auto"
                            onClick={() => void onReconcile()}
                            type="button"
                            variant="secondary"
                        >
                            Refresh current status
                        </Button>
                    )}
                    <Button
                        busy={busy}
                        busyLabel="Saving…"
                        className="w-full sm:w-auto"
                        disabled={busy || reconciliationBlocked || reconciliationBusy}
                        type="submit"
                        variant="danger"
                    >
                        Disable job
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
