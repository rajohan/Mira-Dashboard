import { useInfiniteQuery, useIsMutating } from "@tanstack/react-query";
import { useRef, useState } from "react";

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
import { InfiniteScrollTrigger } from "../ui/InfiniteScrollTrigger.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
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
    notificationHistoryQueryOptions,
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
    const [historyEnabled, setHistoryEnabled] = useState(false);
    const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
    const panelHeadingReference = useRef<HTMLHeadingElement>(null);
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
    const firstHistoryCursor = latestResult?.nextCursor;
    const history = useInfiniteQuery(
        notificationHistoryQueryOptions(
            client,
            historyEnabled ? firstHistoryCursor : undefined,
            historyFilters
        )
    );
    const historyPageError = history.isFetchNextPageError ? history.error : null;
    const historyRefreshError = history.isFetchNextPageError ? null : history.error;
    const markRead = useMarkNotificationReadMutation();
    const deleteNotification = useDeleteNotificationMutation();
    const markAllRead = useMarkAllNotificationsReadMutation();
    const clearRead = useClearReadNotificationsMutation();
    const actionsDisabled = useIsMutating({ mutationKey: notificationMutationKey }) > 0;
    const historyRows =
        history.data?.pages.flatMap((page) => page.notifications) ?? emptyNotifications;
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
            (target ?? panelHeadingReference.current)?.focus();
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
        if (!historyEnabled) {
            setHistoryEnabled(true);
            return;
        }
        void history.fetchNextPage();
    };
    const setReadStateFilter = (filter: NotificationReadFilter) => {
        setHistoryEnabled(false);
        setReadFilter(filter);
    };
    const setNotificationSeverityFilter = (filter: NotificationSeverityFilter) => {
        setHistoryEnabled(false);
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
                    historyRefreshError === null ? undefined : (
                        <Button
                            disabled={actionsDisabled}
                            onClick={() => void history.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    )
                }
                className="mt-3"
                message={
                    historyRefreshError === null
                        ? undefined
                        : dashboardBrowserFailureMessage(historyRefreshError)
                }
            />
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
                    latestError === null
                        ? undefined
                        : dashboardBrowserFailureMessage(latestError)
                }
            />
            <Alert className="mt-3" message={successMessage} variant="success" />

            {!latestReady && latestLoading && (
                <LoadingState label="Loading notifications…" size="sm" />
            )}
            {latestReady && notifications.length === 0 && (
                <>
                    <EmptyState
                        className="mt-4 py-7"
                        description="Try another filter or wait for the next monitoring update."
                        title="No matching notifications"
                    />
                    {firstHistoryCursor !== undefined && (
                        <InfiniteScrollTrigger
                            className="py-2"
                            {...(historyPageError === null
                                ? {}
                                : {
                                      error: dashboardBrowserFailureMessage(
                                          historyPageError
                                      ),
                                  })}
                            hasMore={!historyEnabled || history.hasNextPage}
                            loading={historyEnabled && history.isFetching}
                            loadingLabel="Loading older notifications…"
                            onLoadMore={loadNextHistoryPage}
                        />
                    )}
                </>
            )}
            {notifications.length > 0 && (
                <VirtualizedList
                    className="mt-4 max-h-[min(34rem,65vh)] pr-1 outline-none"
                    estimateSize={() => 176}
                    getKey={(notification) => notification.id}
                    itemClassName="pb-2"
                    items={notifications}
                    label="Notifications"
                    pagination={{
                        ...(historyPageError === null
                            ? {}
                            : {
                                  error: dashboardBrowserFailureMessage(historyPageError),
                              }),
                        hasMore:
                            firstHistoryCursor !== undefined &&
                            (!historyEnabled || history.hasNextPage),
                        loading: historyEnabled && history.isFetching,
                        loadingLabel: "Loading older notifications…",
                        onLoadMore: loadNextHistoryPage,
                    }}
                    renderItem={(notification) => (
                        <NotificationListItem
                            actionsDisabled={actionsDisabled}
                            itemRef={(node) => {
                                if (node === null) {
                                    rowReferences.current.delete(notification.id);
                                } else {
                                    rowReferences.current.set(notification.id, node);
                                }
                            }}
                            notification={notification}
                            onDelete={deleteOne}
                            onMarkRead={markOneRead}
                        />
                    )}
                />
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
