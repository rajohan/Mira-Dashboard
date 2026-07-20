export interface LogRead {
    bytes: Buffer;
    content: string;
    startOffset: number;
    startsAtLineBoundary: boolean;
}

export interface LogLineEntry {
    line: string;
    lineId: string;
}

function isParseableJsonLine(line: string): boolean {
    try {
        JSON.parse(line);
        return true;
    } catch {
        return false;
    }
}

function isParseableLogLine(line: string): boolean {
    if (isParseableJsonLine(line)) {
        return true;
    }

    const braceIndex = line.indexOf("{");
    return braceIndex !== -1 && isParseableJsonLine(line.slice(braceIndex));
}

function isLikelyLogFragment(line: string): boolean {
    const trimmed = line.trimStart();
    if (!trimmed) return false;
    if (isParseableLogLine(line)) return false;
    return (
        trimmed.startsWith("{") ||
        trimmed.startsWith('"') ||
        trimmed.startsWith('",') ||
        trimmed.startsWith(',"')
    );
}

/** Returns complete tail lines with byte-offset IDs. */
export function lineEntriesFromLogRead(
    read: LogRead,
    lines: number | undefined,
    options: { includeBlankLines?: boolean } = {}
): LogLineEntry[] {
    if (!read.content) {
        return [];
    }

    const rawLines = read.content.split("\n");
    const lineOffsets = [String(read.startOffset)];
    for (const [index, byte] of read.bytes.entries()) {
        if (byte === 10) {
            lineOffsets.push(String(read.startOffset + index + 1));
        }
    }

    const firstCompleteLineIndex = read.startsAtLineBoundary ? 0 : 1;
    const firstUsableIndex = rawLines.findIndex(
        (line, index) =>
            index >= firstCompleteLineIndex && line.trim() && !isLikelyLogFragment(line)
    );
    const firstTailIndex =
        firstUsableIndex !== -1 && !options.includeBlankLines
            ? firstUsableIndex
            : firstCompleteLineIndex;
    const nonEmptyLineIndexes = rawLines
        .map((line, index) =>
            index >= firstTailIndex && line.trim() ? index : undefined
        )
        .filter((index): index is number => index !== undefined);
    const firstSelectedIndex =
        lines && nonEmptyLineIndexes.length > lines
            ? nonEmptyLineIndexes[nonEmptyLineIndexes.length - lines]!
            : options.includeBlankLines
              ? firstTailIndex
              : (nonEmptyLineIndexes[0] ?? firstTailIndex);

    return rawLines
        .slice(firstSelectedIndex)
        .map((line, index) => ({
            line,
            index: firstSelectedIndex + index,
            lineId: lineOffsets[firstSelectedIndex + index]!,
        }))
        .filter(
            (entry) =>
                (options.includeBlankLines || entry.line.trim()) &&
                !(
                    firstUsableIndex !== -1 &&
                    entry.index < firstUsableIndex &&
                    entry.line.trim() &&
                    isLikelyLogFragment(entry.line)
                )
        )
        .map((entry) => ({ line: entry.line, lineId: entry.lineId }));
}
