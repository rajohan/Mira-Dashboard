import { formatDistanceToNow } from "date-fns";

const moltbookOrigin = "https://www.moltbook.com";

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

export function moltbookProfileUrl(name: string): string {
    return `${moltbookOrigin}/u/${pathSegment(name)}`;
}

export function moltbookSubmoltUrl(name: string): string {
    return `${moltbookOrigin}/m/${pathSegment(name)}`;
}

export function moltbookPostUrl(id: string): string {
    return `${moltbookOrigin}/post/${pathSegment(id)}`;
}

export function moltbookCommentUrl(postId: string, commentId: string): string {
    return `${moltbookPostUrl(postId)}#comment-${pathSegment(commentId)}`;
}

export function formatMoltbookTime(timestampMs: number): string {
    return formatDistanceToNow(new Date(timestampMs), { addSuffix: true });
}

export function truncateMoltbookText(text: string, maximumCharacters = 300): string {
    return text.length <= maximumCharacters
        ? text
        : `${text.slice(0, maximumCharacters)}…`;
}
