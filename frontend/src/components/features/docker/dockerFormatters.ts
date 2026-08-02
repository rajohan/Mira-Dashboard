import type { DockerContainer } from "../../../../../contracts/docker/inventory";
import { formatDate } from "../../../utils/format";

const DOCKER_MEMORY_FACTORS = {
    B: 1,
    GIB: 1024 ** 3,
    GB: 1024 ** 3,
    KIB: 1024,
    KB: 1024,
    MIB: 1024 ** 2,
    MB: 1024 ** 2,
    PIB: 1024 ** 5,
    PB: 1024 ** 5,
    TIB: 1024 ** 4,
    TB: 1024 ** 4,
};

function parseDockerMemoryPart(part: string): number | undefined {
    const match = part.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]i?B|B)$/i);
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    const unitValue = match[2];
    if (!unitValue) {
        return undefined;
    }

    const unit = unitValue.toUpperCase() as keyof typeof DOCKER_MEMORY_FACTORS;
    const factor = DOCKER_MEMORY_FACTORS[unit];
    return factor ? amount * factor : undefined;
}

/** Parses a Docker percentage string for numeric table sorting. */
export function parseDockerPercent(value: string | undefined): number {
    if (!value) return -1;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : -1;
}

/** Parses the used side of a Docker memory summary as MiB. */
export function parseDockerMemoryUsedMiB(value: string | undefined): number {
    if (!value) return -1;
    const used = value.split("/", 1)[0]?.trim();
    if (!used) return -1;
    const usedBytes = parseDockerMemoryPart(used);
    return usedBytes === undefined ? -1 : usedBytes / 1024 ** 2;
}

/** Formats the used side of a Docker memory summary as decimal MB or GB. */
export function formatDockerMemoryUsed(value: string | undefined): string {
    const usedMiB = parseDockerMemoryUsedMiB(value);
    if (!Number.isFinite(usedMiB) || usedMiB < 0) return "-";

    const usedMb = usedMiB * 1.048576;
    if (usedMb >= 1024) return `${(usedMb / 1024).toFixed(2)} GB`;
    return `${usedMb.toFixed(0)} MB`;
}

/** Ranks Docker health values for stable table sorting. */
export function dockerContainerHealthRank(health: string): number {
    switch (health) {
        case "healthy": {
            return 0;
        }
        case "starting": {
            return 1;
        }
        case "unknown": {
            return 2;
        }
        case "unhealthy": {
            return 3;
        }
        default: {
            return 4;
        }
    }
}

/** Selects the status badge variant for Docker container health. */
export function dockerContainerHealthVariant(
    container: DockerContainer
): "success" | "warning" | "error" | "default" {
    if (container.health === "healthy") return "success";
    if (container.health === "unhealthy") return "error";
    if (container.state === "running") return "warning";
    return "default";
}

/** Selects the status badge variant for a Docker container state. */
export function dockerContainerStateVariant(
    state: string
): "success" | "warning" | "error" | "default" {
    if (state === "running") return "success";
    if (state === "exited") return "error";
    if (state === "restarting" || state === "created") return "warning";
    return "default";
}

/** Ranks Docker container states for stable table sorting. */
export function dockerContainerStateRank(state: string): number {
    switch (state) {
        case "running": {
            return 0;
        }
        case "restarting": {
            return 1;
        }
        case "created": {
            return 2;
        }
        case "paused": {
            return 3;
        }
        case "exited": {
            return 4;
        }
        case "dead": {
            return 5;
        }
        default: {
            return 6;
        }
    }
}

/**
 * Formats bytes for display.
 * @param bytes Bytes value.
 * @returns Formatted bytes for display.
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(unitIndex === 0 || value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Formats Docker memory for display.
 * @param value Value to process.
 * @returns Formatted Docker memory for display.
 */
export function formatDockerMemory(value?: string): string {
    if (!value) {
        return "—";
    }

    const [usedRaw, totalRaw] = value.split("/").map((part) => part.trim());
    if (!usedRaw || !totalRaw) {
        return value;
    }

    const usedBytes = parseDockerMemoryPart(usedRaw);
    const totalBytes = parseDockerMemoryPart(totalRaw);

    if (usedBytes === undefined || totalBytes === undefined) {
        return value;
    }

    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

/**
 * Formats timestamp for display.
 * @param value Value to process.
 * @returns Formatted timestamp for display.
 */
export function formatTimestamp(value?: string): string {
    if (!value) {
        return "—";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return formatDate(date);
}

/**
 * Formats updater transition for display.
 * @param event Event to handle.
 * @returns Formatted updater transition for display.
 */
export function formatUpdaterTransition(event: {
    fromDigest?: string;
    fromTag?: string;
    toDigest?: string;
    toTag?: string;
}): string {
    const from = formatVersionDisplay(event.fromTag, event.fromDigest);
    const to = formatVersionDisplay(event.toTag, event.toDigest);
    return `${from} → ${to}`;
}

/**
 * Formats version display for display.
 * @param tag Tag value.
 * @param digest Digest value.
 * @returns Formatted version display for display.
 */
export function formatVersionDisplay(tag?: string, digest?: string): string {
    if (tag) {
        return tag;
    }

    if (digest) {
        return digest.slice(0, 12);
    }

    return "—";
}

/**
 * Formats full version display for display.
 * @param tag Tag value.
 * @param digest Digest value.
 * @returns Formatted full version display for display.
 */
export function formatFullVersionDisplay(tag?: string, digest?: string): string {
    if (tag && digest) {
        return `${tag} (${digest})`;
    }

    if (tag) {
        return tag;
    }

    if (digest) {
        return digest;
    }

    return "—";
}
