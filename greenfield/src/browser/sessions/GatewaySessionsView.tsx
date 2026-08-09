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
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
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
                    ? "Older session context summarized."
                    : "This session did not need summarizing.";
            break;
        }
        case "reset": {
            action = "Session reset.";
            break;
        }
        case "delete": {
            action = "Session transcript deleted.";
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
            : gatewaySessionConfirmationCopy(
                  pendingAction.action,
                  pendingAction.session.displayName
              );
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
            const target = action.trigger.isConnected
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
        <div className="space-y-5">
            <Card aria-labelledby="gateway-session-status-heading">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Heading
                                id="gateway-session-status-heading"
                                level={2}
                                size="subsection"
                            >
                                Current status
                            </Heading>
                            <Badge variant={stale ? "warning" : "success"}>
                                {stale ? "Last known" : "Connected"}
                            </Badge>
                        </div>
                        <Text className="mt-1" tone="muted">
                            Last updated{" "}
                            <time
                                dateTime={new Date(
                                    snapshot.source.observedAtMs
                                ).toISOString()}
                            >
                                {formatDashboardDateTime(snapshot.source.observedAtMs)}
                            </time>
                            . The totals below use this data.
                        </Text>
                        <Text className="mt-1" size="sm" tone="muted">
                            Updates automatically every 10 seconds and when OpenClaw
                            reports a change.
                        </Text>
                    </div>
                    {unknownOutcomeBlocked && pendingAction === undefined && (
                        <Button
                            busy={reconciliationState === "refreshing"}
                            busyLabel="Refreshing sessions…"
                            onClick={() => void reconcileUnknownOutcome(undefined)}
                            size="sm"
                            variant="secondary"
                        >
                            Try refresh again
                        </Button>
                    )}
                </div>
                <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                    <div className="border-primary-700 rounded-lg border p-3">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Shown
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.shown}
                            {snapshot.projectionTruncated ? "+" : ""}
                        </dd>
                    </div>
                    <div className="border-primary-700 rounded-lg border p-3">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Active in last hour
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.activeInLastHour}
                        </dd>
                    </div>
                    <div className="border-primary-700 rounded-lg border p-3">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Main
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.byKind.main}
                        </dd>
                    </div>
                    <div className="border-primary-700 rounded-lg border p-3">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Subagents
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.byKind.subagent}
                        </dd>
                    </div>
                    <div className="border-primary-700 rounded-lg border p-3">
                        <dt className="text-primary-400 text-xs font-medium uppercase">
                            Known tokens
                        </dt>
                        <dd className="text-primary-50 mt-1 text-2xl font-semibold">
                            {snapshot.stats.tokenTotalState === "overflow"
                                ? "Too large"
                                : new Intl.NumberFormat().format(
                                      snapshot.stats.totalTokens ?? 0
                                  )}
                            {snapshot.stats.tokenTotalState === "partial" && (
                                <Text
                                    as="span"
                                    className="mt-1 block"
                                    size="sm"
                                    tone="muted"
                                >
                                    Partial total
                                </Text>
                            )}
                        </dd>
                    </div>
                    <div className="border-primary-700 rounded-lg border p-3">
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
            </Card>

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

            <Card aria-labelledby="gateway-session-inventory-heading">
                <div className="outline-none" ref={inventoryFocus} tabIndex={-1}>
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <Heading
                                id="gateway-session-inventory-heading"
                                level={2}
                                size="subsection"
                            >
                                OpenClaw sessions
                            </Heading>
                            <Text className="mt-1" tone="muted">
                                Filter and sort current sessions. The main session stays
                                first.
                            </Text>
                        </div>
                        <fieldset>
                            <legend className="sr-only">Session type filter</legend>
                            <div className="border-primary-700 flex flex-wrap rounded-lg border p-1">
                                {gatewaySessionFilters.map((value) => (
                                    <Button
                                        aria-pressed={filter === value}
                                        className={
                                            filter === value
                                                ? "bg-primary-600 text-primary-50"
                                                : undefined
                                        }
                                        key={value}
                                        onClick={() => setFilter(value)}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        {gatewaySessionFilterLabels[value]}
                                    </Button>
                                ))}
                            </div>
                        </fieldset>
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
            </Card>

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
