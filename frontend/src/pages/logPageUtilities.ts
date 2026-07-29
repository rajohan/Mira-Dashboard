import type { LogFile } from "../../../contracts/logs";

const LOG_BOTTOM_THRESHOLD_PX = 24;

export type LogViewportElement = Pick<
    HTMLDivElement,
    "clientHeight" | "scrollHeight" | "scrollTop"
>;

/**
 * Returns whether a log viewport is currently scrolled near the bottom.
 * @param viewport Viewport value.
 * @returns Whether a log viewport is currently scrolled near the bottom.
 */
export function isLogViewportAtBottom(viewport: LogViewportElement | undefined): boolean {
    if (!viewport) {
        return false;
    }

    return (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        LOG_BOTTOM_THRESHOLD_PX
    );
}

/**
 * Scrolls a log viewport to the bottom when present.
 * @param viewport Viewport value.
 * @returns Scroll log viewport to bottom result.
 */
export function scrollLogViewportToBottom(
    viewport: LogViewportElement | undefined
): boolean {
    if (!viewport) {
        return false;
    }

    viewport.scrollTop = viewport.scrollHeight;
    return true;
}

/**
 * Scrolls a log viewport to the bottom and reports the new scroll position.
 * @param viewport Viewport value.
 * @param onScrolled Callback invoked to handle scrolled.
 * @returns Scroll log viewport to bottom and report result.
 */
export function scrollLogViewportToBottomAndReport(
    viewport: LogViewportElement | undefined,
    onScrolled: (scrollTop: number) => void
): boolean {
    if (!viewport) {
        return false;
    }

    scrollLogViewportToBottom(viewport);
    onScrolled(viewport.scrollTop);
    return true;
}

/**
 * Returns whether an unknown value is a named log file.
 * @param file File to process.
 * @returns Whether an unknown value is a named log file.
 */
export function isNamedLogFile(file: unknown): file is LogFile {
    if (!file || typeof file !== "object") {
        return false;
    }
    const { name } = file as { name?: unknown };
    return typeof name === "string" && name.trim().length > 0;
}

function logFileName(file: { name?: unknown }): string {
    return typeof file.name === "string" ? file.name : "";
}

/**
 * Sorts log filenames newest-first according to their generated names.
 * @param first First value.
 * @param second Second value.
 * @returns Sorted log filenames newest-first according to their generated names.
 */
export function compareLogFileNamesDescending(
    first: { name?: unknown },
    second: { name?: unknown }
): number {
    return logFileName(second).localeCompare(logFileName(first));
}

export function readNumericLogLineId(log: {
    lineId?: number | string;
}): number | undefined {
    const rawLineId = log.lineId;
    if (typeof rawLineId === "string" && !rawLineId.trim()) {
        return undefined;
    }

    const lineId = Number(rawLineId);
    return Number.isFinite(lineId) ? lineId : undefined;
}

/**
 * Sorts streamed log entries by their numeric source line identifier.
 * @param first First value.
 * @param second Second value.
 * @returns Sorted streamed log entries by their numeric source line identifier.
 */
export function compareLogEntriesByLineId(
    first: { lineId?: number | string },
    second: { lineId?: number | string }
): number {
    const firstLineId = readNumericLogLineId(first);
    const secondLineId = readNumericLogLineId(second);

    if (firstLineId !== undefined && secondLineId !== undefined) {
        return firstLineId - secondLineId;
    }
    if (firstLineId !== undefined) {
        return -1;
    }
    return secondLineId === undefined ? 0 : 1;
}

/**
 * Formats the visible and total log-entry counts.
 * @param visibleCount Visible count.
 * @param totalCount Total count.
 * @returns Formatted the visible and total log-entry counts.
 */
export function formatLogEntryCount(visibleCount: number, totalCount: number): string {
    const suffix = visibleCount === 1 ? "entry" : "entries";
    return visibleCount === totalCount
        ? `${visibleCount} ${suffix}`
        : `${visibleCount} of ${totalCount} ${totalCount === 1 ? "entry" : "entries"}`;
}
