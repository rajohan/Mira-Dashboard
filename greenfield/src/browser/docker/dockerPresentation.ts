import type {
    DockerContainer,
    DockerContainerPort,
    DockerUpdaterService,
} from "../../contracts/docker.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";

export type DockerContainerSortField = "cpu" | "health" | "memory" | "name" | "state";

export interface DockerContainerSort {
    readonly direction: "ascending" | "descending";
    readonly field: DockerContainerSortField;
}

export const defaultDockerContainerSort: DockerContainerSort = Object.freeze({
    direction: "ascending",
    field: "name",
});

type BadgeVariant = "danger" | "default" | "info" | "success" | "warning";

/**
 * @param state Exact Engine state.
 * @returns Visual state treatment without changing Docker state semantics.
 */
export function dockerContainerStateVariant(
    state: DockerContainer["state"]
): BadgeVariant {
    switch (state) {
        case "running": {
            return "success";
        }
        case "paused":
        case "restarting": {
            return "warning";
        }
        case "dead":
        case "removing": {
            return "danger";
        }
        case "created":
        case "exited": {
            return "default";
        }
    }
}

/**
 * @param health Exact Engine health state.
 * @returns Visual health treatment without treating a missing check as healthy.
 */
export function dockerContainerHealthVariant(
    health: DockerContainer["health"]
): BadgeVariant {
    switch (health) {
        case "healthy": {
            return "success";
        }
        case "starting": {
            return "warning";
        }
        case "unhealthy": {
            return "danger";
        }
        case "none": {
            return "default";
        }
    }
}

/**
 * @param status Validated updater status.
 * @returns Visual updater treatment for current, pending, and unknown registry state.
 */
export function dockerUpdaterStatusVariant(
    status: DockerUpdaterService["status"]
): BadgeVariant {
    switch (status.state) {
        case "current": {
            return "success";
        }
        case "update-available": {
            return "warning";
        }
        case "unavailable": {
            return "danger";
        }
    }
}

export function dockerUpdaterStatusLabel(status: DockerUpdaterService["status"]): string {
    switch (status.state) {
        case "current": {
            return "Current";
        }
        case "update-available": {
            return "Update available";
        }
        case "unavailable": {
            return "Registry unavailable";
        }
    }
}

const inventoryOnlyReasonLabels: Readonly<
    Record<
        Extract<DockerUpdaterService["policy"], { state: "inventory-only" }>["reason"],
        string
    >
> = {
    "ambiguous-source": "ambiguous Compose source",
    disabled: "disabled",
    "invalid-policy": "invalid update policy",
    "missing-opt-in": "not opted in",
};

export function dockerUpdaterPolicyLabel(policy: DockerUpdaterService["policy"]): string {
    if (policy.state === "inventory-only") {
        return `Inventory only · ${inventoryOnlyReasonLabels[policy.reason]}`;
    }
    return `Managed · ${policy.automatic ? "automatic" : "manual"} · track ${policy.track}`;
}

export function formatDockerPort(port: DockerContainerPort): string {
    const target = `${port.containerPort}/${port.protocol}`;
    if (port.hostPort === undefined) return target;
    let scope = "host";
    if (port.hostScope === "all-interfaces") scope = "*";
    else if (port.hostScope === "loopback") scope = "127.0.0.1";
    return `${scope}:${port.hostPort} → ${target}`;
}

export function formatDockerMemory(container: DockerContainer): string {
    const stats = container.stats;
    if (stats === undefined) return "Unavailable";
    const limit =
        stats.memoryLimitBytes === 0
            ? "no limit"
            : formatByteCount(stats.memoryLimitBytes);
    return `${formatByteCount(stats.memoryUsedBytes)} / ${limit} (${formatPercent(stats.memoryPercent)})`;
}

function sortValue(
    container: DockerContainer,
    field: DockerContainerSortField
): number | string | undefined {
    switch (field) {
        case "cpu": {
            return container.stats?.cpuPercent;
        }
        case "health": {
            return container.health;
        }
        case "memory": {
            return container.stats?.memoryUsedBytes;
        }
        case "name": {
            return container.name;
        }
        case "state": {
            return container.state;
        }
    }
}

function compareValues(
    left: number | string | undefined,
    right: number | string | undefined
): number {
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right));
}

/**
 * @param containers Validated container rows.
 * @param sort Operator-selected field and direction.
 * @returns Stable sorted container rows with missing stats kept last.
 */
export function sortDockerContainers(
    containers: readonly DockerContainer[],
    sort: DockerContainerSort
): DockerContainer[] {
    return containers.toSorted((left, right) => {
        const leftValue = sortValue(left, sort.field);
        const rightValue = sortValue(right, sort.field);
        let missingDifference = 0;
        if (leftValue === undefined && rightValue !== undefined) missingDifference = 1;
        else if (rightValue === undefined && leftValue !== undefined) {
            missingDifference = -1;
        }
        if (missingDifference !== 0) return missingDifference;
        const difference = compareValues(leftValue, rightValue);
        if (difference !== 0) {
            return sort.direction === "ascending" ? difference : -difference;
        }
        return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
}

/** @returns Whether a row matches operator-visible identity, Compose, or port text. */
export function dockerContainerMatchesSearch(
    container: DockerContainer,
    search: string
): boolean {
    const query = search.trim().toLocaleLowerCase();
    if (query.length === 0) return true;
    return [
        container.name,
        container.image,
        container.id,
        container.project,
        container.service,
        container.state,
        container.health,
        ...container.ports.map(formatDockerPort),
        ...container.networks.flatMap((network) => [network.name, ...network.addresses]),
        ...container.mounts.flatMap((mount) => [
            mount.destination,
            mount.name,
            mount.type,
        ]),
    ]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase().includes(query));
}

export function humanizeDockerEventKind(kind: string): string {
    return kind.replaceAll("-", " ");
}
