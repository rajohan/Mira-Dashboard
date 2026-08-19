import { Radio, Unplug } from "lucide-react";
import { useRef, useState } from "react";

import type {
    GatewaySession,
    GatewaySessionAction,
    GatewaySessionActionResult,
    GatewaySessionFilter,
    ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import { gatewaySessionFilters } from "../../contracts/gatewaySessions.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatCompactCount } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Fieldset } from "../ui/Fieldset.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    gatewaySessionConfirmationCopy,
    gatewaySessionFilterLabels,
    gatewaySessionMatchesFilter,
} from "./gatewaySessionPresentation.ts";
import { GatewaySessionsTable } from "./GatewaySessionsTable.tsx";

interface PendingGatewaySessionAction {
    readonly action: GatewaySessionAction;
    readonly session: GatewaySession;
    readonly trigger: HTMLButtonElement;
}

export interface GatewaySessionsViewProps {
    readonly actionError?: string;
    readonly actionPending?: boolean;
    readonly backgroundUnavailable?: boolean;
    readonly onAction: (
        action: GatewaySessionAction,
        session: GatewaySession
    ) => Promise<GatewaySessionActionResult>;
    readonly onReconcileUnknown?: () => Promise<boolean>;
    readonly snapshot: ListGatewaySessionsResult;
}

function successMessage(result: GatewaySessionActionResult): string {
    let action: string;
    switch (result.action) {
        case "compact": {
            action =
                result.outcome === "changed"
                    ? "Session compacted."
                    : "This session did not need compacting.";
            break;
        }
        case "reset": {
            action = "Session reset.";
            break;
        }
        case "delete": {
            action = "Session deleted.";
            break;
        }
    }
    return result.refresh.status === "available"
        ? action
        : `${action} The session list has not updated yet.`;
}

/**
 * @returns Pure current-session inventory with filters, freshness, confirmation, and focus return.
 */
