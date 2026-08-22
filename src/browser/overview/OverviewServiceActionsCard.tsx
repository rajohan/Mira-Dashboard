import { Wrench } from "lucide-react";
import { useId, useState } from "react";

import type { JobRunSummary } from "../../contracts/jobModel.ts";
import type {
    GetServiceActionsStatusResult,
    ServiceActionId,
    ServiceActionStatus,
} from "../../contracts/serviceActions.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import { serviceActionPresentations } from "./serviceActionsOperations.ts";

interface RunObservationProps {
    readonly label: string;
    readonly run: JobRunSummary | undefined;
}

function RunObservation({ label, run }: RunObservationProps) {
    if (run === undefined) {
        return (
            <div>
                <dt className="text-primary-400 text-xs">{label}</dt>
                <dd className="text-primary-300 mt-1 text-sm">None</dd>
            </div>
        );
    }
    return (
        <div>
            <dt className="text-primary-400 text-xs">{label}</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={jobRunStateBadgeVariant(run.state)}>
                    {jobRunStateLabel(run.state)}
                </Badge>
                <time
                    className="text-primary-300 text-xs"
                    dateTime={new Date(run.updatedAtMs).toISOString()}
                >
                    {formatDashboardDateTime(run.updatedAtMs)}
                </time>
            </dd>
            <dd className="text-primary-400 mt-1 text-xs break-all">
                Run{" "}
                <ActionLink
                    aria-label={`Open Dashboard job ${run.id}`}
                    className="text-accent-300 hover:text-accent-200 font-mono"
                    search={{ runId: run.id }}
                    to="/jobs"
                >
                    {run.id}
                </ActionLink>
            </dd>
        </div>
    );
}

interface ServiceActionRowProps {
    readonly action: ServiceActionStatus;
    readonly globalBusy: boolean;
    readonly onSelect: (actionId: ServiceActionId) => void;
    readonly recoveryPending: boolean;
}

function ServiceActionRow({
    action,
    globalBusy,
    onSelect,
    recoveryPending,
}: ServiceActionRowProps) {
    const presentation = serviceActionPresentations[action.id];
    const active = action.activeRun !== undefined;
    const disabled =
        (active && !recoveryPending) ||
        globalBusy ||
        (action.availability === "unavailable" && !recoveryPending);
    return (
        <li className="border-primary-700 bg-primary-900/35 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <Heading level={3}>{presentation.actionLabel}</Heading>
                        <Badge
                            variant={
                                action.availability === "available"
                                    ? "success"
                                    : "warning"
                            }
                        >
                            {action.availability}
                        </Badge>
                        {active && <Badge variant="info">Active job</Badge>}
                    </div>
                    <Text className="mt-2" size="sm" tone="muted">
                        {presentation.description}
                    </Text>
                    {action.availability === "unavailable" && (
                        <Text className="mt-2" size="sm" tone="warning">
                            No fresh worker currently advertises this fixed operation.
                        </Text>
                    )}
                    {recoveryPending && (
                        <Text className="mt-2" size="sm" tone="warning">
                            This browser session retains the request identity. An explicit
                            retry reuses it; review Dashboard jobs first.
                        </Text>
                    )}
                </div>
                <Button
                    disabled={disabled}
                    onClick={() => onSelect(action.id)}
                    variant={action.id.endsWith("-restart") ? "danger" : "secondary"}
                >
                    {recoveryPending ? presentation.retryLabel : presentation.buttonLabel}
                </Button>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <RunObservation label="Active run" run={action.activeRun} />
                <RunObservation label="Latest run" run={action.latestRun} />
            </dl>
        </li>
    );
}

export interface OverviewServiceActionsCardProps {
    readonly actions: GetServiceActionsStatusResult["actions"];
    readonly error?: string;
    readonly notice?: string;
    readonly observedAtMs: number;
    readonly onClearError: () => void;
    readonly onClearNotice: () => void;
    readonly onRequest: (actionId: ServiceActionId, onConfirmed: () => void) => void;
    readonly recoveryPending: (actionId: ServiceActionId) => boolean;
    readonly requestActionId: ServiceActionId | undefined;
    readonly requestBusy: boolean;
    readonly showJobsLink?: boolean;
}

