import {
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    PackageOpen,
    RotateCcw,
    Trash2,
} from "lucide-react";
import { useState } from "react";

import type {
    GatewaySession,
    GatewaySessionAction,
} from "../../contracts/gatewaySessions.ts";
import { gatewayPrimarySessionKey } from "../../contracts/gatewaySessions.ts";
import { cn } from "../lib/classNames.ts";
import {
    formatDashboardDateTime,
    formatDashboardRelativeTime,
} from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { dashboardDataTableClassNames } from "../ui/dataTableStyles.ts";
import { DropdownMenu } from "../ui/DropdownMenu.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { Text } from "../ui/Text.tsx";
import {
    type GatewaySessionSort,
    type GatewaySessionSortField,
    defaultGatewaySessionSort,
    gatewaySessionKindBadgeVariant,
    gatewaySessionKindLabels,
    gatewaySessionTokenPresentation,
    sortGatewaySessions,
} from "./gatewaySessionPresentation.ts";

interface SortHeaderProps {
    readonly field: GatewaySessionSortField;
    readonly label: string;
    readonly onSort: (field: GatewaySessionSortField) => void;
    readonly sort: GatewaySessionSort;
}

function SortHeader({ field, label, onSort, sort }: SortHeaderProps) {
    const active = sort.field === field;
    const nextDirection =
        active && sort.direction === "ascending" ? "descending" : "ascending";
    let SortIcon = ArrowUpDown;
    if (active) SortIcon = sort.direction === "ascending" ? ArrowUp : ArrowDown;
    return (
        <th
            aria-sort={active ? sort.direction : "none"}
            className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
            scope="col"
        >
            <Button
                aria-label={`Sort by ${label} ${nextDirection}`}
                className="hover:text-primary-50 focus-visible:ring-accent-300 inline-flex items-center gap-1 rounded-sm"
                onClick={() => onSort(field)}
                type="button"
                variant="unstyled"
            >
                {label}
                <Icon icon={SortIcon} size="sm" tone="inherit" />
            </Button>
        </th>
    );
}

export interface GatewaySessionsTableProps {
    readonly busy?: boolean;
    readonly onRequestAction: (
        action: GatewaySessionAction,
        session: GatewaySession,
        trigger: HTMLButtonElement
    ) => void;
    readonly sessions: readonly GatewaySession[];
}

function deleteTranscriptDescription(session: GatewaySession): string {
    if (session.key === gatewayPrimarySessionKey) {
        return "Unavailable for the primary main session.";
    }
    if (session.sessionId === undefined) {
        return "Unavailable because the current session version could not be confirmed.";
    }
    return "Permanently delete this session and its transcript.";
}

interface SessionActionMenuProps {
    readonly busy: boolean;
    readonly onRequestAction: GatewaySessionsTableProps["onRequestAction"];
    readonly session: GatewaySession;
}

function SessionActionMenu({ busy, onRequestAction, session }: SessionActionMenuProps) {
    return (
        <DropdownMenu
            actions={[
                {
                    description: "Reduce older context while keeping the session.",
                    icon: PackageOpen,
                    id: "compact",
                    label: "Compact session",
                    onSelect: (trigger) => onRequestAction("compact", session, trigger),
                },
                {
                    description: "Replace active context before the next run.",
                    icon: RotateCcw,
                    id: "reset",
                    label: "Reset session",
                    onSelect: (trigger) => onRequestAction("reset", session, trigger),
                    tone: "danger",
                },
                {
                    description: deleteTranscriptDescription(session),
                    disabled:
                        session.key === gatewayPrimarySessionKey ||
                        session.sessionId === undefined,
                    icon: Trash2,
                    id: "delete",
                    label: "Delete session",
                    onSelect: (trigger) => onRequestAction("delete", session, trigger),
                    tone: "danger",
                },
            ]}
            disabled={busy}
            triggerLabel={`Actions for ${session.displayName}; key ${session.key}`}
        />
    );
}

