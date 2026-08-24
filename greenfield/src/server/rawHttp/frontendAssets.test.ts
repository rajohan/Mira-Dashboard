import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../shared/releaseManifest.ts";
import type { RuntimeRelease } from "../platform/release/runtimeRelease.ts";
import { createFrontendAssetHandler } from "./frontendAssets.ts";

const temporaryDirectories: string[] = [];
const checksum = "c".repeat(64);
const indexContents = "<!doctype html><title>Mira Dashboard</title>";
const indexBrotliContents = "compressed-index";
const appContents = "globalThis.dashboard=true;";
const brotliContents = "compressed-app";
const appPublicPath = "/assets/app-a1b2c3d4.js";
const appArtifactPath = `browser${appPublicPath}`;

function sha256(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function restoreOwnerWrite(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => {});
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.isDirectory()) {
            await restoreOwnerWrite(path.join(directory, entry.name));
        } else if (entry.isFile()) {
            await chmod(path.join(directory, entry.name), 0o600);
        }
    }
}

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

function artifact(pathname: string, contents: string) {
    return Object.freeze({
        bytes: Buffer.byteLength(contents),
        path: pathname,
        sha256: sha256(contents),
    });
}

async function frontendReleaseFixture(): Promise<RuntimeRelease> {
    const releaseRoot = await mkdtemp(path.join(tmpdir(), "mira-frontend-assets-"));
    temporaryDirectories.push(releaseRoot);
    const assetsRoot = path.join(releaseRoot, "browser/assets");
    await mkdir(assetsRoot, { recursive: true });
    const artifacts = [
        artifact(appArtifactPath, appContents),
        artifact(`${appArtifactPath}.br`, brotliContents),
        artifact("browser/bundle-metrics.json", "{}\n"),
        artifact("browser/index.html", indexContents),
        artifact("browser/index.html.br", indexBrotliContents),
    ].toSorted((left, right) => left.path.localeCompare(right.path));
    await Promise.all([
        writeFile(path.join(releaseRoot, appArtifactPath), appContents),
        writeFile(path.join(releaseRoot, `${appArtifactPath}.br`), brotliContents),
        writeFile(path.join(releaseRoot, "browser/bundle-metrics.json"), "{}\n"),
        writeFile(path.join(releaseRoot, "browser/index.html"), indexContents),
        writeFile(path.join(releaseRoot, "browser/index.html.br"), indexBrotliContents),
    ]);
    for (const record of artifacts) {
        await chmod(path.join(releaseRoot, record.path), 0o400);
    }
    await chmod(assetsRoot, 0o500);
    await chmod(path.join(releaseRoot, "browser"), 0o500);
    await chmod(releaseRoot, 0o500);

    return Object.freeze({
        manifest: parseReleaseManifest({
            artifacts,
            buildCommands: [...releaseBuildCommands],
            deliveryProtocols: [...releaseDeliveryProtocols],
            display: { builtAtMs: 1, commitTitle: "Test release", schemaTarget: 1 },
            documentationSha256: checksum,
            formatVersion: 1,
            lockfileSha256: checksum,
            migrations: [
                {
                    id: "20260804022252_dashboard-foundation",
                    migrationSha256: checksum,
                    snapshotSha256: checksum,
                },
            ],
            packages: [
                {
                    name: "effect",
                    scope: "dependency",
                    version: "4.0.0-beta.106",
                },
            ],
            processRoles: [...releaseProcessRoles],
            runtime: { revision: "a".repeat(40), version: "1.4.0" },
            source: { commitSha: "b".repeat(40), treeState: "clean" },
        }),
        releaseRoot,
    });
}

async function handledResponse(
    handler: Awaited<ReturnType<typeof createFrontendAssetHandler>>,
    pathname: string,
    init?: RequestInit
): Promise<Response> {
    const request = new Request(`https://dashboard.example${pathname}`, init);
    const response = await handler(request, new URL(request.url));
    if (!response) throw new Error("Expected the frontend handler to own the path");
    return response;
}

