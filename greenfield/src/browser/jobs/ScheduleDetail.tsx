import { CalendarClock, Play, Power, PowerOff } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import * as v from "valibot";

import {
    jobDescriptionMaximumLength,
    type ScheduleConfiguration,
    type ScheduleSummary,
} from "../../contracts/jobModel.ts";
import { scheduleDisableReasonSchema } from "../../contracts/schedules.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Text } from "../ui/Text.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { scheduleConfigurationLabel } from "./schedulePresentation.ts";

interface DisableIntentDraft {
    readonly expiresAtMs?: number;
    readonly reason: string;
}

interface DisableIntentSnapshot extends DisableIntentDraft {
    readonly enabled: boolean;
    readonly expectedVersion: number;
}

interface ScheduleDetailProps {
    readonly disableError?: string;
    readonly error?: string;
    readonly errorFocus?: boolean;
    readonly history: ReactNode;
    readonly onDisable: (
        draft: DisableIntentDraft,
        expectedVersion: number
    ) => Promise<void>;
    readonly onEnable: () => Promise<void>;
    readonly onOpenDisable: () => void;
    readonly onRun: () => Promise<void>;
    readonly onSaveConfiguration: (configuration: ScheduleConfiguration) => Promise<void>;
    readonly runBusy: boolean;
    readonly runReplayAvailable?: boolean;
    readonly schedule: ScheduleSummary;
    readonly updateBusy: boolean;
}

