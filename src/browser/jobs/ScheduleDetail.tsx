import { CalendarClock, Play, Power, PowerOff } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
    type ScheduleConfiguration,
    type ScheduleSummary,
} from "../../contracts/jobModel.ts";
import {
    formatDashboardDateTime,
    formatDashboardDateTimeToMinute,
} from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    type DisableIntentDraft,
    ScheduleDisableIntentModal,
} from "./ScheduleDisableIntentModal.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { scheduleConfigurationLabel } from "./schedulePresentation.ts";

interface ScheduleDetailProps {
    readonly disableError?: string;
    readonly error?: string;
    readonly errorAction?: ReactNode;
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

function focusScheduleDetailHeading(): void {
    setTimeout(
        () => document.querySelector<HTMLElement>("#schedule-detail-heading")?.focus(),
        0
    );
}

function scheduleRunBusyLabel(schedule: ScheduleSummary): string {
    if (schedule.activeRun?.state === "running") return "Running…";
    if (schedule.activeRun?.state === "queued") return "Queued…";
    return "Starting…";
}

/** @returns Complete operator controls and history for one code-owned schedule. */
export function ScheduleDetail({
    disableError,
    error,
    errorAction,
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
    const actionsBusy = runBusy || updateBusy;
    const [disableOpen, setDisableOpen] = useState(false);

    const openDisableIntent = () => {
        onOpenDisable();
        setDisableOpen(true);
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
                        <Badge>Work size: {schedule.resourceClass}</Badge>
                        <Badge>
                            {schedule.cancellationPolicy === "cooperative"
                                ? "Can be cancelled"
                                : "Cannot be cancelled"}
                        </Badge>
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
                    {schedule.manualRunAvailable ? (
                        <Button
                            busy={runBusy}
                            busyLabel={scheduleRunBusyLabel(schedule)}
                            disabled={
                                updateBusy ||
                                (schedule.activeRun !== undefined && !runReplayAvailable)
                            }
                            onClick={() => void onRun().catch(() => {})}
                            size="sm"
                        >
                            <Icon icon={Play} size="sm" tone="inherit" />
                            {runReplayAvailable ? "Try starting again" : "Run now"}
                        </Button>
                    ) : null}
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
                                Edit disabled state
                            </Button>
                        </>
                    )}
                </div>
            </div>
            <Alert
                action={disableOpen ? undefined : errorAction}
                className="mt-4"
                focusOnError={errorFocus}
                message={disableOpen ? undefined : error}
            />
            <dl className="border-primary-700 mt-5 grid gap-4 border-y py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <dt className="text-primary-400">Schedule</dt>
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
                    <dt className="text-primary-400">Saved version</dt>
                    <dd className="text-primary-100 mt-1">{schedule.version}</dd>
                </div>
            </dl>
            {schedule.activeDisableIntent !== undefined && (
                <div className="border-primary-700 bg-primary-900/40 mt-5 rounded-lg border p-4">
                    <Text as="span" size="sm" tone="muted">
                        Disabled state
                    </Text>
                    <Text className="mt-1 wrap-anywhere">
                        {schedule.activeDisableIntent.reason}
                    </Text>
                    <Text className="mt-1" size="sm" tone="muted">
                        {schedule.activeDisableIntent.expiresAtMs === undefined
                            ? "Disabled indefinitely"
                            : `Disabled until ${formatDashboardDateTimeToMinute(schedule.activeDisableIntent.expiresAtMs)}`}
                    </Text>
                </div>
            )}
            <div className="mt-6">
                <div className="flex items-center gap-2">
                    <Icon icon={CalendarClock} tone="accent" />
                    <Heading level={3}>Schedule</Heading>
                </div>
                <div className="mt-4">
                    <ScheduleEditor
                        busy={actionsBusy}
                        key={`${schedule.id}:${schedule.version}`}
                        onSave={saveConfiguration}
                        schedule={schedule}
                    />
                </div>
            </div>
            <div className="mt-5">
                <div className="mb-4 flex items-center gap-2">
                    <Icon icon={CalendarClock} tone="accent" />
                    <Heading level={3}>Run history</Heading>
                </div>
                {history}
            </div>
            {disableOpen && (
                <ScheduleDisableIntentModal
                    busy={updateBusy}
                    error={disableError}
                    onClose={() => setDisableOpen(false)}
                    onSaved={() => {
                        setDisableOpen(false);
                        focusScheduleDetailHeading();
                    }}
                    onSubmit={onDisable}
                    schedule={schedule}
                />
            )}
        </Card>
    );
}
