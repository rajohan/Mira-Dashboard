const dockerTagMaximumBytes = 128;
const dockerTagPatternMaximumBytes = 256;
const dockerTagTextPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

type SafeTagPatternPart =
    | { readonly kind: "digits" }
    | { readonly kind: "literal"; readonly value: string };

export type DockerTagMatchType = "exact" | "regex";

export interface DockerTagPolicy {
    readonly matchType: DockerTagMatchType;
    readonly pattern: string;
}

export interface DockerImageReference {
    readonly digest?: string;
    readonly name: string;
    readonly registry: "docker.io" | "ghcr.io" | "lscr.io";
    readonly repository: string;
    readonly tag?: string;
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function validDockerTag(value: string): boolean {
    return utf8Length(value) <= dockerTagMaximumBytes && dockerTagTextPattern.test(value);
}

function parseSafeTagRegexPattern(
    pattern: string
): readonly SafeTagPatternPart[] | undefined {
    if (
        utf8Length(pattern) > dockerTagPatternMaximumBytes ||
        !pattern.startsWith("^") ||
        !pattern.endsWith("$")
    ) {
        return undefined;
    }

    const body = pattern.slice(1, -1);
    if (body.length === 0) return undefined;

    const parts: SafeTagPatternPart[] = [];
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (character === undefined) return undefined;

        if (character === "\\") {
            const escaped = body[index + 1];
            if (escaped === "d" && body[index + 2] === "+") {
                if (parts.at(-1)?.kind === "digits") return undefined;
                parts.push(Object.freeze({ kind: "digits" }));
                index += 2;
                if (/^[0-9]$/u.test(body[index + 1] ?? "")) return undefined;
                continue;
            }
            if (escaped !== undefined && /^[-.+_]$/u.test(escaped)) {
                parts.push(Object.freeze({ kind: "literal", value: escaped }));
                index += 1;
                continue;
            }
            return undefined;
        }

        if (character === "[") {
            const closeIndex = body.indexOf("]", index + 1);
            const characterClass = body.slice(index + 1, closeIndex);
            if (
                closeIndex === -1 ||
                body[closeIndex + 1] !== "+" ||
                (characterClass !== "0-9" && characterClass !== String.raw`\d`) ||
                parts.at(-1)?.kind === "digits"
            ) {
                return undefined;
            }
            parts.push(Object.freeze({ kind: "digits" }));
            index = closeIndex + 1;
            if (/^[0-9]$/u.test(body[index + 1] ?? "")) return undefined;
            continue;
        }

        if (!/^[A-Za-z0-9_-]$/u.test(character)) return undefined;
        parts.push(Object.freeze({ kind: "literal", value: character }));
    }
    return Object.freeze(parts);
}

/**
 * @param pattern Candidate anchored tag pattern.
 * @returns Whether the pattern belongs to the deliberately non-backtracking grammar.
 */
export function isSafeDockerTagRegex(pattern: string): boolean {
    return parseSafeTagRegexPattern(pattern) !== undefined;
}

/**
 * @param policy Validated exact or safe-regex policy.
 * @param tag Registry tag to inspect.
 * @returns Whether the tag matches the policy.
 */
export function matchesDockerTagPolicy(policy: DockerTagPolicy, tag: string): boolean {
    if (!validDockerTag(tag)) return false;
    if (policy.matchType === "exact") return tag === policy.pattern;
    const parts = parseSafeTagRegexPattern(policy.pattern);
    if (parts === undefined) return false;

    let offset = 0;
    for (const part of parts) {
        if (part.kind === "literal") {
            if (tag[offset] !== part.value) return false;
            offset += 1;
            continue;
        }
        const start = offset;
        while (offset < tag.length && /^[0-9]$/u.test(tag[offset] ?? "")) {
            offset += 1;
        }
        if (offset === start) return false;
    }
    return offset === tag.length;
}

/**
 * @param input Current tag and optional Compose pattern labels.
 * @returns A validated policy, or undefined when the labels are unsafe.
 */
export function createDockerTagPolicy(input: {
    readonly currentTag?: string;
    readonly pattern?: string;
    readonly patternIsRegex?: boolean;
}): DockerTagPolicy | undefined {
    const pattern = input.pattern ?? input.currentTag;
    if (pattern === undefined) return undefined;
    const matchType =
        input.pattern === undefined || input.patternIsRegex === false ? "exact" : "regex";
    if (
        (matchType === "exact" && !validDockerTag(pattern)) ||
        (matchType === "regex" && !isSafeDockerTagRegex(pattern))
    ) {
        return undefined;
    }
    return Object.freeze({ matchType, pattern });
}