export function GatewaySessionsView({
    actionError,
    actionPending = false,
    backgroundUnavailable = false,
    onAction,
    onReconcileUnknown,
    snapshot,
}: GatewaySessionsViewProps) {
    const [filter, setFilter] = useState<GatewaySessionFilter>("ALL");
    const [pendingAction, setPendingAction] = useState<PendingGatewaySessionAction>();
    const [reconciliationState, setReconciliationState] = useState<
        "failed" | "refreshing"
    >();
    const [unknownOutcomeBlocked, setUnknownOutcomeBlocked] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string>();
    const inventoryFocus = useRef<HTMLDivElement>(null);
    const confirmButton = useRef<HTMLButtonElement>(null);
    const visibleSessions = snapshot.sessions.filter((session) =>
        gatewaySessionMatchesFilter(session, filter)
    );
    const confirmation =
        pendingAction === undefined
            ? undefined
            : gatewaySessionConfirmationCopy(pendingAction.action, pendingAction.session);
    const stale = snapshot.source.freshness === "stale" || backgroundUnavailable;
    let reconciliationError: string | undefined;
    if (reconciliationState === "refreshing") {
        reconciliationError =
            "We could not confirm whether the action finished. Refreshing the session list before another action is allowed.";
    } else if (reconciliationState === "failed") {
        reconciliationError =
            "We could not confirm whether the action finished, and the session list could not be refreshed. Try refreshing again before another action.";
    }

    function restoreActionFocus(action: PendingGatewaySessionAction) {
        queueMicrotask(() => {
            const triggerVisible = action.trigger.checkVisibility();
            const target =
                action.trigger.isConnected && triggerVisible
                    ? action.trigger
                    : inventoryFocus.current;
            target?.focus();
        });
    }

    function closeConfirmation() {
        const action = pendingAction;
        setPendingAction(undefined);
        if (!unknownOutcomeBlocked) setReconciliationState(undefined);
        if (action !== undefined) restoreActionFocus(action);
    }

    async function reconcileUnknownOutcome(
        action: PendingGatewaySessionAction | undefined
    ): Promise<void> {
        setUnknownOutcomeBlocked(true);
        setReconciliationState("refreshing");
        let refreshed = false;
        try {
            refreshed = (await onReconcileUnknown?.()) ?? false;
        } catch {
            // The dialog reports a fixed reconciliation failure category below.
        }
        if (!refreshed) {
            setReconciliationState("failed");
            return;
        }
        setUnknownOutcomeBlocked(false);
        setReconciliationState(undefined);
        setPendingAction(undefined);
        setStatusMessage(
            "Session list refreshed. Review the session before choosing another action."
        );
        if (action !== undefined) restoreActionFocus(action);
    }

    async function confirmAction() {
        const action = pendingAction;
        if (action === undefined) return;
        setStatusMessage(undefined);
        try {
            const result = await onAction(action.action, action.session);
            setStatusMessage(successMessage(result));
            setPendingAction(undefined);
            setReconciliationState(undefined);
            restoreActionFocus(action);
        } catch (error) {
            if (isDashboardOperationOutcomeUnknown(error)) {
                await reconcileUnknownOutcome(action);
                return;
            }
            setPendingAction(undefined);
            restoreActionFocus(action);
        }
    }

    return (
        <div className="space-y-7">
            <section aria-label="Session metrics">
                {unknownOutcomeBlocked && pendingAction === undefined && (
                    <div className="mb-3 flex justify-end">
                        <Button
                            busy={reconciliationState === "refreshing"}
                            busyLabel="Refreshing sessions…"
                            onClick={() => void reconcileUnknownOutcome(undefined)}
                            size="sm"
                            variant="secondary"
                        >
                            Try refresh again
                        </Button>
                    </div>
                )}
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Sessions
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.shown}
                            {snapshot.projectionTruncated ? "+" : ""}
                        </dd>
                    </div>
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Active (1h)
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.activeInLastHour}
                        </dd>
                    </div>
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Main
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.byKind.main}
                        </dd>
                    </div>
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Subagents
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.byKind.subagent}
                        </dd>
                    </div>
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Tokens
                            {snapshot.stats.tokenTotalState === "partial"
                                ? " (known only)"
                                : ""}
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.tokenTotalState === "overflow"
                                ? "Too large"
                                : formatCompactCount(snapshot.stats.totalTokens ?? 0)}
                        </dd>
                    </div>
                    <div className="border-primary-700 bg-primary-800/80 rounded-lg border p-3 text-center shadow-sm shadow-black/10">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Models
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.byModel.length +
                                (snapshot.stats.unknownModelCount > 0 ? 1 : 0)}
                        </dd>
                    </div>
                </dl>
                {snapshot.projectionTruncated && (
                    <Text className="mt-3" size="sm" tone="warning">
                        OpenClaw returned more sessions than this page can show. Showing
                        the first {snapshot.stats.shown}.
                    </Text>
                )}
            </section>

            {stale && (
                <Alert
                    focusOnError={false}
                    message={
                        backgroundUnavailable && snapshot.source.freshness === "fresh"
                            ? "A background refresh failed. Showing the most recent session data."
                            : `OpenClaw is disconnected. Showing session data from ${formatDashboardDateTime(snapshot.source.observedAtMs)}.`
                    }
                    variant="error"
                />
            )}
            <Alert
                focusOnError={false}
                message={pendingAction === undefined ? reconciliationError : undefined}
            />
            <Alert focusOnError={false} message={actionError} />
            <div aria-atomic="true" aria-live="polite">
                <Alert
                    message={statusMessage}
                    onDismiss={() => setStatusMessage(undefined)}
                    variant="success"
                />
            </div>

            <section aria-labelledby="gateway-session-inventory-heading">
                <div className="outline-none" ref={inventoryFocus} tabIndex={-1}>
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <Icon icon={Radio} tone="accent" />
                                <Heading
                                    id="gateway-session-inventory-heading"
                                    level={2}
                                    size="subsection"
                                >
                                    OpenClaw sessions
                                </Heading>
                            </div>
                            <Text className="mt-1" tone="muted">
                                Filter and sort current sessions. The main session stays
                                first.
                            </Text>
                        </div>
                        <Fieldset
                            className="w-full max-w-full min-w-0 lg:w-auto"
                            legend={<span className="sr-only">Session type filter</span>}
                        >
                            <div className="border-primary-700 bg-primary-800/80 flex w-full min-w-0 flex-nowrap gap-1 rounded-lg border p-1 lg:w-auto">
                                {gatewaySessionFilters.map((value) => (
                                    <Button
                                        aria-label={gatewaySessionFilterLabels[value]}
                                        aria-pressed={filter === value}
                                        className="min-h-8 min-w-0 flex-1 px-1 text-[0.625rem] sm:min-h-10 sm:px-4 sm:text-sm lg:flex-none"
                                        key={value}
                                        onClick={() => setFilter(value)}
                                        variant={filter === value ? "primary" : "ghost"}
                                    >
                                        {value === "SUBAGENT" ? (
                                            <span>
                                                SUB
                                                <span className="hidden sm:inline">
                                                    AGENT
                                                </span>
                                            </span>
                                        ) : (
                                            gatewaySessionFilterLabels[value]
                                        )}
                                    </Button>
                                ))}
                            </div>
                        </Fieldset>
                    </div>
                    <output
                        aria-atomic="true"
                        aria-live="polite"
                        className="text-primary-400 mt-3 block text-xs"
                    >
                        {visibleSessions.length} visible of {snapshot.stats.shown}
                        {snapshot.projectionTruncated ? "+" : ""} sessions
                    </output>
                    <div className="mt-5">
                        {visibleSessions.length === 0 ? (
                            <EmptyState
                                description={
                                    filter === "ALL"
                                        ? "Sessions will appear when OpenClaw reports them."
                                        : `No ${filter.toLowerCase()} sessions are in the current list.`
                                }
                                icon={filter === "ALL" ? Radio : Unplug}
                                title={
                                    filter === "ALL"
                                        ? "No current sessions"
                                        : `No ${filter.toLowerCase()} sessions`
                                }
                            />
                        ) : (
                            <GatewaySessionsTable
                                busy={actionPending || unknownOutcomeBlocked}
                                onRequestAction={(action, session, trigger) => {
                                    if (unknownOutcomeBlocked) return;
                                    setStatusMessage(undefined);
                                    setReconciliationState(undefined);
                                    setPendingAction({ action, session, trigger });
                                }}
                                sessions={visibleSessions}
                            />
                        )}
                    </div>
                </div>
            </section>

            <ConfirmModal
                busy={actionPending || reconciliationState === "refreshing"}
                confirmDisabled={reconciliationState !== undefined}
                confirmButtonRef={confirmButton}
                confirmLabel={confirmation?.confirmLabel}
                danger={confirmation?.danger}
                description={confirmation?.description ?? ""}
                error={reconciliationError}
                onCancel={closeConfirmation}
                onConfirm={() => void confirmAction()}
                onRetry={
                    reconciliationState === "failed"
                        ? () => void reconcileUnknownOutcome(pendingAction)
                        : undefined
                }
                open={pendingAction !== undefined}
                retryBusy={reconciliationState === "refreshing"}
                retryLabel="Try refresh again"
                title={confirmation?.title ?? "Confirm session action"}
            />
        </div>
    );
}