function GatewaySessionMobileCard({
    busy,
    onRequestAction,
    session,
}: SessionActionMenuProps) {
    const tokenUsage = gatewaySessionTokenPresentation(session);
    const tokenPercent =
        tokenUsage.maximum === undefined || tokenUsage.value === undefined
            ? undefined
            : Math.round(
                  Math.min(100, Math.max(0, tokenUsage.value / tokenUsage.maximum) * 100)
              );

    return (
        <li
            aria-label={`${session.displayName} session`}
            className="border-primary-700 bg-primary-950/40 rounded-lg border p-4 shadow-sm shadow-black/10"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={gatewaySessionKindBadgeVariant(session.kind)}>
                            {gatewaySessionKindLabels[session.kind]}
                        </Badge>
                        {session.hasActiveRun && <Badge variant="success">Running</Badge>}
                    </div>
                    <p className="text-primary-100 mt-2 line-clamp-2 text-sm font-medium wrap-break-word">
                        {session.displayName}
                    </p>
                </div>
                <div className="shrink-0">
                    <SessionActionMenu
                        busy={busy}
                        onRequestAction={onRequestAction}
                        session={session}
                    />
                </div>
            </div>

            <dl className="text-primary-400 mt-4 space-y-3 text-sm">
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <dt>Model</dt>
                    <dd className="text-primary-200 min-w-0 truncate text-right">
                        {session.model ?? "Unknown"}
                    </dd>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
                    <dt>Tokens</dt>
                    <dd
                        aria-label={tokenUsage.accessibleLabel}
                        className="text-primary-200 whitespace-nowrap tabular-nums"
                        title={tokenUsage.accessibleLabel}
                    >
                        {tokenUsage.compactLabel}
                        {tokenPercent === undefined ? "" : ` · ${tokenPercent}%`}
                    </dd>
                    {tokenUsage.maximum !== undefined &&
                        tokenUsage.value !== undefined && (
                            <dd className="col-span-2">
                                <ProgressBar
                                    className="w-full"
                                    label={`Token context used for ${session.displayName}`}
                                    maximum={tokenUsage.maximum}
                                    size="sm"
                                    value={tokenUsage.value}
                                />
                            </dd>
                        )}
                </div>
                <div className="flex items-center justify-between gap-3">
                    <dt>Last active</dt>
                    <dd className="text-primary-200 text-right">
                        {session.updatedAtMs === undefined ? (
                            "Unknown"
                        ) : (
                            <time
                                dateTime={new Date(session.updatedAtMs).toISOString()}
                                title={formatDashboardDateTime(session.updatedAtMs)}
                            >
                                {formatDashboardRelativeTime(session.updatedAtMs)}
                            </time>
                        )}
                    </dd>
                </div>
            </dl>
        </li>
    );
}

