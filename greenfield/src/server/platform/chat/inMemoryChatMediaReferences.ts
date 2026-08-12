import Path from "node:path";

import * as v from "valibot";

import { chatAttachmentIdSchema } from "../../../contracts/chatMedia.ts";
import type {
    PersistentGatewayChatMediaReferenceRegistrar,
    PersistentGatewayChatMediaSource,
    PersistentGatewayRegisteredLocalMedia,
} from "../gateway/persistentGatewayChatProvider.ts";

export const chatMediaReferenceMaximum = 2048;
export const chatMediaReferenceTtlMs = 10 * 60 * 1000;

export interface ChatMediaReference {
    readonly attachmentId: string;
    readonly messageId: string;
    readonly sessionKey: string;
    readonly source: PersistentGatewayChatMediaSource;
}

export interface InMemoryChatMediaReferences extends PersistentGatewayChatMediaReferenceRegistrar {
    readonly dispose: () => void;
    /** Compatibility boundary for existing managed-media callers. */
    readonly register: (
        reference: Omit<ChatMediaReference, "source"> &
            Readonly<{ source?: PersistentGatewayChatMediaSource }>
    ) => void;
    readonly resolve: (attachmentId: string) => ChatMediaReference | undefined;
}

export interface InMemoryChatMediaReferencesOptions {
    /** Absolute reviewed OpenClaw media directory, not the wider OpenClaw root. */
    readonly localMediaRoot?: string;
    readonly maximumReferences?: number;
    readonly nowMs?: () => number;
    readonly ttlMs?: number;
}

interface StoredReference extends ChatMediaReference {
    readonly expiresAtMs: number;
}

function boundedIdentity(value: string, maximum: number): string {
    if (
        value.length === 0 ||
        value.length > maximum ||
        value !== value.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(value)
    ) {
        throw new TypeError("Chat media reference is invalid");
    }
    return value;
}

function lengthPrefixedHash(values: readonly string[]): Uint8Array {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const value of values) {
        const bytes = Buffer.from(value, "utf8");
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.byteLength);
        hasher.update(length);
        hasher.update(bytes);
    }
    return hasher.digest();
}

function uuidV4FromHash(hash: Uint8Array): string {
    const bytes = Uint8Array.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6]! & 15) | 0x40;
    bytes[8] = (bytes[8]! & 63) | 0x80;
    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedFileUrlPath(candidate: string): string | undefined {
    if (!candidate.toLowerCase().startsWith("file:")) return candidate;
    try {
        const url = new URL(candidate);
        if (
            url.protocol !== "file:" ||
            (url.hostname !== "" && url.hostname.toLowerCase() !== "localhost") ||
            url.username !== "" ||
            url.password !== "" ||
            url.search !== "" ||
            url.hash !== ""
        ) {
            return undefined;
        }
        const decodedPath = decodeURIComponent(url.pathname);
        return decodedPath.includes("\\") ? undefined : decodedPath;
    } catch {
        return undefined;
    }
}