function localDateTimeValue(timestamp: number | undefined): string {
    if (timestamp === undefined) return "";
    const date = new Date(timestamp);
    const year = date.getFullYear().toString().padStart(4, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const base = `${year}-${month}-${day}T${hours}:${minutes}`;
    const seconds = date.getSeconds();
    const milliseconds = date.getMilliseconds();
    if (seconds === 0 && milliseconds === 0) return base;
    const secondText = seconds.toString().padStart(2, "0");
    return milliseconds === 0
        ? `${base}:${secondText}`
        : `${base}:${secondText}.${milliseconds.toString().padStart(3, "0")}`;
}

function localDateTimeTimestamp(value: string): number | undefined {
    const match =
        /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?$/u.exec(
            value
        );
    if (match === null) return;
    const [
        ,
        yearText,
        monthText,
        dayText,
        hoursText,
        minutesText,
        secondsText,
        millisecondsText,
    ] = match;
    if (
        yearText === undefined ||
        monthText === undefined ||
        dayText === undefined ||
        hoursText === undefined ||
        minutesText === undefined
    ) {
        return;
    }
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    const day = Number(dayText);
    const hours = Number(hoursText);
    const minutes = Number(minutesText);
    const seconds = secondsText === undefined ? 0 : Number(secondsText);
    const milliseconds = millisecondsText === undefined ? 0 : Number(millisecondsText);
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(hours, minutes, seconds, milliseconds);
    const timestamp = date.getTime();
    if (
        !Number.isFinite(timestamp) ||
        date.getFullYear() !== year ||
        date.getMonth() !== month ||
        date.getDate() !== day ||
        date.getHours() !== hours ||
        date.getMinutes() !== minutes ||
        date.getSeconds() !== seconds ||
        date.getMilliseconds() !== milliseconds
    ) {
        return;
    }
    return timestamp;
}

function focusScheduleDetailHeading(): void {
    setTimeout(
        () => document.querySelector<HTMLElement>("#schedule-detail-heading")?.focus(),
        0
    );
}

/** @returns Complete operator controls and history for one code-owned schedule. */
export function ScheduleDetail({
    disableError,
    error,
    errorFocus = true,
    history,
    onDisable,
    onEnable,
    onOpenDisable,
    onRun,
    onSaveConfiguration,
    runBusy,
    runReplayAvailable = false,
    schedule,
    updateBusy,
}: ScheduleDetailProps) {
    const disableFormId = useId();
    const actionsBusy = runBusy || updateBusy;
    const [disableOpen, setDisableOpen] = useState(false);
    const [disableReason, setDisableReason] = useState(
        schedule.activeDisableIntent?.reason ?? ""
    );
    const [disableExpiry, setDisableExpiry] = useState(
        localDateTimeValue(schedule.activeDisableIntent?.expiresAtMs)
    );
    const [disableExpiryError, setDisableExpiryError] = useState<string>();
    const [disableReasonError, setDisableReasonError] = useState<string>();
    const [disableSnapshot, setDisableSnapshot] = useState<DisableIntentSnapshot>();

    const snapshotExpiry = disableSnapshot?.expiresAtMs;
    let draftExpiry: number | undefined;
    if (disableExpiry.length > 0) {
        draftExpiry =
            snapshotExpiry !== undefined &&
            disableExpiry === localDateTimeValue(snapshotExpiry)
                ? snapshotExpiry
                : localDateTimeTimestamp(disableExpiry);
    }
    const disableDraftUnchanged =
        disableSnapshot?.enabled === false &&
        disableReason === disableSnapshot.reason &&
        draftExpiry === snapshotExpiry &&
        (disableExpiry.length === 0 || draftExpiry !== undefined);
    const disablingEnabledSchedule = disableSnapshot?.enabled ?? schedule.enabled;

    const openDisableIntent = () => {
        const activeIntent = schedule.activeDisableIntent;
        onOpenDisable();
        setDisableSnapshot({
            enabled: schedule.enabled,
            ...(activeIntent?.expiresAtMs === undefined
                ? {}
                : { expiresAtMs: activeIntent.expiresAtMs }),
            expectedVersion: schedule.version,
            reason: activeIntent?.reason ?? "",
        });
        setDisableReason(activeIntent?.reason ?? "");
        setDisableExpiry(localDateTimeValue(activeIntent?.expiresAtMs));
        setDisableExpiryError(undefined);
        setDisableReasonError(undefined);
        setDisableOpen(true);
    };
    const submitDisableIntent = async () => {
        if (disableSnapshot === undefined || disableDraftUnchanged) return;
        const parsedReason = v.safeParse(scheduleDisableReasonSchema, disableReason);
        const reasonError = parsedReason.success
            ? undefined
            : "Use 1–1000 visible characters without control characters.";
        const expiryError =
            disableExpiry.length > 0 &&
            (draftExpiry === undefined || draftExpiry <= Date.now())
                ? "Expiry must be a valid future date and time."
                : undefined;
        setDisableExpiryError(expiryError);
        setDisableReasonError(reasonError);
        if (!parsedReason.success || expiryError !== undefined) {
            setTimeout(() => {
                document
                    .querySelector<HTMLElement>(`[id="${disableFormId}"]`)
                    ?.querySelector<HTMLElement>("[data-invalid]:is(input, textarea)")
                    ?.focus();
            }, 0);
            return;
        }
        try {
            await onDisable(
                {
                    ...(draftExpiry === undefined ? {} : { expiresAtMs: draftExpiry }),
                    reason: parsedReason.output,
                },
                disableSnapshot.expectedVersion
            );
            setDisableOpen(false);
            focusScheduleDetailHeading();
        } catch {
            // The owning mutation renders its classified failure without closing the draft.
        }
    };
    const enableSchedule = async () => {
        await onEnable();
        focusScheduleDetailHeading();
    };
    const saveConfiguration = async (configuration: ScheduleConfiguration) => {
        await onSaveConfiguration(configuration);
        focusScheduleDetailHeading();
    };

    return (
        <Card aria-labelledby="schedule-detail-heading" className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={schedule.enabled ? "success" : "default"}>
                            {schedule.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge>{schedule.resourceClass}</Badge>
                        <Badge>{schedule.cancellationPolicy}</Badge>
                    </div>
                    <Heading
                        className="mt-3 wrap-anywhere"
                        id="schedule-detail-heading"
                        level={2}
                        tabIndex={-1}
                    >
                        {schedule.name}
                    </Heading>
                    <Text className="mt-1 font-mono wrap-break-word" tone="muted">
                        {schedule.id} · {schedule.actionKey}
                    </Text>
                    <Text className="mt-3 wrap-anywhere">{schedule.description}</Text>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        busy={runBusy}
                        busyLabel="Enqueuing…"
                        disabled={
                            updateBusy ||
                            (schedule.activeRun !== undefined && !runReplayAvailable)
                        }
                        onClick={() => void onRun().catch(() => {})}
                        size="sm"
                    >
                        <Icon icon={Play} size="sm" tone="inherit" />
                        {runReplayAvailable ? "Retry run request" : "Run now"}
                    </Button>
                    {schedule.enabled ? (
                        <Button
                            disabled={actionsBusy}
                            onClick={openDisableIntent}
                            size="sm"
                            variant="danger"
                        >
                            <Icon icon={PowerOff} size="sm" tone="inherit" />
                            Disable
                        </Button>
                    ) : (
                        <>
                            <Button
                                busy={updateBusy}
                                busyLabel="Enabling…"
                                disabled={runBusy}
                                onClick={() => void enableSchedule().catch(() => {})}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={Power} size="sm" tone="inherit" />
                                Enable
                            </Button>
                            <Button
                                disabled={actionsBusy}
                                onClick={openDisableIntent}
                                size="sm"
                                variant="secondary"
                            >
                                Update disable intent
                            </Button>
                        </>
                    )}
                </div>
            </div>
            <Alert
                className="mt-4"
                focusOnError={errorFocus}
                message={disableOpen ? undefined : error}
            />
            <dl className="border-primary-700 mt-5 grid gap-4 border-y py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <dt className="text-primary-400">Cadence</dt>
                    <dd className="text-primary-100 mt-1 font-mono wrap-break-word">
                        {scheduleConfigurationLabel(schedule.schedule)}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Next run</dt>
                    <dd className="text-primary-100 mt-1">
                        {schedule.nextRunAtMs === undefined
                            ? "Paused"
                            : formatDashboardDateTime(schedule.nextRunAtMs)}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Attempts / timeout</dt>
                    <dd className="text-primary-100 mt-1">
                        {schedule.attemptLimit} / {schedule.timeoutMs / 1000}s
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Version</dt>
                    <dd className="text-primary-100 mt-1">{schedule.version}</dd>
                </div>
            </dl>
            {schedule.activeDisableIntent !== undefined && (
                <div className="border-primary-700 bg-primary-900/40 mt-5 rounded-lg border p-4">
                    <Text as="span" size="sm" tone="muted">
                        Disable intent
                    </Text>
                    <Text className="mt-1 wrap-anywhere">
                        {schedule.activeDisableIntent.reason}
                    </Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        {schedule.activeDisableIntent.expiresAtMs === undefined
                            ? "No automatic expiry"
                            : `Expires ${formatDashboardDateTime(schedule.activeDisableIntent.expiresAtMs)}`}
                    </Text>
                </div>
            )}
            <div className="mt-6">
                <Heading level={3}>Cadence</Heading>
                <div className="mt-4">
                    <ScheduleEditor
                        busy={actionsBusy}
                        key={`${schedule.id}:${schedule.version}`}
                        onSave={saveConfiguration}
                        schedule={schedule}
                    />
                </div>
            </div>
            <div className="mt-7">
                <div className="mb-4 flex items-center gap-2">
                    <Icon
                        className="text-primary-400"
                        icon={CalendarClock}
                        tone="inherit"
                    />
                    <Heading level={3}>Run history</Heading>
                </div>
                {history}
            </div>
            <Modal
                dismissible={!updateBusy}
                onClose={() => setDisableOpen(false)}
                open={disableOpen}
                title={
                    disablingEnabledSchedule
                        ? "Disable schedule"
                        : "Update disable intent"
                }
            >
                <Form
                    aria-label={
                        disablingEnabledSchedule
                            ? "Disable schedule"
                            : "Update disable intent"
                    }
                    id={disableFormId}
                    onSubmit={submitDisableIntent}
                >
                    <Alert className="mb-4" message={disableError} />
                    <div className="grid gap-4">
                        <FormField
                            description="Recorded durably for operator context."
                            disabled={updateBusy}
                            error={disableReasonError}
                            label="Reason"
                        >
                            <Textarea
                                className="mt-2 min-h-24"
                                maxLength={jobDescriptionMaximumLength * 2}
                                onChange={(event) => {
                                    setDisableReason(event.currentTarget.value);
                                    setDisableReasonError(undefined);
                                }}
                                required
                                value={disableReason}
                            />
                        </FormField>
                        <FormField
                            description="Optional local time in YYYY-MM-DDTHH:mm[:ss.SSS] format. The worker re-enables the schedule after this time."
                            disabled={updateBusy}
                            error={disableExpiryError}
                            label="Expiry"
                        >
                            <Input
                                className="mt-2"
                                inputMode="numeric"
                                maxLength={25}
                                onChange={(event) => {
                                    setDisableExpiry(event.currentTarget.value);
                                    setDisableExpiryError(undefined);
                                }}
                                placeholder="2030-01-31T12:00"
                                value={disableExpiry}
                            />
                        </FormField>
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                        <Button
                            disabled={updateBusy}
                            onClick={() => setDisableOpen(false)}
                            variant="secondary"
                        >
                            Cancel
                        </Button>
                        <Button
                            busy={updateBusy}
                            busyLabel="Saving…"
                            disabled={disableDraftUnchanged}
                            type="submit"
                            variant="danger"
                        >
                            {disablingEnabledSchedule
                                ? "Disable schedule"
                                : "Save intent"}
                        </Button>
                    </div>
                </Form>
            </Modal>
        </Card>
    );
}
