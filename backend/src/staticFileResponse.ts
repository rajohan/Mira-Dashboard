import type { Stats } from "node:fs";
import fs from "node:fs/promises";

interface StaticFileResponseOptions {
    cacheControl: string;
    contentType?: string;
}

type ContentEncoding = "br" | "gzip";

interface StaticRepresentation {
    contentEncoding?: ContentEncoding;
    filePath: string;
    stat: Stats;
}

const COMPRESSION_SIDECARS: ReadonlyArray<{
    contentEncoding: ContentEncoding;
    extension: ".br" | ".gz";
}> = [
    { contentEncoding: "br", extension: ".br" },
    { contentEncoding: "gzip", extension: ".gz" },
];

function encodingQuality(headerValue: string | null, encoding: string): number {
    if (!headerValue) return 0;

    let explicitQuality: number | undefined;
    let wildcardQuality: number | undefined;
    for (const item of headerValue.split(",")) {
        const [rawEncoding = "", ...parameters] = item.split(";");
        const normalizedEncoding = rawEncoding.trim().toLowerCase();
        let quality = 1;
        for (const parameter of parameters) {
            const normalizedParameter = parameter.trim().toLowerCase();
            if (normalizedParameter.startsWith("q")) {
                const match = normalizedParameter.match(
                    /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u
                );
                quality = match ? Number(match[1]) : 0;
            }
        }
        if (normalizedEncoding === encoding) explicitQuality = quality;
        if (normalizedEncoding === "*") wildcardQuality = quality;
    }

    return explicitQuality ?? wildcardQuality ?? 0;
}

async function compressedRepresentations(
    filePath: string
): Promise<StaticRepresentation[]> {
    const representations: StaticRepresentation[] = [];
    for (const { contentEncoding, extension } of COMPRESSION_SIDECARS) {
        const sidecarPath = `${filePath}${extension}`;
        try {
            const stat = await fs.lstat(sidecarPath);
            if (stat.isFile()) {
                representations.push({
                    contentEncoding,
                    filePath: sidecarPath,
                    stat,
                });
            }
        } catch {
            // This representation was not generated for the source file.
        }
    }
    return representations;
}

function preferredRepresentation(
    request: Request,
    source: StaticRepresentation,
    compressed: StaticRepresentation[]
): StaticRepresentation {
    return (
        compressed
            .map((representation, priority) => ({
                priority,
                quality: encodingQuality(
                    request.headers.get("accept-encoding"),
                    representation.contentEncoding ?? ""
                ),
                representation,
            }))
            .filter(({ quality }) => quality > 0)
            .toSorted(
                (left, right) =>
                    right.quality - left.quality || left.priority - right.priority
            )[0]?.representation ?? source
    );
}

function entityTagFor(representation: StaticRepresentation): string {
    const encodingSuffix = representation.contentEncoding
        ? `-${representation.contentEncoding}`
        : "";
    return `W/"${representation.stat.size.toString(16)}-${Math.trunc(
        representation.stat.mtimeMs
    ).toString(16)}${encodingSuffix}"`;
}

function normalizedEntityTag(entityTag: string): string {
    return entityTag.trim().replace(/^W\//iu, "");
}

function isEntityTagMatch(headerValue: string, entityTag: string): boolean {
    const normalizedCurrent = normalizedEntityTag(entityTag);
    return headerValue.split(",").some((candidate) => {
        const trimmed = candidate.trim();
        return trimmed === "*" || normalizedEntityTag(trimmed) === normalizedCurrent;
    });
}

function isNotModified(request: Request, entityTag: string, modifiedAt: Date): boolean {
    if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return false;

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch !== null) {
        return isEntityTagMatch(ifNoneMatch, entityTag);
    }

    const ifModifiedSince = request.headers.get("if-modified-since");
    if (!ifModifiedSince) return false;
    const conditionalTimestamp = Date.parse(ifModifiedSince);
    return (
        Number.isFinite(conditionalTimestamp) &&
        Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(conditionalTimestamp / 1000)
    );
}

/**
 * Serves a verified static file with conditional requests and negotiated
 * precompressed representations.
 */
export async function staticFileResponse(
    request: Request,
    filePath: string,
    { cacheControl, contentType }: StaticFileResponseOptions
): Promise<Response> {
    const sourceStat = await fs.stat(filePath);
    const source: StaticRepresentation = { filePath, stat: sourceStat };
    const compressed = await compressedRepresentations(filePath);
    const representation = preferredRepresentation(request, source, compressed);
    const entityTag = entityTagFor(representation);
    const headers = new Headers({
        "Cache-Control": cacheControl,
        ETag: entityTag,
        "Last-Modified": sourceStat.mtime.toUTCString(),
    });

    const resolvedContentType = contentType ?? Bun.file(filePath).type;
    if (resolvedContentType) headers.set("Content-Type", resolvedContentType);
    if (compressed.length > 0) headers.set("Vary", "Accept-Encoding");
    if (representation.contentEncoding) {
        headers.set("Content-Encoding", representation.contentEncoding);
    }

    if (isNotModified(request, entityTag, sourceStat.mtime)) {
        return new Response(undefined, { headers, status: 304 });
    }
    return new Response(Bun.file(representation.filePath), { headers });
}
