import type {
    GatewaySession,
    GatewaySessionAction,
    GatewaySessionFilter,
    GatewaySessionKind,
} from "../../contracts/gatewaySessions.ts";
import {
    compareGatewaySessions,
    gatewayPrimarySessionKey,
} from "../../contracts/gatewaySessions.ts";
import { formatCompactCount } from "../lib/formatMeasurements.ts";

export const gatewaySessionFilterLabels: Readonly<Record<GatewaySessionFilter, string>> =
    {
        ALL: "ALL",
        CRON: "CRON",
        HOOK: "HOOK",
        MAIN: "MAIN",
        SUBAGENT: "SUBAGENT",
    };

export const gatewaySessionKindLabels: Readonly<Record<GatewaySessionKind, string>> = {
    cron: "Cron",
    hook: "Hook",
    main: "Main",
    subagent: "Subagent",
    unknown: "Unknown",
};

export type GatewaySessionSortField =
    | "displayName"
    | "kind"
    | "model"
    | "totalTokens"
    | "updatedAtMs";

export interface GatewaySessionSort {
    readonly direction: "ascending" | "descending";
    readonly field: GatewaySessionSortField;
}

export const defaultGatewaySessionSort: GatewaySessionSort = {
    direction: "ascending",
    field: "kind",
};

function compareOptionalStrings(left: string | undefined, right: string | undefined) {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined) {
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
}

function compareByField(
    left: GatewaySession,
    right: GatewaySession,
    field: GatewaySessionSortField
): number {
    switch (field) {
        case "displayName": {
            return compareOptionalStrings(left.displayName, right.displayName);
        }
        case "kind": {
            const canonical = compareGatewaySessions(left, right);
            return canonical;
        }
        case "model": {
            return compareOptionalStrings(left.model, right.model);
        }
        case "totalTokens": {
            return compareOptionalNumbers(left.totalTokens, right.totalTokens);
        }
        case "updatedAtMs": {
            return compareOptionalNumbers(left.updatedAtMs, right.updatedAtMs);
        }
    }
}

/**
 * Sorts rows without allowing any column direction to dislodge the primary main session.
 * @param sessions Validated bounded current-session rows.
 * @param sort Accessible table sort state.
 * @returns A new stable row array.
 */
export function sortGatewaySessions(
    sessions: readonly GatewaySession[],
    sort: GatewaySessionSort
): GatewaySession[] {
    return sessions.toSorted((left, right) => {
        const leftIsPrimary = left.key === gatewayPrimarySessionKey;
        const rightIsPrimary = right.key === gatewayPrimarySessionKey;
        if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
        const fieldDifference = compareByField(left, right, sort.field);
        if (fieldDifference !== 0) {
            return sort.direction === "ascending" ? fieldDifference : -fieldDifference;
        }
        if (left.key < right.key) return -1;
        if (left.key > right.key) return 1;
        return 0;
    });
}

/** @returns Whether one normalized row is visible under an operator filter. */
export function gatewaySessionMatchesFilter(
    session: GatewaySession,
    filter: GatewaySessionFilter
): boolean {
    return filter === "ALL" || session.kind === filter.toLowerCase();
}

export interface GatewaySessionTokenPresentation {
    readonly accessibleLabel: string;
    readonly compactLabel: string;
    readonly maximum?: number;
    readonly value?: number;
}

/** @returns Compact token copy, exact accessible detail, and a fresh bounded meter. */
export function gatewaySessionTokenPresentation(
    session: Pick<GatewaySession, "contextTokens" | "totalTokens" | "totalTokensFresh">
): GatewaySessionTokenPresentation {
    if (session.totalTokens === undefined) {
        return {
            accessibleLabel: "Session token use: Unknown",
            compactLabel: "Unknown",
        };
    }
    const formatter = new Intl.NumberFormat();
    const exactUsage =
        session.contextTokens === undefined
            ? formatter.format(session.totalTokens)
            : `${formatter.format(session.totalTokens)} of ${formatter.format(session.contextTokens)}`;
    const compactUsage =
        session.contextTokens === undefined
            ? formatCompactCount(session.totalTokens)
            : `${formatCompactCount(session.totalTokens)} / ${formatCompactCount(session.contextTokens)}`;
    const current = session.totalTokensFresh;
    return {
        accessibleLabel: `Session token use: ${exactUsage}, ${current ? "current" : "out of date"}`,
        compactLabel: `${current ? "" : "~"}${compactUsage}${current ? "" : " (last known)"}`,
        maximum:
            current && session.contextTokens !== undefined
                ? session.contextTokens
                : undefined,
        value:
            current && session.contextTokens !== undefined
                ? session.totalTokens
                : undefined,
    };
}

/** @returns Visual kind treatment without implying online health. */
export function gatewaySessionKindBadgeVariant(
    kind: GatewaySessionKind
): "default" | "info" | "success" | "warning" {
    switch (kind) {
        case "main": {
            return "info";
        }
        case "subagent": {
            return "success";
        }
        case "hook": {
            return "warning";
        }
        case "cron": {
            return "default";
        }
        case "unknown": {
            return "default";
        }
    }
}

export interface GatewaySessionConfirmationCopy {
    readonly confirmLabel: string;
    readonly danger: boolean;
    readonly description: string;
    readonly title: string;
}

/** @returns Exact confirmation copy for one explicit upstream control. */
export function gatewaySessionConfirmationCopy(
    action: GatewaySessionAction,
    displayName: string
): GatewaySessionConfirmationCopy {
    switch (action) {
        case "compact": {
            return {
                confirmLabel: "Compact session",
                danger: false,
                description: `Compact older context for “${displayName}”? This keeps the session but reduces how much previous conversation it carries forward.`,
                title: "Compact session?",
            };
        }
        case "reset": {
            return {
                confirmLabel: "Reset session",
                danger: true,
                description: `Reset “${displayName}”? Its active context will be replaced before the next run.`,
                title: "Reset session?",
            };
        }
        case "delete": {
            return {
                confirmLabel: "Delete session",
                danger: true,
                description: `Delete “${displayName}” and its OpenClaw transcript? This cannot be undone from the Dashboard.`,
                title: "Delete session?",
            };
        }
    }
}
