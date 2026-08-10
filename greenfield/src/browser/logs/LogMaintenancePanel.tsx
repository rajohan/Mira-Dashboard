import { FlaskConical, RotateCcw, ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import * as v from "valibot";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type { JobRunDetail } from "../../contracts/jobs.ts";
import {
    logMaintenanceJobResultSchema,
    type LogMaintenanceExecutionSummary,
    type LogMaintenancePolicyId,
    type LogMaintenancePolicyStatus,
    type LogMaintenanceStatusOutput,
    type RequestLogMaintenanceOutput,
} from "../../contracts/logs.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Text } from "../ui/Text.tsx";
import { logFailureMessage } from "./logPresentation.ts";

interface MaintenanceAction {
    readonly dryRun: boolean;
    readonly policyId: LogMaintenancePolicyId;
}

export interface LogMaintenancePanelProps {
    readonly maintenance?: LogMaintenanceStatusOutput;
    readonly maintenanceError?: string;
    readonly maintenanceLoading?: boolean;
    readonly onRequestMaintenance: (
        policyId: LogMaintenancePolicyId,
        dryRun: boolean
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly requestedRun?: JobRunDetail;
    readonly requestedRunError?: string;
    readonly requestedRunLoading?: boolean;
    readonly requestedRunRequest?: RequestLogMaintenanceOutput;
}

function runTimestamp(run: JobRunSummary): Readonly<{
    label: "Finished" | "Queued" | "Started";
    timestampMs: number;
}> {
    if (run.finishedAtMs !== undefined) {
        return { label: "Finished", timestampMs: run.finishedAtMs };
    }
    if (run.firstStartedAtMs !== undefined) {
        return { label: "Started", timestampMs: run.firstStartedAtMs };
    }
    return { label: "Queued", timestampMs: run.queuedAtMs };
}

function RunLifecycle({ run }: Readonly<{ readonly run: JobRunSummary }>) {
    const timestamp = runTimestamp(run);
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge className="capitalize" variant={jobRunStateBadgeVariant(run.state)}>
                {jobRunStateLabel(run.state)}
            </Badge>
            <time
                className="text-primary-400"
                dateTime={new Date(timestamp.timestampMs).toISOString()}
            >
                {timestamp.label} {formatDashboardDateTime(timestamp.timestampMs)}
            </time>
        </span>
    );
}

const summaryFields = [
    ["Checked", "checkedTargets"],
    ["Rotated", "rotated"],
    ["Compressed", "compressed"],
    ["Deleted", "deleted"],
    ["Skipped", "skipped"],
    ["Missing", "missing"],
    ["Errors", "error"],
] as const;

function summaryValue(
    summary: LogMaintenanceExecutionSummary,
    field: (typeof summaryFields)[number][1]
): number {
    return field === "checkedTargets"
        ? summary.checkedTargets
        : summary.actionCounts[field];
}

function MaintenanceSummary({
    label,
    summary,
}: Readonly<{
    readonly label: string;
    readonly summary: LogMaintenanceExecutionSummary;
}>) {
    return (
        <dl
            aria-label={label}
            className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4"
        >
            {summaryFields.map(([fieldLabel, field]) => (
                <div key={field}>
                    <dt className="text-primary-400 text-xs">{fieldLabel}</dt>
                    <dd className="text-primary-100 mt-0.5 text-sm font-medium tabular-nums">
                        {summaryValue(summary, field)}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function PolicyRunHistory({
    policy,
}: Readonly<{ readonly policy: LogMaintenancePolicyStatus }>) {
    return (
        <div className="border-primary-700/80 mt-4 space-y-3 border-t pt-3">
            {policy.activeRun === undefined ? null : (
                <output
                    aria-atomic="true"
                    aria-label={`Active maintenance run for ${policy.label}`}
                    aria-live="polite"
                    className="block"
                >
                    <span className="text-primary-200 mb-1 block text-xs font-medium">
                        Active run
                    </span>
                    <RunLifecycle run={policy.activeRun} />
                    <code className="text-primary-500 mt-1 block text-xs wrap-anywhere">
                        {policy.activeRun.id}
                    </code>
                </output>
            )}
            {policy.lastRun === undefined ? (
                <Text size="sm" tone="muted">
                    No terminal run recorded.
                </Text>
            ) : (
                <div aria-label={`Last maintenance run for ${policy.label}`}>
                    <p className="text-primary-200 mb-1 text-xs font-medium">Last run</p>
                    <RunLifecycle run={policy.lastRun.run} />
                    {policy.lastRun.run.terminalMessage === undefined ? null : (
                        <Text className="mt-2 wrap-anywhere" size="sm" tone="danger">
                            {policy.lastRun.run.terminalMessage}
                        </Text>
                    )}
                    {policy.lastRun.summary === undefined ? null : (
                        <MaintenanceSummary
                            label={`${policy.label} last-run summary`}
                            summary={policy.lastRun.summary}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function requestedMaintenanceSummary(
    request: RequestLogMaintenanceOutput | undefined,
    detail: JobRunDetail | undefined
): LogMaintenanceExecutionSummary | undefined {
    if (
        request === undefined ||
        detail === undefined ||
        detail.run.id !== request.jobRunId ||
        detail.result === undefined
    ) {
        return undefined;
    }
    const parsed = v.safeParse(logMaintenanceJobResultSchema, detail.result);
    return parsed.success &&
        parsed.output.policyId === request.policyId &&
        parsed.output.dryRun === request.dryRun
        ? parsed.output.summary
        : undefined;
}

function RequestedRunStatus({
    detail,
    error,
    loading,
    request,
}: Readonly<{
    readonly detail?: JobRunDetail;
    readonly error?: string;
    readonly loading: boolean;
    readonly request: RequestLogMaintenanceOutput;
}>) {
    const summary = requestedMaintenanceSummary(request, detail);
    const title = request.dryRun ? "Requested dry run" : "Requested maintenance run";
    let content: ReactNode;
    if (loading && detail === undefined) {
        content = (
            <LoadingState
                label={`Loading ${request.dryRun ? "dry-run" : "run"} status…`}
            />
        );
    } else if (detail === undefined) {
        content = (
            <Text className="mt-3" tone="muted">
                Waiting for durable job status.
            </Text>
        );
    } else {
        content = (
            <div className="mt-3">
                <output
                    aria-atomic="true"
                    aria-label={`${request.dryRun ? "Dry-run" : "Maintenance run"} lifecycle`}
                    aria-live="polite"
                    className="block"
                >
                    <RunLifecycle run={detail.run} />
                </output>
                {detail.run.terminalMessage === undefined ? null : (
                    <Text className="mt-2 wrap-anywhere" size="sm" tone="danger">
                        {detail.run.terminalMessage}
                    </Text>
                )}
                {summary === undefined ? null : (
                    <MaintenanceSummary
                        label={`${request.dryRun ? "Dry-run" : "Maintenance"} result summary`}
                        summary={summary}
                    />
                )}
            </div>
        );
    }
    return (
        <section
            aria-labelledby="requested-log-maintenance-heading"
            className="border-accent-700/60 bg-accent-950/25 mt-4 rounded-lg border p-4"
        >
            <Heading id="requested-log-maintenance-heading" level={3} size="subsection">
                {title}
            </Heading>
            <code className="text-primary-400 mt-1 block text-xs wrap-anywhere">
                {request.jobRunId}
            </code>
            <Alert className="mt-3" focusOnError={false} message={error} />
            {content}
        </section>
    );
}

/**
 * Renders fixed-policy controls with durable lifecycle and bounded result status.
 * @returns Accessible maintenance policy cards, confirmations, and job observations.
 */
export function LogMaintenancePanel({
    maintenance,
    maintenanceError,
    maintenanceLoading = false,
    onRequestMaintenance,
    requestedRun,
    requestedRunError,
    requestedRunLoading = false,
    requestedRunRequest,
}: LogMaintenancePanelProps) {
    const [actionError, setActionError] = useState<string>();
    const [actionStatus, setActionStatus] = useState<string>();
    const [confirmedAction, setConfirmedAction] = useState<MaintenanceAction>();
    const [runningAction, setRunningAction] = useState<MaintenanceAction>();
    const confirmedPolicy = maintenance?.policies.find(
        ({ id }) => id === confirmedAction?.policyId
    );

    function confirmAction(action: MaintenanceAction): void {
        setActionError(undefined);
        setActionStatus(undefined);
        setConfirmedAction(action);
    }

    async function runMaintenance(action: MaintenanceAction): Promise<void> {
        setActionError(undefined);
        setActionStatus(undefined);
        setRunningAction(action);
        try {
            const result = await onRequestMaintenance(action.policyId, action.dryRun);
            setConfirmedAction(undefined);
            setActionStatus(
                `${result.dryRun ? "Dry run" : (confirmedPolicy?.label ?? "Log maintenance")} was added to the queue as job ${result.jobRunId}.`
            );
        } catch (error) {
            setActionError(logFailureMessage(error));
        } finally {
            setRunningAction(undefined);
        }
    }

    const actionLabel = confirmedAction?.dryRun ? "Dry run" : "Run";
    const actionBusy = runningAction !== undefined;
    const requestedRunPending =
        requestedRunRequest !== undefined &&
        (requestedRunLoading ||
            (requestedRun?.run.id === requestedRunRequest.jobRunId &&
                (requestedRun.run.state === "queued" ||
                    requestedRun.run.state === "running")));
    const globalMaintenanceActive =
        (maintenance?.policies.some(({ activeRun }) => activeRun !== undefined) ??
            false) ||
        requestedRunPending;

    return (
        <Card aria-labelledby="log-maintenance-heading">
            <div className="flex items-start gap-3">
                <Icon className="mt-0.5 shrink-0" icon={ShieldCheck} tone="accent" />
                <div>
                    <Heading id="log-maintenance-heading" level={2} size="subsection">
                        Log maintenance
                    </Heading>
                    <Text className="mt-1" tone="muted">
                        Dashboard rotates application and container logs. System log
                        cleanup uses the four configured Ubuntu cleanup jobs.
                    </Text>
                </div>
            </div>
            <Alert className="mt-4" focusOnError={false} message={maintenanceError} />
            <Alert
                className="mt-4"
                focusOnError={false}
                message={actionStatus}
                onDismiss={() => setActionStatus(undefined)}
                variant="success"
            />
            {requestedRunRequest === undefined ? null : (
                <RequestedRunStatus
                    detail={requestedRun}
                    error={requestedRunError}
                    loading={requestedRunLoading}
                    request={requestedRunRequest}
                />
            )}
            {maintenanceLoading && maintenance === undefined ? (
                <LoadingState label="Checking log maintenance options…" />
            ) : (
                <ul className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {(maintenance?.policies ?? []).map((policy) => {
                        const disabled =
                            actionBusy ||
                            policy.state !== "queueable" ||
                            globalMaintenanceActive;
                        return (
                            <li
                                className="border-primary-700 bg-primary-950/45 rounded-lg border p-4"
                                key={policy.id}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-primary-100 font-medium">
                                            {policy.label}
                                        </p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <Badge>
                                                {policy.scope === "docker"
                                                    ? "Apps and containers"
                                                    : "System"}
                                            </Badge>
                                            <Badge
                                                variant={
                                                    policy.state === "queueable"
                                                        ? "success"
                                                        : "danger"
                                                }
                                            >
                                                {policy.state === "queueable"
                                                    ? "Ready"
                                                    : "Unavailable"}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>
                                <PolicyRunHistory policy={policy} />
                                <fieldset
                                    aria-label={`Actions for ${policy.label}`}
                                    className="mt-4 flex flex-wrap gap-2"
                                >
                                    <Button
                                        aria-label={`Run ${policy.label}`}
                                        disabled={disabled}
                                        onClick={() =>
                                            confirmAction({
                                                dryRun: false,
                                                policyId: policy.id,
                                            })
                                        }
                                        size="sm"
                                        variant="secondary"
                                    >
                                        <Icon icon={RotateCcw} size="sm" tone="inherit" />
                                        Run
                                    </Button>
                                    {policy.id === "docker-managed" && (
                                        <Button
                                            aria-label={`Dry run ${policy.label}`}
                                            disabled={disabled}
                                            onClick={() =>
                                                confirmAction({
                                                    dryRun: true,
                                                    policyId: policy.id,
                                                })
                                            }
                                            size="sm"
                                            variant="secondary"
                                        >
                                            <Icon
                                                icon={FlaskConical}
                                                size="sm"
                                                tone="inherit"
                                            />
                                            Dry run
                                        </Button>
                                    )}
                                </fieldset>
                            </li>
                        );
                    })}
                </ul>
            )}

            <Modal
                description={
                    confirmedAction?.dryRun === true
                        ? "This queues a read-only preview of the managed cleanup policy. It reports planned actions without rotating, compressing, or deleting logs. You must have verified your identity recently with multi-factor authentication."
                        : "This adds the configured cleanup job to the queue. You must have verified your identity recently with multi-factor authentication."
                }
                dismissible={!actionBusy}
                onClose={() => {
                    setActionError(undefined);
                    setConfirmedAction(undefined);
                }}
                open={confirmedPolicy !== undefined && confirmedAction !== undefined}
                size="sm"
                title={`${actionLabel} ${confirmedPolicy?.label ?? "log maintenance"}?`}
            >
                <Alert
                    className="mb-4"
                    message={actionError}
                    onDismiss={() => setActionError(undefined)}
                />
                <div className="flex justify-end gap-2">
                    <Button
                        disabled={actionBusy}
                        onClick={() => {
                            setActionError(undefined);
                            setConfirmedAction(undefined);
                        }}
                        variant="secondary"
                    >
                        Cancel
                    </Button>
                    <Button
                        busy={actionBusy}
                        busyLabel={
                            confirmedAction?.dryRun === true
                                ? "Adding dry run to the queue…"
                                : "Adding log maintenance to the queue…"
                        }
                        onClick={() => {
                            if (confirmedAction !== undefined) {
                                void runMaintenance(confirmedAction);
                            }
                        }}
                    >
                        {confirmedAction?.dryRun === true
                            ? "Queue dry run"
                            : "Add to queue"}
                    </Button>
                </div>
            </Modal>
        </Card>
    );
}
