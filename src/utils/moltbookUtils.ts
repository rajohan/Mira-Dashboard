import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

const MOLTBOOK_URL = "https://www.moltbook.com";

/** Formats time for display. */
export function formatTime(dateStr: string): string {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: enUS });
}

/** Performs truncate. */
export function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

/** Returns moltbook URL. */
export function getMoltbookUrl(path: string): string {
    return MOLTBOOK_URL + path;
}
