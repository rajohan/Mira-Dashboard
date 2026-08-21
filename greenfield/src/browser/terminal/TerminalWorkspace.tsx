import { Clipboard, Eraser, Focus, Play, RefreshCw, SquareTerminal } from "lucide-react";
import { useState, type ReactNode } from "react";
import * as v from "valibot";

import {
    type TerminalDimensions,
    type TerminalLocation,
    terminalLocationSchema,
    type TerminalRuntime,
    type TerminalSessionSummary,
} from "../../contracts/terminal.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Input } from "../ui/Input.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";

export type TerminalWorkspacePhase =
    | "active-elsewhere"
    | "connected"
    | "connecting"
    | "ended"
    | "error"
    | "idle"
    | "reconnecting"
    | "resyncing"
    | "starting";

export interface TerminalWorkspaceProps {
    readonly actionError?: string;
    readonly announcement: string;
    readonly canvas: ReactNode;
    readonly dimensions: TerminalDimensions;
    readonly endBusy?: boolean;
    readonly inputPaused?: boolean;
    readonly location: TerminalLocation;
    readonly onClear: () => void;
    readonly onCopySelection: () => void;
    readonly onEnd: () => void;
    readonly onFocus: () => void;
    readonly onLocation: (location: TerminalLocation) => void;
    readonly onRefreshSession: () => void;
    readonly onResume: () => void;
    readonly onStart: () => void;
    readonly phase: TerminalWorkspacePhase;
    readonly replayGap?: boolean;
    readonly runtime: TerminalRuntime;
    readonly session?: TerminalSessionSummary;
    readonly startBusy?: boolean;
    readonly terminalReady: boolean;
}

const phasePresentation: Readonly<
    Record<
        TerminalWorkspacePhase,
        Readonly<{
            label: string;
            variant: "danger" | "default" | "info" | "success" | "warning";
        }>
    >
> = Object.freeze({
    "active-elsewhere": { label: "Active elsewhere", variant: "warning" },
    connected: { label: "Connected", variant: "success" },
    connecting: { label: "Connecting", variant: "info" },
    ended: { label: "Ended", variant: "default" },
    error: { label: "Unavailable", variant: "danger" },
    idle: { label: "Ready", variant: "default" },
    reconnecting: { label: "Reconnecting", variant: "warning" },
    resyncing: { label: "Resyncing", variant: "warning" },
    starting: { label: "Starting", variant: "info" },
});

function locationIsValid(location: TerminalLocation): boolean {
    return v.safeParse(terminalLocationSchema, location, { abortEarly: true }).success;
}

/**
 * Pure terminal workspace. The canvas owns terminal content; React state contains
 * only lifecycle metadata, controls, and accessible status copy.
 * @returns Responsive lifecycle controls and a content-free xterm host.
 */
