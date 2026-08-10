/**
 * Converges mirrored cumulative and incremental provider text without repeating
 * an already-rendered suffix. Keeping this contract-independent lets both the
 * server and browser reducers share the exact rule without pulling validation
 * schemas into the browser bootstrap graph.
 * @param previous Previously projected text.
 * @param next Newly observed cumulative or incremental text.
 * @returns The converged projection text.
 */
export function mergeChatStreamText(previous: string, next: string): string {
    if (next.length === 0) return previous;
    if (previous.length === 0 || next.startsWith(previous)) return next;
    if (previous.endsWith(next)) return previous;
    return previous + next;
}
