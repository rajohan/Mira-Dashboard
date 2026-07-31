import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { databaseMigrations } from "../../src/databaseMigrations/index.ts";
import { currentBunRuntimeIdentity } from "../../src/managedBunRuntime.ts";
import {
    databaseMigrationInventorySha256,
    loadReleaseManifest,
    parseReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    writeReleaseManifest,
} from "../../src/releaseManifest.ts";

interface ReleaseFixtureOptions {
    builtAt?: Date;
    commitTitle?: string;
}

/**
 * Creates the complete artifact set shared by immutable release tests.
 * @param releaseRoot Release root value.
 * @param commitSha Commit sha value.
 * @param options Operation options.
 */
export async function createReleaseFixture(
    releaseRoot: string,
    commitSha: string,
    options: ReleaseFixtureOptions = {}
): Promise<void> {
    mkdirSync(path.join(releaseRoot, "backend", "config"), { recursive: true });
    mkdirSync(path.join(releaseRoot, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(releaseRoot, "dist", "assets"), { recursive: true });
    mkdirSync(path.join(releaseRoot, "scripts"), { recursive: true });
    writeFileSync(path.join(releaseRoot, "package.json"), "{}\n");
    writeFileSync(path.join(releaseRoot, "bun.lock"), "root-lock\n");
    writeFileSync(
        path.join(releaseRoot, "scripts", "runManagedDashboardRelease.sh"),
        '#!/usr/bin/env bash\nexec bun "$@"\n',
        { mode: 0o755 }
    );
    writeFileSync(
        path.join(releaseRoot, "backend", "config", "log-rotation.json"),
        '{"jobs":[]}\n'
    );
    writeFileSync(path.join(releaseRoot, "dist", "index.html"), "<main>ready</main>\n");
    writeFileSync(
        path.join(releaseRoot, "dist", "assets", "app.js"),
        `export const commit = "${commitSha}";\n`
    );
    writeFileSync(
        path.join(releaseRoot, "not-a-release-artifact.txt"),
        "must not publish\n"
    );
    for (const component of ["frontend", "backend"] as const) {
        const componentRoot =
            component === "frontend"
                ? path.join(releaseRoot, "dist")
                : path.join(releaseRoot, "backend", "dist");
        writeFileSync(
            path.join(componentRoot, "build-identity.json"),
            `${JSON.stringify({
                bunVersion: currentBunRuntimeIdentity(),
                commitSha,
                component,
                formatVersion: 1,
            })}\n`
        );
    }
    for (const entrypoint of [
        "databasePreflight",
        "pullRequestPreviewGatewayProxy",
        "releaseLifecycle",
        "resetDashboardPassword",
        "serverStart",
        "workerStart",
    ]) {
        writeFileSync(
            path.join(releaseRoot, "backend", "dist", `${entrypoint}.js`),
            `export const commit = "${commitSha}";\n`
        );
    }
    await writeReleaseManifest({
        builtAt: options.builtAt ?? new Date("2026-07-26T02:00:00.000Z"),
        commitSha,
        commitTitle: options.commitTitle ?? `Release ${commitSha.slice(0, 8)}`,
        releaseRoot,
    });
}

/**
 * Rewrites a release fixture to model an older exact schema compatibility window.
 * @param releaseRoot Release root value.
 * @param schemaVersion Schema version value.
 */
export async function rewriteReleaseFixtureSchemaVersion(
    releaseRoot: string,
    schemaVersion: number
): Promise<void> {
    const manifest = await loadReleaseManifest(releaseRoot);
    if (
        !Number.isSafeInteger(schemaVersion) ||
        schemaVersion < 0 ||
        schemaVersion > manifest.schema.target ||
        schemaVersion > databaseMigrations.length
    ) {
        throw new TypeError("Release fixture schema version is invalid");
    }
    const migrations = manifest.schema.migrations.slice(0, schemaVersion);
    const migrationRegistrySha256 = new Bun.CryptoHasher("sha256")
        .update(
            databaseMigrations
                .slice(0, schemaVersion)
                .map(
                    (migration) =>
                        `${migration.version}\0${migration.name}\0${migration.sql}`
                )
                .join("\0")
        )
        .digest("hex");
    const rewritten = parseReleaseManifest({
        ...manifest,
        schema: {
            maximumCompatible: schemaVersion,
            migrations,
            migrationInventorySha256: databaseMigrationInventorySha256(migrations),
            migrationRegistrySha256,
            minimumCompatible: schemaVersion,
            target: schemaVersion,
        },
    });
    writeFileSync(
        path.join(releaseRoot, RELEASE_MANIFEST_FILE_NAME),
        `${JSON.stringify(rewritten, undefined, 2)}\n`
    );
}