function localMediaSegments(
    candidate: string,
    localMediaRoot: string | undefined
): readonly string[] | undefined {
    if (
        localMediaRoot === undefined ||
        candidate.length === 0 ||
        candidate.length > 4096 ||
        candidate !== candidate.trim() ||
        /[\\\p{Cc}\p{Cf}]/u.test(candidate) ||
        candidate.startsWith("//")
    ) {
        return undefined;
    }
    const localPath = normalizedFileUrlPath(candidate);
    if (localPath === undefined || /^[a-z][a-z\d+.-]*:/iu.test(localPath)) {
        return undefined;
    }
    if (
        localPath.split(Path.sep).some((segment) => segment === "." || segment === "..")
    ) {
        return undefined;
    }
    const resolvedCandidate = Path.isAbsolute(localPath)
        ? Path.normalize(localPath)
        : Path.resolve(localMediaRoot, localPath);
    const relative = Path.relative(localMediaRoot, resolvedCandidate);
    if (
        relative.length === 0 ||
        Path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${Path.sep}`) ||
        Buffer.byteLength(relative, "utf8") > 4096
    ) {
        return undefined;
    }
    const segments = relative.split(Path.sep);
    if (
        segments.length === 0 ||
        segments.length > 256 ||
        segments.some(
            (segment) =>
                segment.length === 0 ||
                segment === "." ||
                segment === ".." ||
                Buffer.byteLength(segment, "utf8") > 255 ||
                /[\p{Cc}\p{Cf}]/u.test(segment)
        )
    ) {
        return undefined;
    }
    return Object.freeze(segments);
}

function sameSource(
    left: PersistentGatewayChatMediaSource,
    right: PersistentGatewayChatMediaSource
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "gateway-managed" && right.kind === "gateway-managed") {
        return left.upstreamAttachmentId === right.upstreamAttachmentId;
    }
    if (left.kind !== "openclaw-local-history" || right.kind !== left.kind) {
        return false;
    }
    return (
        left.segments.length === right.segments.length &&
        left.segments.every((segment, index) => segment === right.segments[index])
    );
}

function frozenSource(
    source: PersistentGatewayChatMediaSource
): PersistentGatewayChatMediaSource {
    if (source.kind === "gateway-managed") {
        return Object.freeze({
            kind: source.kind,
            upstreamAttachmentId: v.parse(
                chatAttachmentIdSchema,
                source.upstreamAttachmentId
            ),
        });
    }
    if (
        source.segments.length === 0 ||
        source.segments.length > 256 ||
        source.segments.some(
            (segment) =>
                segment.length === 0 ||
                Buffer.byteLength(segment, "utf8") > 255 ||
                /[/\\\p{Cc}\p{Cf}]/u.test(segment) ||
                segment === "." ||
                segment === ".."
        )
    ) {
        throw new TypeError("Chat media reference source is invalid");
    }
    return Object.freeze({
        kind: source.kind,
        segments: Object.freeze([...source.segments]),
    });
}

class InMemoryChatMediaReferencesImplementation implements InMemoryChatMediaReferences {
    readonly #localMediaRoot: string | undefined;
    readonly #maximumReferences: number;
    readonly #nowMs: () => number;
    readonly #references = new Map<string, StoredReference>();
    readonly #ttlMs: number;
    #disposed = false;

    constructor(options: InMemoryChatMediaReferencesOptions) {
        if (
            options.localMediaRoot !== undefined &&
            (!Path.isAbsolute(options.localMediaRoot) ||
                options.localMediaRoot !== options.localMediaRoot.trim() ||
                /[\p{Cc}\p{Cf}]/u.test(options.localMediaRoot))
        ) {
            throw new TypeError("Chat local media root is invalid");
        }
        this.#localMediaRoot =
            options.localMediaRoot === undefined
                ? undefined
                : Path.resolve(options.localMediaRoot);
        this.#maximumReferences = options.maximumReferences ?? chatMediaReferenceMaximum;
        this.#nowMs = options.nowMs ?? Date.now;
        this.#ttlMs = options.ttlMs ?? chatMediaReferenceTtlMs;
        if (
            !Number.isSafeInteger(this.#maximumReferences) ||
            this.#maximumReferences < 1 ||
            !Number.isSafeInteger(this.#ttlMs) ||
            this.#ttlMs < 1000 ||
            this.#ttlMs > 60 * 60 * 1000
        ) {
            throw new TypeError("Chat media reference policy is invalid");
        }
    }

    dispose(): void {
        this.#disposed = true;
        this.#references.clear();
    }

    register(
        reference: Omit<ChatMediaReference, "source"> &
            Readonly<{ source?: PersistentGatewayChatMediaSource }>
    ): void {
        this.#register({
            ...reference,
            source:
                reference.source ??
                Object.freeze({
                    kind: "gateway-managed" as const,
                    upstreamAttachmentId: reference.attachmentId,
                }),
        });
    }

    registerManaged(
        reference: Readonly<{
            attachmentId: string;
            messageId: string;
            sessionKey: string;
        }>
    ): void {
        this.#register({
            ...reference,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: reference.attachmentId,
            },
        });
    }

    registerLocal(
        reference: Readonly<{
            candidate: string;
            messageId: string;
            sessionKey: string;
            sourceSlot: string;
        }>
    ): PersistentGatewayRegisteredLocalMedia | undefined {
        if (this.#disposed) throw new TypeError("Chat media references are disposed");
        const candidate =
            typeof reference.candidate === "string" ? reference.candidate.trim() : "";
        const segments = localMediaSegments(candidate, this.#localMediaRoot);
        if (segments === undefined) return undefined;
        const sessionKey = boundedIdentity(reference.sessionKey, 512);
        const messageId = boundedIdentity(reference.messageId, 256);
        const sourceSlot = boundedIdentity(reference.sourceSlot, 256);
        const locatorFingerprint = Buffer.from(
            lengthPrefixedHash(["mira-chat-local-media-locator-v1", ...segments])
        ).toString("hex");
        const attachmentId = uuidV4FromHash(
            lengthPrefixedHash([
                "mira-chat-local-history-media-v1",
                sessionKey,
                messageId,
                sourceSlot,
                ...segments,
            ])
        );
        this.#register({
            attachmentId,
            messageId,
            sessionKey,
            source: { kind: "openclaw-local-history", segments },
        });
        return Object.freeze({
            attachmentId,
            fileName: segments.at(-1)!,
            locatorFingerprint,
        });
    }

    #register(reference: ChatMediaReference): void {
        if (this.#disposed) throw new TypeError("Chat media references are disposed");
        const attachmentId = v.parse(chatAttachmentIdSchema, reference.attachmentId);
        const sessionKey = boundedIdentity(reference.sessionKey, 512);
        const messageId = boundedIdentity(reference.messageId, 256);
        const source = frozenSource(reference.source);
        const now = this.#now();
        const current = this.#references.get(attachmentId);
        if (
            current !== undefined &&
            (current.sessionKey !== sessionKey ||
                current.messageId !== messageId ||
                !sameSource(current.source, source))
        ) {
            this.#references.delete(attachmentId);
            throw new TypeError("Chat media reference association changed");
        }
        if (current === undefined && this.#references.size >= this.#maximumReferences) {
            const oldest = this.#references.keys().next().value;
            if (oldest !== undefined) this.#references.delete(oldest);
        }
        this.#references.delete(attachmentId);
        this.#references.set(
            attachmentId,
            Object.freeze({
                attachmentId,
                expiresAtMs: now + this.#ttlMs,
                messageId,
                sessionKey,
                source,
            })
        );
    }

    resolve(attachmentId: string): ChatMediaReference | undefined {
        if (this.#disposed) return undefined;
        const parsed = v.safeParse(chatAttachmentIdSchema, attachmentId, {
            abortEarly: true,
        });
        if (!parsed.success) return undefined;
        const now = this.#now();
        const reference = this.#references.get(parsed.output);
        if (reference === undefined) return undefined;
        if (reference.expiresAtMs <= now) {
            // Preserve one stale association so the raw handler can revalidate it
            // against the authoritative message and let that read register it anew.
            this.#references.delete(parsed.output);
        }
        return Object.freeze({
            attachmentId: reference.attachmentId,
            messageId: reference.messageId,
            sessionKey: reference.sessionKey,
            source: reference.source,
        });
    }

    #now(): number {
        const now = this.#nowMs();
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new TypeError("Chat media reference clock is invalid");
        }
        return now;
    }
}

export function createInMemoryChatMediaReferences(
    options: InMemoryChatMediaReferencesOptions = {}
): InMemoryChatMediaReferences {
    return new InMemoryChatMediaReferencesImplementation(options);
}
