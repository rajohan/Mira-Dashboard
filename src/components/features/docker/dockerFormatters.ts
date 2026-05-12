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

/** Formats docker memory for display. */
export function formatDockerMemory(value: string | undefined): string {
    if (!value) {
        return "—";
    }

    const [usedRaw, totalRaw] = value.split("/").map((part) => part.trim());
    if (!usedRaw || !totalRaw) {
        return value;
    }

    /** Parses part. */
    const parsePart = (part: string): number | null => {
        const match = part.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]i?B|B)$/i);
        if (!match) {
            return null;
        }

        const amount = Number.parseFloat(match[1] || "0");
        const unit = (match[2] || "B").toUpperCase();
        const factors: Record<string, number> = {
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

        return amount * (factors[unit] || 1);
    };

    const usedBytes = parsePart(usedRaw);
    const totalBytes = parsePart(totalRaw);

    if (!usedBytes || !totalBytes) {
        return value;
    }

    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

/** Formats timestamp for display. */
export function formatTimestamp(value: string | null | undefined): string {
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
    fromTag: string | null;
    toTag: string | null;
    fromDigest: string | null;
    toDigest: string | null;
}): string {
    const from = formatVersionDisplay(event.fromTag, event.fromDigest);
    const to = formatVersionDisplay(event.toTag, event.toDigest);
    return `${from} → ${to}`;
}

/** Formats version display for display. */
export function formatVersionDisplay(tag: string | null, digest: string | null): string {
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
    tag: string | null,
    digest: string | null
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
