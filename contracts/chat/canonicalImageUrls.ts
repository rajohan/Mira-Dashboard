import { normalizeCanonicalChatMimeType } from "./canonicalAttachments";

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

/**
 * Removes an origin from a recognized Dashboard media route.
 * @param value Candidate Dashboard media URL.
 * @returns Portable root-relative media URL when recognized.
 */
export function canonicalChatPortableDashboardMediaUrl(
    value: string
): string | undefined {
    const parsed = parseChatUrl(value.trim());
    if (
        !parsed ||
        !dashboardMediaKind(parsed.url.pathname) ||
        !parsed.isSameDashboardOrigin
    ) {
        return undefined;
    }
    return `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`;
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
    return undefined;
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
