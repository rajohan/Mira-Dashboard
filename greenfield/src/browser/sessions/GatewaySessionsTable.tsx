import {
    ArrowDown,
    ArrowUp,
    ArrowUpDown,
    PackageOpen,
    RotateCcw,
    Trash2,
} from "lucide-react";
import { useState, type MouseEvent } from "react";

import type {
    GatewaySession,
    GatewaySessionAction,
} from "../../contracts/gatewaySessions.ts";
import { gatewayPrimarySessionKey } from "../../contracts/gatewaySessions.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    type GatewaySessionSort,
    type GatewaySessionSortField,
    defaultGatewaySessionSort,
    gatewaySessionKindBadgeVariant,
    gatewaySessionKindLabels,
    gatewaySessionTokenLabel,
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
            className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
            scope="col"
        >
            <button
                aria-label={`Sort by ${label} ${nextDirection}`}
                className="hover:text-primary-50 focus-visible:ring-accent-300 inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2"
                onClick={() => onSort(field)}
                type="button"
            >
                {label}
                <Icon icon={SortIcon} size="sm" tone="inherit" />
            </button>
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

function actionRequest(
    action: GatewaySessionAction,
    session: GatewaySession,
    onRequestAction: GatewaySessionsTableProps["onRequestAction"]
) {
    return (event: MouseEvent<HTMLButtonElement>) =>
        onRequestAction(action, session, event.currentTarget);
}

function deleteTranscriptLabel(session: GatewaySession): string {
    if (session.key === gatewayPrimarySessionKey) {
        return `Delete ${session.displayName} transcript unavailable for the primary main session; key ${session.key}`;
    }
    if (session.sessionId === undefined) {
        return `Delete ${session.displayName} transcript unavailable because its generation is unknown; key ${session.key}`;
    }
    return `Delete ${session.displayName} transcript; key ${session.key}`;
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
        <div className="dashboard-data-table-query-container w-full max-w-full min-w-0">
            <section
                aria-label="Current OpenClaw sessions"
                className="dashboard-data-table-container border-primary-700 w-full max-w-full min-w-0 rounded-lg border"
            >
                <table
                    aria-label="Current OpenClaw sessions"
                    className="dashboard-data-table w-full min-w-224"
                >
                    <thead className="dashboard-data-table-head bg-primary-900 sticky top-0 z-10 shadow-sm">
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
                                className="text-primary-300 border-primary-700 border-b px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase"
                                scope="col"
                            >
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody className="dashboard-data-table-body">
                        {sortedSessions.map((session) => (
                            <tr
                                className="dashboard-data-table-row border-primary-700 border-b text-sm"
                                key={session.key}
                            >
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Type
                                    </span>
                                    <span className="dashboard-data-table-value">
                                        <Badge
                                            variant={gatewaySessionKindBadgeVariant(
                                                session.kind
                                            )}
                                        >
                                            {gatewaySessionKindLabels[session.kind]}
                                        </Badge>
                                    </span>
                                </td>
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Session
                                    </span>
                                    <span className="dashboard-data-table-value min-w-0">
                                        <span className="text-primary-100 flex flex-wrap items-center gap-2 font-medium">
                                            {session.displayName}
                                            {session.displayNameTruncated === true && (
                                                <Badge variant="warning">Truncated</Badge>
                                            )}
                                            {session.hasActiveRun && (
                                                <Badge variant="success">Running</Badge>
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
                                        {session.omittedMetadataFields !== undefined && (
                                            <Text
                                                as="span"
                                                className="mt-1 block"
                                                size="sm"
                                                tone="warning"
                                            >
                                                Metadata omitted:{" "}
                                                {session.omittedMetadataFields.join(", ")}
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
                                                    session.thinkingLevel === undefined
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
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Model
                                    </span>
                                    <span className="dashboard-data-table-value">
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
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Tokens
                                    </span>
                                    <span className="dashboard-data-table-value">
                                        {gatewaySessionTokenLabel(session)}
                                    </span>
                                </td>
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Last active
                                    </span>
                                    {session.updatedAtMs === undefined ? (
                                        <span className="dashboard-data-table-value">
                                            Unknown
                                        </span>
                                    ) : (
                                        <time
                                            className="dashboard-data-table-value"
                                            dateTime={new Date(
                                                session.updatedAtMs
                                            ).toISOString()}
                                        >
                                            {formatDashboardDateTime(session.updatedAtMs)}
                                        </time>
                                    )}
                                </td>
                                <td className="dashboard-data-table-cell min-w-0 p-3">
                                    <span
                                        aria-hidden="true"
                                        className="dashboard-data-table-label text-primary-400"
                                    >
                                        Actions
                                    </span>
                                    <span className="dashboard-data-table-value flex flex-wrap gap-1">
                                        <Button
                                            aria-label={`Compact ${session.displayName}; key ${session.key}`}
                                            disabled={busy}
                                            onClick={actionRequest(
                                                "compact",
                                                session,
                                                onRequestAction
                                            )}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            <Icon
                                                icon={PackageOpen}
                                                size="sm"
                                                tone="inherit"
                                            />
                                            Compact
                                        </Button>
                                        <Button
                                            aria-label={`Reset ${session.displayName}; key ${session.key}`}
                                            disabled={busy}
                                            onClick={actionRequest(
                                                "reset",
                                                session,
                                                onRequestAction
                                            )}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            <Icon
                                                icon={RotateCcw}
                                                size="sm"
                                                tone="inherit"
                                            />
                                            Reset
                                        </Button>
                                        <Button
                                            aria-label={deleteTranscriptLabel(session)}
                                            disabled={
                                                busy ||
                                                session.key ===
                                                    gatewayPrimarySessionKey ||
                                                session.sessionId === undefined
                                            }
                                            onClick={actionRequest(
                                                "delete",
                                                session,
                                                onRequestAction
                                            )}
                                            size="sm"
                                            variant="ghost"
                                        >
                                            <Icon
                                                icon={Trash2}
                                                size="sm"
                                                tone="inherit"
                                            />
                                            Delete
                                        </Button>
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
