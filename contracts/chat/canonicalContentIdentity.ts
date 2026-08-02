const CANONICAL_MEDIA_BLOCK_TYPES = new Set(["image", "image_url", "input_image"]);
const CANONICAL_MEDIA_DATA_FIELDS = new Set([
    "base64",
    "contentBase64",
    "data",
    "dataUrl",
    "image_url",
]);

function unsigned32(value: number): number {
    return value < 0 ? value + 4_294_967_296 : value;
}

/**
 * Builds a compact deterministic fingerprint for canonical chat content.
 * @param content Content to fingerprint.
 * @returns Non-cryptographic content identity.
 */
export function canonicalChatContentFingerprint(content: string): string {
    let firstHash = 2_166_136_261;
    let secondHash = 2_654_435_761;
    for (let index = 0; index < content.length; index += 1) {
        const code = content.codePointAt(index) ?? 0;
        firstHash = Math.imul(firstHash ^ code, 16_777_619);
        secondHash = Math.imul(secondHash ^ code, 2_246_822_519);
    }
    return `${content.length}:${unsigned32(firstHash).toString(36)}:${unsigned32(
        secondHash
    ).toString(36)}`;
}

function canonicalChatRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function isCanonicalMediaRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (CANONICAL_MEDIA_BLOCK_TYPES.has(type)) {
        return true;
    }
    return (
        typeof record.fileName === "string" &&
        ["file", "image", "text"].includes(String(record.kind))
    );
}

function summarizedCanonicalMediaData(
    value: string,
    storedFingerprint?: string
): {
    contentFingerprint: string;
    length: number;
} {
    return {
        contentFingerprint: storedFingerprint || canonicalChatContentFingerprint(value),
        length: value.length,
    };
}

function summarizeCanonicalChatFingerprintValue(
    value: unknown,
    field: string,
    isMediaRecord: boolean,
    parentRecord?: Record<string, unknown>
): unknown {
    if (
        typeof value === "string" &&
        isMediaRecord &&
        (CANONICAL_MEDIA_DATA_FIELDS.has(field) || value.startsWith("data:image/"))
    ) {
        const storedFingerprint =
            field === "data" && typeof parentRecord?.dataFingerprint === "string"
                ? parentRecord.dataFingerprint
                : undefined;
        return summarizedCanonicalMediaData(value, storedFingerprint);
    }
    if (Array.isArray(value)) {
        return value.map((item) =>
            summarizeCanonicalChatFingerprintValue(item, "", isMediaRecord)
        );
    }
    const record = canonicalChatRecord(value);
    if (!record) {
        return value;
    }
    const nestedIsMediaRecord = isMediaRecord || isCanonicalMediaRecord(record);
    return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [
            key,
            summarizeCanonicalChatFingerprintValue(
                item,
                key,
                nestedIsMediaRecord,
                record
            ),
        ])
    );
}

/**
 * Replaces embedded media bytes with bounded identity metadata for hot-path
 * fingerprints while preserving text, tool, lifecycle, and provider fields.
 * @param value Canonical or provider chat value.
 * @returns Fingerprint-safe value without full embedded media payloads.
 */
export function summarizeCanonicalChatValueForFingerprint(value: unknown): unknown {
    return summarizeCanonicalChatFingerprintValue(value, "", false);
}