export function TerminalWorkspace({
    actionError,
    announcement,
    canvas,
    dimensions,
    endBusy = false,
    inputPaused = false,
    location,
    onClear,
    onCopySelection,
    onEnd,
    onFocus,
    onLocation,
    onRefreshSession,
    onResume,
    onStart,
    phase,
    replayGap = false,
    runtime,
    session,
    startBusy = false,
    terminalReady,
}: TerminalWorkspaceProps) {
    const [confirmEnd, setConfirmEnd] = useState(false);
    const hasSession = session !== undefined;
    const resumeAvailable =
        phase === "active-elsewhere" && session?.state === "awaiting-reconnect";
    const startAvailable = !hasSession && phase !== "starting" && phase !== "connecting";
    const presentation = phasePresentation[phase];
    const validLocation = locationIsValid(location);
    const rootOptions = runtime.roots.map((root) => ({
        description: `Starts in ${root.defaultPath}`,
        label: root.label,
        value: root.id,
    }));

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            <Card className="shrink-0" aria-labelledby="terminal-session-heading">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <Heading
                                id="terminal-session-heading"
                                level={2}
                                size="subsection"
                            >
                                Interactive terminal
                            </Heading>
                            <Badge variant={presentation.variant}>
                                {presentation.label}
                            </Badge>
                            {inputPaused && <Badge variant="warning">Input paused</Badge>}
                        </div>
                        <Text className="mt-1" size="sm" tone="muted">
                            {dimensions.columns} × {dimensions.rows} · Ends after{" "}
                            {Math.round(runtime.idleTimeoutMs / 60_000)} minutes idle ·{" "}
                            {Math.round(runtime.sessionMaximumDurationMs / 3_600_000)}{" "}
                            hour limit
                        </Text>
                        {session !== undefined && (
                            <Text className="mt-1" size="sm" tone="muted">
                                {runtime.roots.find(
                                    (root) => root.id === session.location.rootId
                                )?.label ?? session.location.rootId}
                                {session.location.path} · expires{" "}
                                <time
                                    dateTime={new Date(session.expiresAtMs).toISOString()}
                                >
                                    {formatDashboardDateTime(session.expiresAtMs)}
                                </time>
                            </Text>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {resumeAvailable && (
                            <Button onClick={onResume} size="sm">
                                <Icon icon={RefreshCw} size="sm" tone="inherit" />
                                Resume terminal
                            </Button>
                        )}
                        {hasSession && (
                            <Button
                                disabled={endBusy}
                                onClick={() => setConfirmEnd(true)}
                                size="sm"
                                variant="danger"
                            >
                                End terminal
                            </Button>
                        )}
                        {phase === "active-elsewhere" && !resumeAvailable && (
                            <Button
                                onClick={onRefreshSession}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={RefreshCw} size="sm" tone="inherit" />
                                Refresh state
                            </Button>
                        )}
                    </div>
                </div>

                {startAvailable && (
                    <div className="border-primary-700 mt-4 grid gap-3 border-t pt-4 sm:grid-cols-[minmax(12rem,0.7fr)_minmax(14rem,1.3fr)_auto] sm:items-end">
                        <FormField className="min-w-0" label="Starting folder">
                            <Select
                                ariaLabel="Terminal starting root"
                                className="mt-1"
                                onChange={(rootId) => {
                                    const root = runtime.roots.find(
                                        (candidate) => candidate.id === rootId
                                    );
                                    if (root !== undefined) {
                                        onLocation({
                                            path: root.defaultPath,
                                            rootId: root.id,
                                        });
                                    }
                                }}
                                options={rootOptions}
                                value={location.rootId}
                            />
                        </FormField>
                        <FormField
                            className="min-w-0"
                            error={
                                validLocation
                                    ? undefined
                                    : "Use a folder path that starts with / and does not contain . or .. segments."
                            }
                            label="Folder or subfolder"
                        >
                            <Input
                                aria-label="Terminal starting folder or subfolder"
                                autoComplete="off"
                                className="mt-1"
                                invalid={!validLocation}
                                onChange={(event) =>
                                    onLocation({
                                        ...location,
                                        path: event.currentTarget.value,
                                    })
                                }
                                placeholder="/projects/dashboard"
                                spellCheck={false}
                                value={location.path}
                            />
                        </FormField>
                        <Button
                            busy={startBusy}
                            busyLabel="Starting terminal…"
                            disabled={!terminalReady || !validLocation}
                            onClick={onStart}
                        >
                            <Icon icon={Play} size="sm" tone="inherit" />
                            Start terminal
                        </Button>
                    </div>
                )}
            </Card>

            <Alert
                focusOnError={false}
                message={
                    replayGap
                        ? "Some earlier output is no longer available. Showing the newest terminal output."
                        : undefined
                }
                variant="info"
            />
            <Alert message={actionError} />

            <section
                aria-labelledby="terminal-canvas-heading"
                className="border-primary-700 bg-primary-950 flex min-h-[28rem] flex-1 flex-col overflow-hidden rounded-xl border shadow-sm shadow-black/20"
            >
                <div className="border-primary-700 bg-primary-900 flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
                    <Heading className="sr-only" id="terminal-canvas-heading" level={2}>
                        Terminal canvas
                    </Heading>
                    <Icon className="text-primary-400" icon={SquareTerminal} size="sm" />
                    <div className="ml-auto flex flex-wrap items-center gap-1">
                        <IconOnlyButton
                            icon={Clipboard}
                            label="Copy terminal selection"
                            onClick={onCopySelection}
                            variant="ghost"
                        />
                        <IconOnlyButton
                            icon={Focus}
                            label="Focus terminal"
                            onClick={onFocus}
                            variant="ghost"
                        />
                        <IconOnlyButton
                            icon={Eraser}
                            label="Clear local terminal buffer"
                            onClick={onClear}
                            variant="ghost"
                        />
                    </div>
                </div>
                <div className="relative min-h-0 flex-1">
                    {canvas}
                    {!hasSession && (
                        <div className="bg-primary-950/90 pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
                            <div>
                                <Text className="font-semibold">
                                    Terminal not started
                                </Text>
                                <Text className="mt-1" size="sm" tone="muted">
                                    Choose a starting folder to open an interactive shell.
                                </Text>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            <output aria-live="polite" className="sr-only">
                {announcement}
            </output>

            <ConfirmModal
                busy={endBusy}
                confirmLabel="End terminal"
                danger
                description="This closes the terminal and stops its commands. The Dashboard does not save terminal input or output."
                onCancel={() => setConfirmEnd(false)}
                onConfirm={() => {
                    onEnd();
                    setConfirmEnd(false);
                }}
                open={confirmEnd}
                title="End interactive terminal?"
            />
        </div>
    );
}
