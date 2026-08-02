import type { ManagedServiceRow } from "./types.ts";

type SafeTagPatternPart = { kind: "digits" } | { kind: "literal"; value: string };

function parseSafeTagRegexPattern(pattern: string): SafeTagPatternPart[] | undefined {
    if (pattern.length === 0 || pattern.length > 128) {
        return undefined;
    }
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
        return undefined;
    }

    let body = pattern.slice(1);
    while (body.endsWith("$")) {
        body = body.slice(0, -1);
    }
    if (!body) {
        return undefined;
    }

    const parts: SafeTagPatternPart[] = [];
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (character === undefined) {
            return undefined;
        }
        if (character === "\\") {
            const escaped = body[index + 1];
            if (!escaped) {
                return undefined;
            }
            if (escaped === "d" && body[index + 2] === "+") {
                if (parts.at(-1)?.kind === "digits") {
                    return undefined;
                }
                parts.push({ kind: "digits" });
                index += 2;
                if (/^\d$/u.test(body[index + 1] ?? "")) {
                    return undefined;
                }
                continue;
            }
            if (/^[-.+_]$/u.test(escaped)) {
                parts.push({ kind: "literal", value: escaped });
                index += 1;
                continue;
            }
            return undefined;
        }
        if (character === "[") {
            const closeIndex = body.indexOf("]", index + 1);
            if (closeIndex === -1 || body[closeIndex + 1] !== "+") {
                return undefined;
            }
            const characterClass = body.slice(index + 1, closeIndex);
            if (characterClass !== "0-9" && characterClass !== String.raw`\d`) {
                return undefined;
            }
            if (parts.at(-1)?.kind === "digits") {
                return undefined;
            }
            parts.push({ kind: "digits" });
            index = closeIndex + 1;
            if (/^\d$/u.test(body[index + 1] ?? "")) {
                return undefined;
            }
            continue;
        }
        if (/^[A-Za-z0-9_-]$/u.test(character)) {
            if (/^\d$/u.test(character) && parts.at(-1)?.kind === "digits") {
                return undefined;
            }
            parts.push({ kind: "literal", value: character });
            continue;
        }
        return undefined;
    }
    return parts;
}

export function isSafeTagRegexPattern(pattern: string): boolean {
    return parseSafeTagRegexPattern(pattern) !== undefined;
}

export function isSafeTagPatternMatch(pattern: string, tag: string): boolean {
    const parts = parseSafeTagRegexPattern(pattern);
    if (!parts) {
        return false;
    }

    let offset = 0;
    for (const part of parts) {
        if (part.kind === "literal") {
            if (tag[offset] !== part.value) {
                return false;
            }
            offset += 1;
            continue;
        }

        const digitStart = offset;
        while (offset < tag.length && /\d/u.test(tag[offset] ?? "")) {
            offset += 1;
        }
        if (offset === digitStart) {
            return false;
        }
    }
    return offset === tag.length;
}

export function isTagMatch(service: ManagedServiceRow, tag: string): boolean {
    if (!service.tag_match_pattern) {
        return tag === service.current_tag;
    }
    if (service.tag_match_type === "regex") {
        return isSafeTagPatternMatch(service.tag_match_pattern, tag);
    }
    return tag === service.tag_match_pattern;
}

export function shouldNeedFullTagScan(service: ManagedServiceRow): boolean {
    if (service.tag_match_type !== "regex" || !service.tag_match_pattern) {
        return false;
    }
    return isSafeTagRegexPattern(service.tag_match_pattern);
}

export function compareTags(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function hasUpdate(service: ManagedServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest)
        );
    }
    return Boolean(
        (service.latest_tag &&
            (!service.current_tag || service.latest_tag !== service.current_tag)) ||
        (service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest))
    );
}
