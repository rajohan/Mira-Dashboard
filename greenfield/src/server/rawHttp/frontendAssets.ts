import path from "node:path";

import {
    createImmutableReleaseFileReader,
    type ImmutableReleaseFileIdentity,
    type ImmutableReleaseFileTestHooks,
} from "../platform/filesystem/immutableReleaseFile.ts";
import type { RuntimeRelease } from "../platform/release/runtimeRelease.ts";

const frontendAssetFailureMessage = "Frontend release assets are invalid";
const maximumHeaderBytes = 4096;
const maximumHeaderItems = 32;
const maximumPublicAssetCount = 1024;
const maximumPublicAssetBytes = 64 * 1024 * 1024;
const hashedAssetPattern = /-[a-z\d]{8}\.[A-Za-z0-9]+$/u;
const canonicalRequestPathPattern = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]*$/u;
const contentTypes: Readonly<Record<string, string>> = Object.freeze({
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
});

/** Raw HTTP handler that owns browser artifacts and controlled SPA navigation. */
export type FrontendAssetHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

/** Deterministic immutable-file hooks exposed only to adversarial tests. */
export interface FrontendAssetHandlerTestHooks {
    readonly file?: ImmutableReleaseFileTestHooks;
}

interface FrontendAssetRepresentations {
    readonly brotli?: ImmutableReleaseFileIdentity;
    readonly gzip?: ImmutableReleaseFileIdentity;
    readonly identity: ImmutableReleaseFileIdentity;
    readonly publicPath: string;
}

interface SelectedRepresentation {
    readonly contentEncoding?: "br" | "gzip";
    readonly identity: ImmutableReleaseFileIdentity;
}

function frontendAssetFailure(): Error {
    return new Error(frontendAssetFailureMessage);
}

function fixedSecurityHeaders(): Headers {
    return new Headers({
        "content-security-policy": [
            "default-src 'none'",
            "base-uri 'none'",
            "connect-src 'self'",
            "font-src 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "img-src 'self' data:",
            "manifest-src 'self'",
            "object-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
        ].join("; "),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
    });
}

function noStoreResponse(body: string | null, status: number): Response {
    const headers = fixedSecurityHeaders();
    headers.set("cache-control", "no-store");
    return new Response(body, { headers, status });
}

function baseArtifactPath(artifactPath: string): string {
    if (artifactPath.endsWith(".br")) return artifactPath.slice(0, -3);
    if (artifactPath.endsWith(".gz")) return artifactPath.slice(0, -3);
    return artifactPath;
}

function publicPathForArtifact(artifactPath: string): string | undefined {
    if (artifactPath === "browser/index.html") return "/";
    if (artifactPath.startsWith("browser/assets/")) {
        return artifactPath.slice("browser".length);
    }
    return undefined;
}

function buildFrontendAssetIndex(
    release: RuntimeRelease
): ReadonlyMap<string, FrontendAssetRepresentations> {
    const artifacts = new Map(
        release.manifest.artifacts.map((artifact) => [artifact.path, artifact])
    );
    const publicAssets = new Map<string, FrontendAssetRepresentations>();
    for (const artifact of release.manifest.artifacts) {
        if (!artifact.path.startsWith("browser/")) continue;
        if (artifact.path === "browser/bundle-metrics.json") continue;
        if (artifact.path.endsWith(".br") || artifact.path.endsWith(".gz")) {
            if (!artifacts.has(baseArtifactPath(artifact.path))) {
                throw frontendAssetFailure();
            }
            continue;
        }
        const publicPath = publicPathForArtifact(artifact.path);
        if (
            publicPath === undefined ||
            contentTypes[path.extname(artifact.path)] === undefined
        ) {
            throw frontendAssetFailure();
        }
        const brotli = artifacts.get(`${artifact.path}.br`);
        const gzip = artifacts.get(`${artifact.path}.gz`);
        const entry = Object.freeze({
            ...(brotli === undefined ? {} : { brotli }),
            ...(gzip === undefined ? {} : { gzip }),
            identity: artifact,
            publicPath,
        });
        if (publicAssets.has(publicPath)) throw frontendAssetFailure();
        publicAssets.set(publicPath, entry);
        if (publicPath === "/") publicAssets.set("/index.html", entry);
    }
    if (!publicAssets.has("/")) throw frontendAssetFailure();
    return publicAssets;
}

function qualityValue(value: string): number | undefined {
    if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/u.test(value)) return undefined;
    const quality = Number(value);
    return Number.isFinite(quality) ? quality : undefined;
}

