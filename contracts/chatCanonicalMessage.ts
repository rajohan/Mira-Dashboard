import type {
    CanonicalChatAttachment,
    CanonicalChatImage,
    CanonicalChatThinking,
    CanonicalChatToolCall,
} from "./chatCanonical";

const CHAT_IMAGE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DASHBOARD_URL_FALLBACK_ORIGIN = "https://dashboard.invalid";

type DashboardMediaKind = "local" | "managed";

interface ParsedChatUrl {
    isRootRelative: boolean;
    isSameDashboardOrigin: boolean;
    url: URL;
}

interface DashboardMediaReference {
    kind: DashboardMediaKind;
    url: string;
}

/**
 * Returns a lowercase MIME type without optional parameters.
 * @param mimeType MIME type to normalize.
 * @returns Normalized MIME type.
 */
export function normalizeCanonicalChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function unsigned32(value: number): number {
    return value < 0 ? value + 4_294_967_296 : value;
}

function contentFingerprint(content: string): string {
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

function attachmentIdentity(attachment: CanonicalChatAttachment): string {
    const content =
        attachment.contentBase64 || attachment.dataUrl || attachment.url || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? contentFingerprint(content) : attachment.id,
    ].join("::");
}

function currentDashboardOrigin(): string | undefined {
    const locationValue = (
        globalThis as typeof globalThis & {
            location?: { origin?: string };
        }
    ).location;
    const origin = locationValue?.origin;
    return origin && origin !== "null" ? origin : undefined;
}

function parseChatUrl(value: string): ParsedChatUrl | undefined {
    if (value.startsWith("//")) {
        return undefined;
    }
    const dashboardOrigin = currentDashboardOrigin();
    const isRootRelative = value.startsWith("/");
    try {
        const url = new URL(value, dashboardOrigin || DASHBOARD_URL_FALLBACK_ORIGIN);
        return {
            isRootRelative,
            isSameDashboardOrigin:
                isRootRelative ||
                Boolean(dashboardOrigin && url.origin === dashboardOrigin),
            url,
        };
    } catch {
        return undefined;
    }
}

function dashboardMediaKind(pathname: string): DashboardMediaKind | undefined {
    if (pathname === "/api/media") {
        return "local";
    }
    return pathname.startsWith("/api/chat/media/outgoing/") ? "managed" : undefined;
}

function dashboardMediaReference(value: string): DashboardMediaReference | undefined {
    const candidate = value.trim();
    const parsed = parseChatUrl(candidate);
    if (!parsed) {
        return undefined;
    }
    const kind = dashboardMediaKind(parsed.url.pathname);
    if (!kind) {
        return undefined;
    }
    if (parsed.isSameDashboardOrigin) {
        return { kind, url: candidate };
    }
    if (currentDashboardOrigin() || !CHAT_IMAGE_URL_PROTOCOLS.has(parsed.url.protocol)) {
        return undefined;
    }
    // Backend normalization has no browser origin. Known Dashboard media routes
    // are portable, so remove the untrusted origin instead of either dropping
    // the preview or allowing an external host to become an inline image.
    return {
        kind,
        url: `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`,
    };
}

function dashboardMediaKindFromUrl(url: string): DashboardMediaKind | undefined {
    return dashboardMediaReference(url)?.kind;
}

function safeChatImageUrl(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const candidate = value.trim();
    if (!candidate) {
        return undefined;
    }
    if (candidate.startsWith("data:image/")) {
        return candidate;
    }
    const mediaReference = dashboardMediaReference(candidate);
    if (mediaReference) {
        return mediaReference.url;
    }
    const parsed = parseChatUrl(candidate);
    if (!parsed) {
        return undefined;
    }
    const mediaKind = parsed.isSameDashboardOrigin
        ? dashboardMediaKind(parsed.url.pathname)
        : undefined;
    if (parsed.isRootRelative) {
        return mediaKind ? candidate : undefined;
    }
    const isDashboardApiPath =
        parsed.url.pathname === "/api" || parsed.url.pathname.startsWith("/api/");
    if (isDashboardApiPath && !mediaKind && parsed.isSameDashboardOrigin) {
        return undefined;
    }
    return CHAT_IMAGE_URL_PROTOCOLS.has(parsed.url.protocol) ? candidate : undefined;
}

/**
 * Returns a local path encoded in a canonical Dashboard media URL.
 * @param url Dashboard media URL.
 * @returns Local path when the URL targets local Dashboard media.
 */
export function canonicalChatLocalMediaPathFromUrl(url: string): string | undefined {
    const mediaReference = dashboardMediaReference(url);
    if (mediaReference?.kind !== "local") {
        return undefined;
    }
    const parsed = parseChatUrl(mediaReference.url);
    return parsed?.url.searchParams.get("path")?.trim() || undefined;
}

