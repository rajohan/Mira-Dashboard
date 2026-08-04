const utf8Encoder = new TextEncoder();

/**
 * Returns the encoded UTF-8 byte length of a string.
 * @param value String to encode.
 * @returns Encoded byte length.
 */
export function utf8ByteLength(value: string): number {
    return utf8Encoder.encode(value).byteLength;
}