function compareDigitRuns(left: string, right: string): number {
    const normalizedLeft = left.replace(/^0+(?=\d)/u, "");
    const normalizedRight = right.replace(/^0+(?=\d)/u, "");
    if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length - normalizedRight.length;
    }
    let lexical = 0;
    if (normalizedLeft < normalizedRight) lexical = -1;
    if (normalizedLeft > normalizedRight) lexical = 1;
    return lexical === 0 ? left.length - right.length : lexical;
}

/**
 * @param left First tag.
 * @param right Second tag.
 * @returns Deterministic natural ordering for the bounded tag grammar.
 */
export function compareDockerTags(left: string, right: string): number {
    const leftParts = left.match(/\d+|\D+/gu) ?? [];
    const rightParts = right.match(/\d+|\D+/gu) ?? [];
    const maximum = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < maximum; index += 1) {
        const leftPart = leftParts[index];
        const rightPart = rightParts[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;
        const bothDigits = /^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart);
        if (bothDigits) {
            const compared = compareDigitRuns(leftPart, rightPart);
            if (compared !== 0) return compared;
            continue;
        }
        return leftPart < rightPart ? -1 : 1;
    }
    return 0;
}

function normalizedRegistry(value: string): DockerImageReference["registry"] | undefined {
    if (
        value === "docker.io" ||
        value === "index.docker.io" ||
        value === "registry-1.docker.io"
    ) {
        return "docker.io";
    }
    return value === "ghcr.io" || value === "lscr.io" ? value : undefined;
}

/**
 * @param value Compose image scalar.
 * @returns The parsed supported literal reference, or undefined when invalid.
 */
export function parseDockerImageReference(
    value: string
): DockerImageReference | undefined {
    if (
        value.length === 0 ||
        utf8Length(value) > 512 ||
        /[\s\p{Cc}\p{Cf}$]/u.test(value)
    ) {
        return undefined;
    }

    const atIndex = value.indexOf("@");
    if (atIndex !== -1 && atIndex !== value.lastIndexOf("@")) return undefined;
    const nameAndTag = atIndex === -1 ? value : value.slice(0, atIndex);
    const digest = atIndex === -1 ? undefined : value.slice(atIndex + 1);
    if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
        return undefined;
    }

    const lastSlash = nameAndTag.lastIndexOf("/");
    const lastColon = nameAndTag.lastIndexOf(":");
    const hasTag = lastColon > lastSlash;
    const rawName = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
    const tag = hasTag ? nameAndTag.slice(lastColon + 1) : undefined;
    if (tag !== undefined && !validDockerTag(tag)) return undefined;

    const segments = rawName.split("/");
    if (
        segments.length === 0 ||
        segments.some(
            (segment) =>
                segment.length === 0 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(segment)
        )
    ) {
        return undefined;
    }
    const first = segments[0]!;
    const hasExplicitRegistry =
        first === "localhost" || first.includes(".") || first.includes(":");
    const registry = normalizedRegistry(hasExplicitRegistry ? first : "docker.io");
    if (registry === undefined) return undefined;
    const repositorySegments = hasExplicitRegistry ? segments.slice(1) : segments;
    if (repositorySegments.length === 0) return undefined;
    const repository =
        registry === "docker.io" && repositorySegments.length === 1
            ? `library/${repositorySegments[0]}`
            : repositorySegments.join("/");
    return Object.freeze({
        ...(digest === undefined ? {} : { digest }),
        name: rawName,
        registry,
        repository,
        ...(tag === undefined ? {} : { tag }),
    });
}

/**
 * @param currentReference Existing literal Compose image scalar.
 * @param latest Registry-selected tag and digest.
 * @param pinMode Whether Compose stores the immutable digest or the selected tag.
 * @returns The exact replacement scalar, or undefined when an input is invalid.
 */
export function buildDockerTargetImageReference(
    currentReference: string,
    latest: { readonly digest: string; readonly tag: string },
    pinMode: "digest" | "tag"
): string | undefined {
    const current = parseDockerImageReference(currentReference);
    if (
        current === undefined ||
        !validDockerTag(latest.tag) ||
        !/^sha256:[0-9a-f]{64}$/u.test(latest.digest)
    ) {
        return undefined;
    }
    const tagged = `${current.name}:${latest.tag}`;
    return pinMode === "digest" ? `${tagged}@${latest.digest}` : tagged;
}