function attachmentPreviewUrl(url: string, mode: "image" | "text"): string | undefined {
    const mediaReference = dashboardMediaReference(url);
    if (mediaReference) {
        const fragmentIndex = mediaReference.url.indexOf("#");
        const urlWithoutFragment =
            fragmentIndex === -1
                ? mediaReference.url
                : mediaReference.url.slice(0, fragmentIndex);
        const fragment =
            fragmentIndex === -1 ? "" : mediaReference.url.slice(fragmentIndex);
        if (/[?&]preview=(?:image|text)(?=&|$)/u.test(urlWithoutFragment)) {
            return `${urlWithoutFragment.replace(
                /[?&]preview=(?:image|text)(?=&|$)/u,
                (match) => `${match[0]}preview=${mode}`
            )}${fragment}`;
        }
        return `${urlWithoutFragment}${urlWithoutFragment.includes("?") ? "&" : "?"}preview=${mode}${fragment}`;
    }
    return mode === "image" ? safeChatImageUrl(url) : undefined;
}

/**
 * Returns a safe display URL for a canonical chat image.
 * @param url Candidate image URL.
 * @param mimeType Image MIME type.
 * @returns Safe display URL when the candidate is supported.
 */
export function canonicalChatImageDisplayUrl(
    url: string,
    mimeType: string
): string | undefined {
    const safeUrl = safeChatImageUrl(url);
    if (!safeUrl) {
        return undefined;
    }
    const mediaKind = dashboardMediaKindFromUrl(safeUrl);
    if (!mediaKind && !safeUrl.startsWith("data:image/")) {
        return undefined;
    }
    const isManagedMedia = mediaKind === "managed";
    return isManagedMedia || normalizeCanonicalChatMimeType(mimeType) === "image/svg+xml"
        ? attachmentPreviewUrl(safeUrl, "image")
        : safeUrl;
}

/**
 * Merges canonical image blocks without repeating identical payloads.
 * @param previous Previously collected images.
 * @param next Incoming images.
 * @returns Images in first-seen order.
 */
export function mergeCanonicalChatImages(
    previous: CanonicalChatImage[] = [],
    next: CanonicalChatImage[] = []
): CanonicalChatImage[] {
    const seen = new Set<string>();
    return [...previous, ...next].filter((image) => {
        const identity = JSON.stringify(image);
        if (seen.has(identity)) {
            return false;
        }
        seen.add(identity);
        return true;
    });
}

/**
 * Merges canonical attachments without repeating content identity.
 * @param previous Previously collected attachments.
 * @param next Incoming attachments.
 * @returns Attachments in first-seen order.
 */
export function mergeCanonicalChatAttachments(
    previous: CanonicalChatAttachment[] = [],
    next: CanonicalChatAttachment[] = []
): CanonicalChatAttachment[] {
    const seen = new Set<string>();
    return [...previous, ...next].filter((attachment) => {
        const identity = attachmentIdentity(attachment);
        if (seen.has(identity)) {
            return false;
        }
        seen.add(identity);
        return true;
    });
}

/**
 * Extracts image blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical image blocks.
 */
export function extractCanonicalChatImages(content: unknown): CanonicalChatImage[] {
    if (!Array.isArray(content)) {
        return [];
    }
    return content.filter((item): item is CanonicalChatImage => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            return false;
        }
        return ["image", "image_url", "input_image"].includes(
            String((item as { type?: unknown }).type)
        );
    });
}

/**
 * Extracts thinking blocks from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical thinking blocks.
 */
export function extractCanonicalChatThinking(content: unknown): CanonicalChatThinking[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: CanonicalChatThinking[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "thinking"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        let text = typeof record.text === "string" ? record.text : "";
        if (typeof record.thinking === "string") {
            text = record.thinking;
        }
        if (text.trim()) {
            blocks.push({ text });
        }
    }
    return blocks;
}

/**
 * Extracts tool calls from OpenClaw content.
 * @param content Provider content.
 * @returns Canonical tool calls.
 */
export function extractCanonicalChatToolCalls(content: unknown): CanonicalChatToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const calls: CanonicalChatToolCall[] = [];
    for (const item of content) {
        if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            (item as { type?: unknown }).type !== "toolCall"
        ) {
            continue;
        }
        const record = item as Record<string, unknown>;
        calls.push({
            arguments: record.arguments,
            id: typeof record.id === "string" ? record.id : undefined,
            name: typeof record.name === "string" ? record.name : "tool",
        });
    }
    return calls;
}

/**
 * Returns the display kind for a MIME type.
 * @param mimeType MIME type to classify.
 * @returns Canonical attachment kind.
 */
export function canonicalChatAttachmentKind(
    mimeType: string
): CanonicalChatAttachment["kind"] {
    const normalized = normalizeCanonicalChatMimeType(mimeType);
    if (normalized.startsWith("image/")) {
        return "image";
    }
    if (normalized === "application/json" || normalized.startsWith("text/")) {
        return "text";
    }
    return "file";
}

/**
 * Normalizes text from OpenClaw string and content-block variants.
 * @param content Provider content.
 * @returns Normalized text.
 */
export function normalizeCanonicalChatText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }
                if (!item || typeof item !== "object") {
                    return "";
                }
                const block = item as Record<string, unknown>;
                if (typeof block.text === "string") {
                    return block.text;
                }
                return ["image", "image_url", "input_image"].includes(String(block.type))
                    ? "[image]"
                    : "";
            })
            .filter(Boolean)
            .join("\n\n");
    }
    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        return typeof maybe.text === "string" ? maybe.text : "";
    }
    return "";
}