function acceptedEncodingQualities(header: string | null): ReadonlyMap<string, number> {
    const qualities = new Map<string, number>();
    if (header === null || Buffer.byteLength(header) > maximumHeaderBytes) {
        return qualities;
    }
    const items = header.split(",");
    if (items.length > maximumHeaderItems) return qualities;
    for (const item of items) {
        const [rawName, ...parameters] = item.trim().split(";");
        const name = rawName?.trim().toLowerCase();
        if (!name || !/^(?:br|gzip|identity|\*)$/u.test(name)) continue;
        let quality = 1;
        let valid = true;
        for (const parameter of parameters) {
            const match = /^q\s*=\s*(.+)$/iu.exec(parameter.trim());
            if (!match) {
                valid = false;
                break;
            }
            const parsed = qualityValue(match[1] ?? "");
            if (parsed === undefined) {
                valid = false;
                break;
            }
            quality = parsed;
        }
        if (valid) qualities.set(name, quality);
    }
    return qualities;
}

function effectiveEncodingQuality(
    qualities: ReadonlyMap<string, number>,
    encoding: "br" | "gzip" | "identity"
): number {
    const exact = qualities.get(encoding);
    if (exact !== undefined) return exact;
    if (encoding === "identity") return qualities.get("*") === 0 ? 0 : 1;
    return qualities.get("*") ?? 0;
}

function selectRepresentation(
    asset: FrontendAssetRepresentations,
    acceptEncoding: string | null
): SelectedRepresentation | undefined {
    const qualities = acceptedEncodingQualities(acceptEncoding);
    const candidates: Array<
        Readonly<{
            contentEncoding?: "br" | "gzip";
            identity: ImmutableReleaseFileIdentity;
            quality: number;
            rank: number;
        }>
    > = [
        {
            identity: asset.identity,
            quality: effectiveEncodingQuality(qualities, "identity"),
            rank: 0,
        },
    ];
    if (asset.gzip) {
        candidates.push({
            contentEncoding: "gzip",
            identity: asset.gzip,
            quality: effectiveEncodingQuality(qualities, "gzip"),
            rank: 1,
        });
    }
    if (asset.brotli) {
        candidates.push({
            contentEncoding: "br",
            identity: asset.brotli,
            quality: effectiveEncodingQuality(qualities, "br"),
            rank: 2,
        });
    }
    const selected = candidates
        .filter(({ quality }) => quality > 0)
        .toSorted(
            (left, right) => right.quality - left.quality || right.rank - left.rank
        )[0];
    if (!selected) return undefined;
    return Object.freeze({
        ...(selected.contentEncoding === undefined
            ? {}
            : { contentEncoding: selected.contentEncoding }),
        identity: selected.identity,
    });
}

function headerAcceptsHtml(header: string | null): boolean {
    if (header === null) return true;
    if (Buffer.byteLength(header) > maximumHeaderBytes) return false;
    const items = header.split(",");
    if (items.length > maximumHeaderItems) return false;
    return items.some((item) => {
        const [rawMediaType, ...parameters] = item.trim().split(";");
        const mediaType = rawMediaType?.trim().toLowerCase();
        if (
            mediaType !== "text/html" &&
            mediaType !== "application/xhtml+xml" &&
            mediaType !== "*/*"
        ) {
            return false;
        }
        let quality = 1;
        let qualitySeen = false;
        for (const parameter of parameters) {
            const match = /^q\s*=\s*(.+)$/iu.exec(parameter.trim());
            if (!match) continue;
            if (qualitySeen) return false;
            qualitySeen = true;
            const parsed = qualityValue(match[1] ?? "");
            if (parsed === undefined) return false;
            quality = parsed;
        }
        return quality > 0;
    });
}

function isReservedApplicationPath(pathname: string): boolean {
    return (
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/assets" ||
        pathname.startsWith("/assets/") ||
        pathname === "/trpc" ||
        pathname.startsWith("/trpc")
    );
}

function controlledSpaFallback(request: Request, pathname: string): boolean {
    return (
        !isReservedApplicationPath(pathname) &&
        canonicalRequestPathPattern.test(pathname) &&
        !path.posix.basename(pathname).includes(".") &&
        headerAcceptsHtml(request.headers.get("accept"))
    );
}

