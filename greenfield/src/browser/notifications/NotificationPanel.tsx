import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { NotificationRecord } from "../../contracts/monitoring.ts";
import type {
    ListNotificationsInput,
    ListNotificationsResult,
} from "../../contracts/notifications.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
} from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { NotificationListItem } from "./NotificationListItem.tsx";
import {
    NotificationBulkProtocolError,
    notificationMutationKey,
    useClearReadNotificationsMutation,
    useDeleteNotificationMutation,
    useMarkAllNotificationsReadMutation,
    useMarkNotificationReadMutation,
} from "./notificationMutations.ts";
import {
    notificationHistoryPageQueryOptions,
    type NotificationCursor,
    uniqueNotificationRows,
} from "./notificationQueries.ts";

type NotificationReadFilter = "all" | "read" | "unread";
type NotificationSeverity = NotificationRecord["severity"];
type NotificationSeverityFilter = "all" | NotificationSeverity;

const emptyNotifications: readonly NotificationRecord[] = Object.freeze([]);
const readFilterOptions = Object.freeze([
    { label: "All notifications", value: "all" },
    { label: "Unread", value: "unread" },
    { label: "Read", value: "read" },
] satisfies readonly SelectOption<NotificationReadFilter>[]);
const severityFilterOptions = Object.freeze([
    { label: "All severities", value: "all" },
    { label: "Critical", value: "critical" },
    { label: "Error", value: "error" },
    { label: "Warning", value: "warning" },
    { label: "Info", value: "info" },
] satisfies readonly SelectOption<NotificationSeverityFilter>[]);

function notificationMatchesFilters(
    notification: NotificationRecord,
    readState: NotificationReadFilter,
    severity: NotificationSeverityFilter
): boolean {
    const matchesReadState =
        readState === "all" ||
        (readState === "read" && notification.readAtMs !== undefined) ||
        (readState === "unread" && notification.readAtMs === undefined);
    return matchesReadState && (severity === "all" || notification.severity === severity);
}

function notificationCursorsMatch(
    left: NotificationCursor | undefined,
    right: NotificationCursor | undefined
): boolean {
    return (
        left === right ||
        (left !== undefined &&
            right !== undefined &&
            left.id === right.id &&
            left.occurredAtMs === right.occurredAtMs)
    );
}

function notificationActionFailureMessage(
    error: Error | null,
    bulk: boolean
): string | undefined {
    if (error === null) return undefined;
    if (error instanceof NotificationBulkProtocolError) {
        return "The notification action stopped because the server made no progress. A refresh was requested. Confirm the current state before retrying.";
    }
    if (classifyDashboardBrowserFailure(error) === "not-found") {
        return "This notification no longer exists.";
    }
    if (bulk) {
        return "The bulk action may have completed partially. A refresh was requested. Confirm the current state before retrying.";
    }
    return dashboardBrowserFailureMessage(error);
}

interface NotificationPanelProps {
    readonly latestError: Error | null;
    readonly latestLoading: boolean;
    readonly latestReady: boolean;
    readonly latestResult: ListNotificationsResult | undefined;
    readonly latestRows: readonly NotificationRecord[];
    readonly onRetryLatest: () => void;
}

