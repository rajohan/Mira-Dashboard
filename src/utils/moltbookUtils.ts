import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";

const MOLTBOOK_URL = "https://www.moltbook.com";

/** Handles format time. */
export function formatTime(dateStr: string): string {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: enUS });
}

/** Handles truncate. */
export function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

/** Handles get moltbook url. */
export function getMoltbookUrl(path: string): string {
    return MOLTBOOK_URL + path;
}
