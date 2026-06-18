import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

const MOLTBOOK_URL = "https://www.moltbook.com";

/** Formats time for display. */
export function formatTime(dateString: string): string {
    const date = new Date(dateString);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) {
        return "Unknown";
    }

    return formatDistanceToNow(date, {
        addSuffix: true,
        locale: enUS,
    });
}

/** Performs truncate. */
export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...";
}

/** Returns moltbook URL. */
export function getMoltbookUrl(path: string): string {
    return MOLTBOOK_URL + path;
}