describe("frontend release assets", () => {
    test("serves immutable negotiated assets, index navigation, HEAD and validators", async () => {
        const release = await frontendReleaseFixture();
        const handler = await createFrontendAssetHandler(release);

        const index = await handledResponse(handler, "/");
        const head = await handledResponse(handler, "/", { method: "HEAD" });
        const compressed = await handledResponse(handler, appPublicPath, {
            headers: { "accept-encoding": "gzip;q=0.5, br;q=1" },
        });
        const cached = await handledResponse(handler, appPublicPath, {
            headers: {
                "accept-encoding": "br",
                "if-none-match": compressed.headers.get("etag") ?? "missing",
            },
        });
        const route = await handledResponse(handler, "/tasks/active", {
            headers: { accept: "text/html" },
        });

        expect(index.status).toBe(200);
        expect(await index.text()).toBe(indexContents);
        expect(index.headers.get("cache-control")).toContain("no-cache");
        expect(index.headers.get("vary")).toBe("Accept-Encoding");
        expect(index.headers.get("content-security-policy")).toContain(
            "frame-ancestors 'none'"
        );
        expect(index.headers.get("x-content-type-options")).toBe("nosniff");
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("content-length")).toBe(
            String(Buffer.byteLength(indexContents))
        );
        expect(compressed.status).toBe(200);
        expect(compressed.headers.get("content-encoding")).toBe("br");
        expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
        expect(compressed.headers.get("cache-control")).toContain("immutable");
        expect(Buffer.from(await compressed.arrayBuffer()).toString()).toBe(
            brotliContents
        );
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
        expect(route.status).toBe(200);
        expect(await route.text()).toBe(indexContents);
        expect(route.headers.get("vary")).toBe("Accept, Accept-Encoding");
    });

    test("keeps protocol paths separate and bounds missing, method and encoding cases", async () => {
        const release = await frontendReleaseFixture();
        const handler = await createFrontendAssetHandler(release);
        const apiRequest = new Request("https://dashboard.example/api/unknown");

        expect(await handler(apiRequest, new URL(apiRequest.url))).toBeUndefined();
        expect(
            await handler(
                new Request("https://dashboard.example/favicon.ico"),
                new URL("https://dashboard.example/favicon.ico")
            )
        ).toBeUndefined();

        const missing = await handledResponse(handler, "/assets/missing.js");
        const method = await handledResponse(handler, "/", {
            body: "ignored",
            method: "POST",
        });
        const unacceptable = await handledResponse(handler, appPublicPath, {
            headers: { "accept-encoding": "br;q=0, identity;q=0" },
        });
        const encodedTraversal = await handledResponse(
            handler,
            "/assets/%2e%2e%2findex.html"
        );
        const extensionlessAsset = await handledResponse(handler, "/assets/missing");
        const rejectedNavigation = new Request("https://dashboard.example/tasks/active", {
            headers: { accept: "text/html;q=0, application/json" },
        });

        expect(missing.status).toBe(404);
        expect(method.status).toBe(405);
        expect(method.headers.get("allow")).toBe("GET, HEAD");
        expect(unacceptable.status).toBe(406);
        expect(encodedTraversal.status).toBe(404);
        expect(extensionlessAsset.status).toBe(404);
        expect(
            await handler(rejectedNavigation, new URL(rejectedNavigation.url))
        ).toBeUndefined();
    });

    test("fails closed for writable directories and a path replacement after read", async () => {
        const writableRelease = await frontendReleaseFixture();
        await chmod(writableRelease.releaseRoot, 0o700);
        const writableFailure = await rejectionError(
            createFrontendAssetHandler(writableRelease)
        );
        expect(writableFailure.message).toBe("Immutable release file is invalid");

        const writableAssetsRelease = await frontendReleaseFixture();
        await chmod(
            path.join(writableAssetsRelease.releaseRoot, "browser/assets"),
            0o700
        );
        const writableAssetsFailure = await rejectionError(
            createFrontendAssetHandler(writableAssetsRelease)
        );
        expect(writableAssetsFailure.message).toBe("Immutable release file is invalid");

        const swappedRelease = await frontendReleaseFixture();
        let swapped = false;
        const failure = await rejectionError(
            createFrontendAssetHandler(swappedRelease, {
                file: {
                    async afterRead(artifactPath) {
                        if (swapped || artifactPath !== appArtifactPath) return;
                        swapped = true;
                        const assetsRoot = path.join(
                            swappedRelease.releaseRoot,
                            "browser/assets"
                        );
                        const target = path.join(
                            swappedRelease.releaseRoot,
                            artifactPath
                        );
                        await chmod(assetsRoot, 0o700);
                        await rename(target, `${target}.displaced`);
                        await writeFile(target, "replacement");
                    },
                },
            })
        );

        expect(failure.message).toBe("Immutable release file is invalid");
        expect(swapped).toBeTrue();
    });
});