/** @returns Sortable desktop table that becomes labelled session cards on narrow containers. */
export function GatewaySessionsTable({
    busy = false,
    onRequestAction,
    sessions,
}: GatewaySessionsTableProps) {
    const [sort, setSort] = useState<GatewaySessionSort>(defaultGatewaySessionSort);
    const sortedSessions = sortGatewaySessions(sessions, sort);

    function toggleSort(field: GatewaySessionSortField) {
        setSort((current) => ({
            direction:
                current.field === field && current.direction === "ascending"
                    ? "descending"
                    : "ascending",
            field,
        }));
    }

    return (
        <div className={dashboardDataTableClassNames.queryContainer}>
            <ul
                aria-label="Current OpenClaw sessions"
                className="space-y-3 @min-[66rem]:hidden"
            >
                {sortedSessions.map((session) => (
                    <GatewaySessionMobileCard
                        busy={busy}
                        key={session.key}
                        onRequestAction={onRequestAction}
                        session={session}
                    />
                ))}
            </ul>
            <section
                aria-label="Current OpenClaw sessions"
                className={cn(
                    dashboardDataTableClassNames.scrollContainer,
                    "hidden @min-[66rem]:block"
                )}
            >
                <table
                    aria-label="Current OpenClaw sessions"
                    className={cn(dashboardDataTableClassNames.table, "min-w-224")}
                >
                    <thead className={dashboardDataTableClassNames.head}>
                        <tr>
                            <SortHeader
                                field="kind"
                                label="Type"
                                onSort={toggleSort}
                                sort={sort}
                            />
                            <SortHeader
                                field="displayName"
                                label="Session"
                                onSort={toggleSort}
                                sort={sort}
                            />
                            <SortHeader
                                field="model"
                                label="Model"
                                onSort={toggleSort}
                                sort={sort}
                            />
                            <SortHeader
                                field="totalTokens"
                                label="Tokens"
                                onSort={toggleSort}
                                sort={sort}
                            />
                            <SortHeader
                                field="updatedAtMs"
                                label="Last active"
                                onSort={toggleSort}
                                sort={sort}
                            />
                            <th
                                className="text-primary-300 border-primary-700 bg-primary-950 border-b px-3 py-2 text-center text-xs font-semibold tracking-wide uppercase"
                                scope="col"
                            >
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody className={dashboardDataTableClassNames.body}>
                        {sortedSessions.map((session) => {
                            const tokenUsage = gatewaySessionTokenPresentation(session);
                            return (
                                <tr
                                    className={dashboardDataTableClassNames.row}
                                    key={session.key}
                                >
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Type
                                        </span>
                                        <span
                                            className={dashboardDataTableClassNames.value}
                                        >
                                            <Badge
                                                variant={gatewaySessionKindBadgeVariant(
                                                    session.kind
                                                )}
                                            >
                                                {gatewaySessionKindLabels[session.kind]}
                                            </Badge>
                                        </span>
                                    </td>
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Session
                                        </span>
                                        <span
                                            className={dashboardDataTableClassNames.value}
                                        >
                                            <span className="text-primary-100 flex flex-wrap items-center gap-2 font-medium">
                                                {session.displayName}
                                                {session.displayNameTruncated ===
                                                    true && (
                                                    <Badge variant="warning">
                                                        Truncated
                                                    </Badge>
                                                )}
                                                {session.hasActiveRun && (
                                                    <Badge variant="success">
                                                        Running
                                                    </Badge>
                                                )}
                                            </span>
                                            <Text
                                                as="span"
                                                className="mt-1 block font-mono wrap-anywhere"
                                                size="sm"
                                                tone="muted"
                                            >
                                                {session.key}
                                            </Text>
                                            {session.channel !== undefined && (
                                                <Text
                                                    as="span"
                                                    className="mt-1 block"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    Channel: {session.channel}
                                                </Text>
                                            )}
                                            {session.omittedMetadataFields !==
                                                undefined && (
                                                <Text
                                                    as="span"
                                                    className="mt-1 block"
                                                    size="sm"
                                                    tone="warning"
                                                >
                                                    Some details were not shown:{" "}
                                                    {session.omittedMetadataFields.join(
                                                        ", "
                                                    )}
                                                </Text>
                                            )}
                                            {(session.status !== undefined ||
                                                session.thinkingLevel !== undefined) && (
                                                <Text
                                                    as="span"
                                                    className="mt-1 block"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    {[
                                                        session.status,
                                                        session.thinkingLevel ===
                                                        undefined
                                                            ? undefined
                                                            : `thinking ${session.thinkingLevel}`,
                                                    ]
                                                        .filter(
                                                            (value): value is string =>
                                                                value !== undefined
                                                        )
                                                        .join(" · ")}
                                                </Text>
                                            )}
                                        </span>
                                    </td>
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Model
                                        </span>
                                        <span
                                            className={dashboardDataTableClassNames.value}
                                        >
                                            <Text as="span">
                                                {session.model ?? "Unknown"}
                                            </Text>
                                            {session.modelProvider !== undefined && (
                                                <Text
                                                    as="span"
                                                    className="mt-1 block"
                                                    size="sm"
                                                    tone="muted"
                                                >
                                                    {session.modelProvider}
                                                </Text>
                                            )}
                                        </span>
                                    </td>
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Tokens
                                        </span>
                                        <span
                                            className={cn(
                                                dashboardDataTableClassNames.value,
                                                "flex items-center gap-2"
                                            )}
                                        >
                                            <span
                                                aria-label={tokenUsage.accessibleLabel}
                                                className="whitespace-nowrap tabular-nums"
                                                title={tokenUsage.accessibleLabel}
                                            >
                                                {tokenUsage.compactLabel}
                                            </span>
                                            {tokenUsage.maximum !== undefined &&
                                                tokenUsage.value !== undefined && (
                                                    <ProgressBar
                                                        className="w-16 shrink-0"
                                                        label={`Token context used for ${session.displayName}`}
                                                        maximum={tokenUsage.maximum}
                                                        size="sm"
                                                        value={tokenUsage.value}
                                                    />
                                                )}
                                        </span>
                                    </td>
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Last active
                                        </span>
                                        {session.updatedAtMs === undefined ? (
                                            <span
                                                className={
                                                    dashboardDataTableClassNames.value
                                                }
                                            >
                                                Unknown
                                            </span>
                                        ) : (
                                            <time
                                                className={
                                                    dashboardDataTableClassNames.value
                                                }
                                                dateTime={new Date(
                                                    session.updatedAtMs
                                                ).toISOString()}
                                                title={formatDashboardDateTime(
                                                    session.updatedAtMs
                                                )}
                                            >
                                                {formatDashboardRelativeTime(
                                                    session.updatedAtMs
                                                )}
                                            </time>
                                        )}
                                    </td>
                                    <td className={dashboardDataTableClassNames.cell}>
                                        <span
                                            aria-hidden="true"
                                            className={dashboardDataTableClassNames.label}
                                        >
                                            Actions
                                        </span>
                                        <span
                                            className={cn(
                                                dashboardDataTableClassNames.value,
                                                "flex justify-center"
                                            )}
                                        >
                                            <SessionActionMenu
                                                busy={busy}
                                                onRequestAction={onRequestAction}
                                                session={session}
                                            />
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
