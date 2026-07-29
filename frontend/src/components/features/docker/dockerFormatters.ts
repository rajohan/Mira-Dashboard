import { formatDate } from "../../../utils/format";

const DOCKER_MEMORY_FACTORS = {
    B: 1,
    GIB: 1024 ** 3,
    GB: 1024 ** 3,
    KIB: 1024,
    KB: 1024,
    MIB: 1024 ** 2,
    MB: 1024 ** 2,
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
