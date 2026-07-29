/**
 * Returns a byte reader for Fetch streams whose runtime contract is Uint8Array chunks.
 *
 * Bun's current Fetch declarations expose the stream element as `any`; this helper
 * contains that platform type gap at one boundary.
 *
 * @param stream - Fetch request or response body stream.
 * @returns A typed byte reader when a body is present.
 */
export function byteStreamReader(
    stream: ReadableStream<unknown> | null | undefined
): ReadableStreamDefaultReader<Uint8Array> | undefined {
    return stream?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
}
