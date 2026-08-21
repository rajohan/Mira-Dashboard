import { useId, useState } from "react";
import * as v from "valibot";

import {
    jobDescriptionMaximumLength,
    type ScheduleSummary,
} from "../../contracts/jobModel.ts";
import { scheduleDisableReasonSchema } from "../../contracts/schedules.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { DateTimePicker, type DateTimePickerValue } from "../ui/DateTimePicker.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RadioGroup, type RadioGroupOption } from "../ui/RadioGroup.tsx";
import { Textarea } from "../ui/Textarea.tsx";

type DisableMode = "indefinite" | "until";

export interface DisableIntentDraft {
    readonly expiresAtMs?: number;
    readonly reason: string;
}

interface DisableIntentSnapshot extends DisableIntentDraft {
    readonly enabled: boolean;
    readonly expectedVersion: number;
}

interface ScheduleDisableIntentModalProps {
    readonly busy: boolean;
    readonly error?: string;
    readonly onClose: () => void;
    readonly onSaved: () => void;
    readonly onSubmit: (
        draft: DisableIntentDraft,
        expectedVersion: number
    ) => Promise<void>;
    readonly schedule: ScheduleSummary;
}

const disableModeOptions = Object.freeze([
    {
        description: "The schedule starts automatically again after this time.",
        label: "Until a date",
        value: "until",
    },
    {
        description: "The schedule stays disabled until you enable it.",
        label: "Indefinitely",
        value: "indefinite",
    },
] satisfies readonly RadioGroupOption<DisableMode>[]);

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
        !Number.isFinite(timestamp) ||
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

/** @returns The duration, date/time, and explanation form for disabling a schedule. */
export function ScheduleDisableIntentModal({
    busy,
    error,
    onClose,
    onSaved,
    onSubmit,
    schedule,
}: ScheduleDisableIntentModalProps) {
    const formId = useId();
    const [snapshot] = useState<DisableIntentSnapshot>(() => ({
        enabled: schedule.enabled,
        ...(schedule.activeDisableIntent?.expiresAtMs === undefined
            ? {}
            : { expiresAtMs: schedule.activeDisableIntent.expiresAtMs }),
        expectedVersion: schedule.version,
        reason: schedule.activeDisableIntent?.reason ?? "",
    }));
    const [mode, setMode] = useState<DisableMode>(() =>
        schedule.activeDisableIntent === undefined ||
        schedule.activeDisableIntent.expiresAtMs !== undefined
            ? "until"
            : "indefinite"
    );
    const [comment, setComment] = useState(snapshot.reason);
    const [expiry, setExpiry] = useState<DateTimePickerValue>(() =>
        snapshot.expiresAtMs === undefined
            ? defaultDisableExpiry()
            : pickerValueFromTimestamp(snapshot.expiresAtMs)
    );
    const [commentError, setCommentError] = useState<string>();
    const [expiryError, setExpiryError] = useState<string>();

    const snapshotMode: DisableMode =
        snapshot.expiresAtMs === undefined ? "indefinite" : "until";
    let draftExpiry: number | undefined;
    if (mode === "until") {
        draftExpiry =
            snapshot.expiresAtMs !== undefined &&
            pickerMatchesTimestamp(expiry, snapshot.expiresAtMs)
                ? snapshot.expiresAtMs
                : pickerTimestamp(expiry);
    }
    const draftUnchanged =
        snapshot.enabled === false &&
        mode === snapshotMode &&
        comment === snapshot.reason &&
        draftExpiry === snapshot.expiresAtMs;
    const title = snapshot.enabled ? "Disable schedule" : "Edit disabled state";

    async function submit(): Promise<void> {
        if (draftUnchanged) return;
        const parsedComment = v.safeParse(scheduleDisableReasonSchema, comment);
        const nextCommentError = parsedComment.success
            ? undefined
            : "Enter between 1 and 1,000 characters.";
        const nextExpiryError =
            mode === "until" && (draftExpiry === undefined || draftExpiry <= Date.now())
                ? "Choose a future date and time."
                : undefined;
        setCommentError(nextCommentError);
        setExpiryError(nextExpiryError);
        if (!parsedComment.success || nextExpiryError !== undefined) {
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

        try {
            await onSubmit(
                {
                    ...(draftExpiry === undefined ? {} : { expiresAtMs: draftExpiry }),
                    reason: parsedComment.output,
                },
                snapshot.expectedVersion
            );
            onSaved();
        } catch {
            // The owning mutation renders its classified failure without closing the draft.
        }
    }

    return (
        <Modal dismissible={!busy} onClose={onClose} open title={title}>
            <Form aria-label={title} id={formId} onSubmit={submit}>
                <Alert className="mb-4" message={error} />
                <p className="text-primary-300 mb-4 text-sm leading-6">
                    This schedule will not start automatically while it is paused.
                </p>
                <div className="grid gap-4">
                    <RadioGroup
                        disabled={busy}
                        label="Disabled duration"
                        onChange={(nextMode) => {
                            setMode(nextMode);
                            setExpiryError(undefined);
                        }}
                        options={disableModeOptions}
                        orientation="horizontal"
                        value={mode}
                    />
                    {mode === "until" && (
                        <DateTimePicker
                            disabled={busy}
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
                        description="Required. Explain why the schedule is disabled and what should happen before it is enabled again."
                        disabled={busy}
                        error={commentError}
                        label="Comment"
                    >
                        <Textarea
                            className="mt-2 min-h-24"
                            maxLength={jobDescriptionMaximumLength * 2}
                            onChange={(event) => {
                                setComment(event.currentTarget.value);
                                setCommentError(undefined);
                            }}
                            placeholder="Waiting for the maintenance window to finish"
                            required
                            value={comment}
                        />
                    </FormField>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                    <Button disabled={busy} onClick={onClose} variant="secondary">
                        Cancel
                    </Button>
                    <Button
                        busy={busy}
                        busyLabel="Saving…"
                        disabled={draftUnchanged}
                        type="submit"
                        variant="danger"
                    >
                        {snapshot.enabled ? "Disable schedule" : "Save disabled state"}
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