function requestMatchesEtag(request: Request, etag: string): boolean {
    const header = request.headers.get("if-none-match");
    if (header === null || Buffer.byteLength(header) > maximumHeaderBytes) {
        return false;
    }
    const items = header.split(",");
    if (items.length > maximumHeaderItems) return false;
    return items.some((item) => {
        const candidate = item.trim().replace(/^W\//u, "");
        return candidate === "*" || candidate === etag;
    });
}

async function cancelUnexpectedBody(request: Request): Promise<void> {
    if (request.body === null) return;
    await request.body
        .cancel("Static asset request method is not allowed")
        .catch(() => {});
}

function assetHeaders(
    asset: FrontendAssetRepresentations,
    selected: SelectedRepresentation,
    spaFallback: boolean
): Headers {
    const headers = fixedSecurityHeaders();
    const contentType = contentTypes[path.extname(asset.identity.path)];
    if (contentType === undefined) throw frontendAssetFailure();
    headers.set(
        "cache-control",
        asset.publicPath.startsWith("/assets/") &&
            hashedAssetPattern.test(path.posix.basename(asset.publicPath))
            ? "public, max-age=31536000, immutable"
            : "no-cache, max-age=0, must-revalidate"
    );
    headers.set("content-length", String(selected.identity.bytes));
    headers.set("content-type", contentType);
    headers.set("etag", `"${selected.identity.sha256}"`);
    const vary = [
        ...(spaFallback ? ["Accept"] : []),
        ...(asset.brotli || asset.gzip ? ["Accept-Encoding"] : []),
    ];
    if (vary.length > 0) headers.set("vary", vary.join(", "));
    if (selected.contentEncoding) {
        headers.set("content-encoding", selected.contentEncoding);
    }
    return headers;
}

async function preloadFrontendAssetBodies(
    assets: ReadonlyMap<string, FrontendAssetRepresentations>,
    reader: Awaited<ReturnType<typeof createImmutableReleaseFileReader>>
): Promise<ReadonlyMap<string, Blob>> {
    const identities = new Map<string, ImmutableReleaseFileIdentity>();
    for (const asset of assets.values()) {
        for (const identity of [asset.identity, asset.brotli, asset.gzip]) {
            if (identity) identities.set(identity.path, identity);
        }
    }
    const totalBytes = [...identities.values()].reduce(
        (sum, identity) => sum + identity.bytes,
        0
    );
    if (
        identities.size === 0 ||
        identities.size > maximumPublicAssetCount ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > maximumPublicAssetBytes
    ) {
        throw frontendAssetFailure();
    }

    const bodies = new Map<string, Blob>();
    for (const identity of identities.values()) {
        const bytes = await reader.read(identity);
        bodies.set(identity.path, new Blob([bytes]));
    }
    return bodies;
}

/**
 * Creates a manifest-indexed, no-follow static asset and controlled SPA handler.
 * @param release Verified immutable runtime release selected by the web composition root.
 * @param testHooks Deterministic immutable-file hooks used only by tests.
 * @returns Raw handler invoked after tRPC and health protocol ownership checks.
 */
export async function createFrontendAssetHandler(
    release: RuntimeRelease,
    testHooks: FrontendAssetHandlerTestHooks = {}
): Promise<FrontendAssetHandler> {
    const assets = buildFrontendAssetIndex(release);
    const reader = await createImmutableReleaseFileReader(
        release.releaseRoot,
        testHooks.file
    );
    const bodies = await preloadFrontendAssetBodies(assets, reader);
    const index = assets.get("/");
    if (!index) throw frontendAssetFailure();

    return async (request, requestUrl) => {
        const pathname = requestUrl.pathname;
        const exact = assets.get(pathname);
        const spaFallback =
            exact === undefined && controlledSpaFallback(request, pathname);
        const asset = exact ?? (spaFallback ? index : undefined);
        const ownsAssetPath = pathname.startsWith("/assets/");
        if (asset === undefined) {
            return ownsAssetPath ? noStoreResponse("Not found", 404) : undefined;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            await cancelUnexpectedBody(request);
            const response = noStoreResponse(null, 405);
            response.headers.set("allow", "GET, HEAD");
            return response;
        }
        const selected = selectRepresentation(
            asset,
            request.headers.get("accept-encoding")
        );
        if (selected === undefined) return noStoreResponse(null, 406);
        const headers = assetHeaders(asset, selected, spaFallback);
        const etag = headers.get("etag");
        if (etag !== null && requestMatchesEtag(request, etag)) {
            headers.delete("content-length");
            return new Response(null, { headers, status: 304 });
        }
        const body = bodies.get(selected.identity.path);
        if (!body) throw frontendAssetFailure();
        return new Response(request.method === "HEAD" ? null : body, {
            headers,
            status: 200,
        });
    };
}
