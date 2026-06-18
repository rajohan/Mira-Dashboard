import { formatDate } from "../../../utils/format";

/** Formats bytes for display. */
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

    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Formats Docker memory for display. */
export function formatDockerMemory(value: string | undefined): string {
    if (!value) {
        return "—";
    }

    const [usedRaw, totalRaw] = value.split("/").map((part) => part.trim());
    if (!usedRaw || !totalRaw) {
        return value;
    }

    /** Parses part. */
    const parsePart = (part: string): number | undefined => {
        const match = part.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]i?B|B)$/i);
        if (!match) {
            return undefined;
        }

        const amount = Number(match[1]);
        const factors = {
            B: 1,
            KIB: 1024,
            KB: 1024,
            MIB: 1024 ** 2,
            MB: 1024 ** 2,
            GIB: 1024 ** 3,
            GB: 1024 ** 3,
            TIB: 1024 ** 4,
            TB: 1024 ** 4,
        };
        const unit = match[2].toUpperCase() as keyof typeof factors;
        const factor = factors[unit];
        if (!factor) {
            return undefined;
        }

        return amount * factor;
    };

    const usedBytes = parsePart(usedRaw);
    const totalBytes = parsePart(totalRaw);

    if (usedBytes === undefined || totalBytes === undefined) {
        return value;
    }

    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

/** Formats timestamp for display. */
export function formatTimestamp(value: string | undefined | undefined): string {
    if (!value) {
        return "—";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return formatDate(date);
}

/** Formats updater transition for display. */
export function formatUpdaterTransition(event: {
    fromTag: string | undefined;
    toTag: string | undefined;
    fromDigest: string | undefined;
    toDigest: string | undefined;
}): string {
    const from = formatVersionDisplay(event.fromTag, event.fromDigest);
    const to = formatVersionDisplay(event.toTag, event.toDigest);
    return `${from} → ${to}`;
}

/** Formats version display for display. */
export function formatVersionDisplay(
    tag: string | undefined,
    digest: string | undefined
): string {
    if (tag) {
        return tag;
    }

    if (digest) {
        return digest.slice(0, 12);
    }

    return "—";
}

/** Formats full version display for display. */
export function formatFullVersionDisplay(
    tag: string | undefined,
    digest: string | undefined
): string {
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
