/**
 * Returns the encoded UTF-8 byte length of a string.
 * @param value String to encode.
 * @returns Encoded byte length.
 */
export function utf8ByteLength(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const codePoint = value.codePointAt(index);
        if (codePoint === undefined) continue;
        if (codePoint <= 127) {
            bytes += 1;
        } else if (codePoint <= 2047) {
            bytes += 2;
        } else if (codePoint <= 65_535) {
            bytes += 3;
        } else {
            bytes += 4;
            index += 1;
        }
    }
    return bytes;
}