/** @returns Open notification controls and bounded, lazily requested history. */
export function NotificationPanel({
    latestError,
    latestLoading,
    latestReady,
    latestResult,
    latestRows,
    onRetryLatest,
}: NotificationPanelProps) {
    const client = useDashboardTrpcClient();
    const [readFilter, setReadFilter] = useState<NotificationReadFilter>("all");
    const [severityFilter, setSeverityFilter] =
        useState<NotificationSeverityFilter>("all");
    const [historyCursors, setHistoryCursors] = useState<NotificationCursor[]>([]);
    const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
    const listReference = useRef<HTMLUListElement>(null);
    const panelHeadingReference = useRef<HTMLHeadingElement>(null);
    const historyControlReference = useRef<HTMLButtonElement>(null);
    const historyBackControlReference = useRef<HTMLButtonElement>(null);
    const markAllReadReference = useRef<HTMLButtonElement>(null);
    const clearReadConfirmReference = useRef<HTMLButtonElement>(null);
    const rowReferences = useRef(new Map<string, HTMLElement>());
    const historyFilters: ListNotificationsInput["filters"] = {
        readState: readFilter,
        ...(severityFilter === "all" ? {} : { severities: [severityFilter] }),
    };
    const bulkFilters = {
        filters: severityFilter === "all" ? {} : { severities: [severityFilter] },
    };
    const historyPathIsCurrent =
        historyCursors.length === 0 ||
        notificationCursorsMatch(historyCursors[0], latestResult?.nextCursor);
    const activeHistoryCursors = historyPathIsCurrent ? historyCursors : [];
    const historyCursor = activeHistoryCursors.at(-1);
    const historyRequested = historyCursor !== undefined;
    const historyNavigationVisible = historyCursors.length > 0;
    const history = useQuery(
        notificationHistoryPageQueryOptions(
            client,
            historyCursor,
            historyFilters,
            historyRequested
        )
    );

    useEffect(() => {
        if (historyPathIsCurrent || historyCursors.length === 0) return;
        const restoreHistoryFocus =
            document.activeElement === historyBackControlReference.current ||
            document.activeElement === historyControlReference.current;
        const latestHasHistory = latestResult?.nextCursor !== undefined;
        const resetTimer = setTimeout(() => {
            if (restoreHistoryFocus) {
                if (latestHasHistory) {
                    historyControlReference.current?.focus();
                } else {
                    panelHeadingReference.current?.focus();
                }
            }
            setHistoryCursors([]);
        }, 0);
        return () => clearTimeout(resetTimer);
    }, [historyCursors.length, historyPathIsCurrent, latestResult?.nextCursor]);
    const markRead = useMarkNotificationReadMutation();
    const deleteNotification = useDeleteNotificationMutation();
    const markAllRead = useMarkAllNotificationsReadMutation();
    const clearRead = useClearReadNotificationsMutation();
    const actionsDisabled = useIsMutating({ mutationKey: notificationMutationKey }) > 0;
    const historyRows = history.data?.notifications ?? emptyNotifications;
    const notifications = uniqueNotificationRows([...latestRows, ...historyRows])
        .filter((notification) =>
            notificationMatchesFilters(notification, readFilter, severityFilter)
        )
        .toSorted(
            (left, right) =>
                right.occurredAtMs - left.occurredAtMs || right.id.localeCompare(left.id)
        );
    const unreadCount = latestResult?.unreadCount;
    const readCount = latestResult?.readCount;
    const exactMutationError = markRead.error ?? deleteNotification.error;
    const bulkMutationError = markAllRead.error ?? clearRead.error;
    const actionError =
        notificationActionFailureMessage(exactMutationError, false) ??
        notificationActionFailureMessage(bulkMutationError, true);
    const clearReadFailure = notificationActionFailureMessage(clearRead.error, true);
    const historyTerminal =
        historyRequested &&
        history.data !== undefined &&
        history.data.nextCursor === undefined;
    let historyControlLabel = "Load older notifications";
    if (!historyPathIsCurrent && historyNavigationVisible) {
        historyControlLabel = "Returning to newest notifications…";
    } else if (historyRequested) {
        if (history.isFetching) {
            historyControlLabel = "Loading older notifications…";
        } else if (history.error !== null) {
            historyControlLabel = "Try loading this page again";
        } else if (historyTerminal) {
            historyControlLabel = "All available notifications loaded";
        } else {
            historyControlLabel = "Load next older page";
        }
    }
    let successMessage: string | undefined;
    if (clearRead.data !== undefined) {
        successMessage = `Deleted ${clearRead.data.affectedCount} read notifications.`;
    } else if (markAllRead.data !== undefined) {
        successMessage = `Marked ${markAllRead.data.affectedCount} notifications read.`;
    }

    const resetMutationFeedback = () => {
        markRead.reset();
        deleteNotification.reset();
        markAllRead.reset();
        clearRead.reset();
    };
    const focusRow = (id: string | undefined, selector?: string) => {
        setTimeout(() => {
            const row = id === undefined ? undefined : rowReferences.current.get(id);
            const target =
                selector === undefined ? row : row?.querySelector<HTMLElement>(selector);
            (target ?? listReference.current ?? panelHeadingReference.current)?.focus();
        }, 0);
    };
    const focusPanelHeading = () => {
        setTimeout(() => panelHeadingReference.current?.focus(), 0);
    };
    const markOneRead = (id: string) => {
        resetMutationFeedback();
        markRead.mutate(
            { id },
            {
                onError: () => focusRow(id, "[data-notification-mark-read]"),
                onSuccess: () => focusRow(id, "[data-notification-delete]"),
            }
        );
    };
    const deleteOne = (id: string) => {
        const index = notifications.findIndex((notification) => notification.id === id);
        const focusIdentity =
            notifications[index + 1]?.id ?? notifications[index - 1]?.id;
        resetMutationFeedback();
        deleteNotification.mutate(
            { id },
            {
                onError: () => focusRow(id, "[data-notification-delete]"),
                onSuccess: () => focusRow(focusIdentity),
            }
        );
    };
    const markFilteredRead = () => {
        resetMutationFeedback();
        markAllRead.mutate(bulkFilters, {
            onError: () => setTimeout(() => markAllReadReference.current?.focus(), 0),
            onSuccess: focusPanelHeading,
        });
    };
    const clearFilteredRead = () => {
        resetMutationFeedback();
        clearRead.mutate(bulkFilters, {
            onError: () =>
                setTimeout(() => clearReadConfirmReference.current?.focus(), 0),
            onSuccess: () => {
                setClearConfirmationOpen(false);
                focusPanelHeading();
            },
        });
    };
    const closeClearConfirmation = () => {
        setClearConfirmationOpen(false);
        clearRead.reset();
    };
    const loadNextHistoryPage = () => {
        if (!historyPathIsCurrent || history.isFetching || historyTerminal) return;
        if (!historyRequested) {
            const firstCursor = latestResult?.nextCursor;
            if (firstCursor !== undefined) setHistoryCursors([firstCursor]);
            return;
        }
        if (history.error !== null) {
            void history.refetch();
            return;
        }
        const nextCursor = history.data?.nextCursor;
        if (nextCursor !== undefined) {
            setHistoryCursors((cursors) => [...cursors, nextCursor]);
        }
    };
    const loadNewerHistoryPage = () => {
        if (history.isFetching) return;
        historyControlReference.current?.focus();
        setHistoryCursors((cursors) => cursors.slice(0, -1));
    };
    const setReadStateFilter = (filter: NotificationReadFilter) => {
        setHistoryCursors([]);
        setReadFilter(filter);
    };
    const setNotificationSeverityFilter = (filter: NotificationSeverityFilter) => {
        setHistoryCursors([]);
        setSeverityFilter(filter);
    };
    const retryLatest = () => onRetryLatest();

    return (
        <>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2
                        className="text-primary-50 font-semibold outline-none"
                        ref={panelHeadingReference}
                        tabIndex={-1}
                    >
                        Notifications
                    </h2>
                    <Text size="sm" tone="muted">
                        {unreadCount === undefined || readCount === undefined
                            ? "Counts unavailable"
                            : `${unreadCount} unread · ${readCount} read`}
                    </Text>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button
                        busy={markAllRead.isPending}
                        busyLabel="Marking read…"
                        disabled={
                            actionsDisabled ||
                            unreadCount === undefined ||
                            unreadCount === 0
                        }
                        onClick={markFilteredRead}
                        ref={markAllReadReference}
                        size="sm"
                        variant="secondary"
                    >
                        Mark all read
                    </Button>
                    <Button
                        disabled={
                            actionsDisabled || readCount === undefined || readCount === 0
                        }
                        onClick={() => setClearConfirmationOpen(true)}
                        size="sm"
                        variant="ghost"
                    >
                        Clear read
                    </Button>
                </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
                <Select
                    ariaLabel="Filter notifications by read state"
                    disabled={actionsDisabled}
                    onChange={setReadStateFilter}
                    options={readFilterOptions}
                    value={readFilter}
                />
                <Select
                    ariaLabel="Filter notifications by severity"
                    disabled={actionsDisabled}
                    onChange={setNotificationSeverityFilter}
                    options={severityFilterOptions}
                    value={severityFilter}
                />
            </div>

            <Alert className="mt-3" focusOnError={false} message={actionError} />
            <Alert
                action={
                    latestError === null ? undefined : (
                        <Button
                            disabled={actionsDisabled}
                            onClick={retryLatest}
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    )
                }
                className="mt-3"
                message={
                    latestError === null && history.error === null
                        ? undefined
                        : dashboardBrowserFailureMessage(latestError ?? history.error)
                }
            />
            <Alert className="mt-3" message={successMessage} variant="success" />

            {!latestReady && latestLoading && (
                <LoadingState label="Loading notifications…" size="sm" />
            )}
            {latestReady && notifications.length === 0 && (
                <EmptyState
                    className="mt-4 py-7"
                    description="Try another filter or wait for the next monitoring update."
                    title="No matching notifications"
                />
            )}
            {notifications.length > 0 && (
                <ul
                    aria-label="Notifications"
                    className="mt-4 max-h-[min(34rem,65vh)] space-y-2 overflow-y-auto pr-1 outline-none"
                    ref={listReference}
                    tabIndex={-1}
                >
                    {notifications.map((notification) => (
                        <NotificationListItem
                            actionsDisabled={actionsDisabled}
                            itemRef={(node) => {
                                if (node === null) {
                                    rowReferences.current.delete(notification.id);
                                } else {
                                    rowReferences.current.set(notification.id, node);
                                }
                            }}
                            key={notification.id}
                            notification={notification}
                            onDelete={deleteOne}
                            onMarkRead={markOneRead}
                        />
                    ))}
                </ul>
            )}

            {(latestResult?.nextCursor !== undefined || historyNavigationVisible) && (
                <Button
                    aria-busy={history.isFetching || undefined}
                    aria-disabled={
                        !historyPathIsCurrent ||
                        historyTerminal ||
                        history.isFetching ||
                        undefined
                    }
                    className="mt-3"
                    disabled={actionsDisabled}
                    fullWidth
                    onClick={loadNextHistoryPage}
                    ref={historyControlReference}
                    variant="secondary"
                >
                    {historyControlLabel}
                </Button>
            )}
            {historyNavigationVisible && (
                <Button
                    aria-busy={history.isFetching || undefined}
                    aria-disabled={history.isFetching || undefined}
                    className="mt-2"
                    disabled={actionsDisabled}
                    fullWidth
                    onClick={loadNewerHistoryPage}
                    ref={historyBackControlReference}
                    variant="ghost"
                >
                    {activeHistoryCursors.length === 1
                        ? "Back to newest notifications"
                        : "Load newer page"}
                </Button>
            )}

            <ConfirmModal
                busy={clearRead.isPending}
                confirmButtonRef={clearReadConfirmReference}
                confirmLabel="Clear read"
                danger
                description={
                    <>
                        Delete all read notifications matching the selected severity. This
                        cannot be undone.
                        {clearReadFailure !== undefined && (
                            <span className="mt-2 block text-red-300" role="alert">
                                {clearReadFailure}
                            </span>
                        )}
                    </>
                }
                onCancel={closeClearConfirmation}
                onConfirm={clearFilteredRead}
                open={clearConfirmationOpen}
                title="Clear read notifications?"
            />
        </>
    );
}
