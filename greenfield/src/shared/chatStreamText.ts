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
    const candidate = `${next}\u0000${previous.slice(-next.length)}`;
    const prefixLengths = new Uint32Array(candidate.length);
    for (let index = 1; index < candidate.length; index += 1) {
        let prefixLength = prefixLengths[index - 1] ?? 0;
        while (
            prefixLength > 0 &&
            candidate[index] !== candidate[prefixLength]
        ) {
            prefixLength = prefixLengths[prefixLength - 1] ?? 0;
        }
        if (candidate[index] === candidate[prefixLength]) prefixLength += 1;
        prefixLengths[index] = prefixLength;
    }
    const overlap = Math.min(prefixLengths.at(-1) ?? 0, next.length);
    return previous + next.slice(overlap);
}
