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

const serviceActionGroups = Object.freeze([
    Object.freeze({
        actionIds: Object.freeze([
            "dashboard-restart",
            "worker-restart",
            "dashboard-stack-restart",
        ] satisfies readonly ServiceActionId[]),
        label: "Dashboard",
    }),
    Object.freeze({
        actionIds: Object.freeze([
            "system-cleanup",
            "system-update",
            "system-restart",
        ] satisfies readonly ServiceActionId[]),
        label: "System",
    }),
    Object.freeze({
        actionIds: Object.freeze([
            "openclaw-cleanup",
            "openclaw-update",
            "openclaw-restart",
        ] satisfies readonly ServiceActionId[]),
        label: "OpenClaw",
    }),
]);

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
        <li className="border-primary-700 bg-primary-900/35 flex h-full flex-col rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <Heading level={3}>{presentation.actionLabel}</Heading>
                        {action.availability === "unavailable" && (
                            <Badge variant="warning">Unavailable</Badge>
                        )}
                        {active && <Badge variant="info">Active job</Badge>}
                    </div>
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
            </div>
            {(action.activeRun !== undefined || action.latestRun !== undefined) && (
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    {action.activeRun !== undefined && (
                        <RunObservation label="Active run" run={action.activeRun} />
                    )}
                    {action.latestRun !== undefined && (
                        <RunObservation label="Latest run" run={action.latestRun} />
                    )}
                </dl>
            )}
            <div className="mt-auto pt-3">
                <Button
                    className="w-full"
                    disabled={disabled}
                    onClick={() => onSelect(action.id)}
                    size="sm"
                    variant={action.id.endsWith("-restart") ? "danger" : "secondary"}
                >
                    {recoveryPending ? presentation.retryLabel : presentation.buttonLabel}
                </Button>
            </div>
        </li>
    );
}

export interface OverviewServiceActionsCardProps {
    readonly actions: GetServiceActionsStatusResult["actions"];
    readonly error?: string;
    readonly notice?: string;
    readonly onClearError: () => void;
    readonly onClearNotice: () => void;
    readonly onRequest: (actionId: ServiceActionId, onConfirmed: () => void) => void;
    readonly recoveryPending: (actionId: ServiceActionId) => boolean;
    readonly requestActionId: ServiceActionId | undefined;
    readonly requestBusy: boolean;
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
    onClearError,
    onClearNotice,
    onRequest,
    recoveryPending,
    requestActionId,
    requestBusy,
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
                <div className="flex min-w-0 items-center gap-2">
                    <Icon icon={Wrench} size="md" tone="accent" />
                    <Heading id={headingId} level={2} size="subsection">
                        Service actions
                    </Heading>
                </div>
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

            <div className="mt-4 space-y-3">
                {serviceActionGroups.map((group) => (
                    <section
                        aria-label={`${group.label} actions`}
                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                        key={group.label}
                    >
                        <Heading
                            className="text-primary-300 mb-2 text-xs tracking-wide uppercase"
                            level={3}
                        >
                            {group.label}
                        </Heading>
                        <ul className="grid gap-3 lg:grid-cols-3">
                            {group.actionIds
                                .map((actionId) =>
                                    actions.find(({ id }) => id === actionId)
                                )
                                .filter(
                                    (action): action is ServiceActionStatus =>
                                        action !== undefined
                                )
                                .map((action) => (
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
                    </section>
                ))}
            </div>

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