/**
 * Renders exact fixed service actions without command, payload, or provider details.
 * @param properties Validated status rows and one session-bound request controller.
 * @returns Fixed-action status rows and an accessible confirmation boundary.
 */
export function OverviewServiceActionsCard({
    actions,
    error,
    notice,
    observedAtMs,
    onClearError,
    onClearNotice,
    onRequest,
    recoveryPending,
    requestActionId,
    requestBusy,
    showJobsLink = true,
}: OverviewServiceActionsCardProps) {
    const headingId = useId();
    const [selectedActionId, setSelectedActionId] = useState<ServiceActionId>();
    const selectedAction = actions.find(({ id }) => id === selectedActionId);
    const selectedPresentation =
        selectedActionId === undefined
            ? undefined
            : serviceActionPresentations[selectedActionId];
    const selectedRecoveryPending =
        selectedActionId === undefined ? false : recoveryPending(selectedActionId);

    return (
        <Card aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                        <Icon icon={Wrench} tone="accent" />
                    </span>
                    <div className="min-w-0">
                        <Heading id={headingId} level={2} size="subsection">
                            Service actions
                        </Heading>
                        <Text className="mt-1" size="sm" tone="muted">
                            Queue fixed, audited worker operations. Recent multi-factor
                            authentication is required; arbitrary commands are not
                            accepted.
                        </Text>
                    </div>
                </div>
                {showJobsLink && (
                    <ActionLink size="sm" to="/jobs" variant="secondary">
                        View Dashboard jobs
                    </ActionLink>
                )}
            </div>

            <Alert
                className="mt-4"
                message={selectedActionId === undefined ? error : undefined}
                onDismiss={onClearError}
            />
            <Alert
                className="mt-4"
                message={notice}
                onDismiss={onClearNotice}
                variant="success"
            />

            <ul className="mt-5 grid gap-4 xl:grid-cols-2">
                {actions.map((action) => (
                    <ServiceActionRow
                        action={action}
                        globalBusy={requestBusy}
                        key={action.id}
                        onSelect={(actionId) => {
                            onClearError();
                            onClearNotice();
                            setSelectedActionId(actionId);
                        }}
                        recoveryPending={recoveryPending(action.id)}
                    />
                ))}
            </ul>

            <Text className="mt-4" size="sm" tone="muted">
                Status observed{" "}
                <time dateTime={new Date(observedAtMs).toISOString()}>
                    {formatDashboardDateTime(observedAtMs)}
                </time>
                . A queued response confirms only the durable Dashboard job run.
            </Text>

            <ConfirmModal
                busy={requestBusy && requestActionId === selectedActionId}
                confirmDisabled={
                    selectedAction === undefined ||
                    (selectedAction.availability === "unavailable" &&
                        !selectedRecoveryPending) ||
                    (selectedAction.activeRun !== undefined && !selectedRecoveryPending)
                }
                confirmLabel={
                    selectedRecoveryPending
                        ? "Retry request"
                        : (selectedPresentation?.confirmationLabel ?? "Queue action")
                }
                danger
                description={
                    <span>
                        {selectedPresentation?.warning}
                        {selectedRecoveryPending && (
                            <span className="mt-2 block text-amber-200">
                                This retry uses the retained request identity and does not
                                create a new intent.
                            </span>
                        )}
                    </span>
                }
                error={requestActionId === selectedActionId ? error : undefined}
                onCancel={() => {
                    if (!requestBusy) setSelectedActionId(undefined);
                }}
                onConfirm={() => {
                    if (selectedActionId === undefined) return;
                    onRequest(selectedActionId, () => setSelectedActionId(undefined));
                }}
                open={selectedActionId !== undefined}
                title={selectedPresentation?.confirmationTitle ?? "Queue service action?"}
            />
        </Card>
    );
}
