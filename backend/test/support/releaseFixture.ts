import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeReleaseManifest } from "../../src/releaseManifest.ts";

interface ReleaseFixtureOptions {
    builtAt?: Date;
    commitTitle?: string;
}

/** Creates the complete artifact set shared by immutable release tests. */
export async function createReleaseFixture(
    releaseRoot: string,
    commitSha: string,
    options: ReleaseFixtureOptions = {}
): Promise<void> {
    mkdirSync(path.join(releaseRoot, "backend", "config"), { recursive: true });
    mkdirSync(path.join(releaseRoot, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(releaseRoot, "dist", "assets"), { recursive: true });
    writeFileSync(path.join(releaseRoot, "package.json"), "{}\n");
    writeFileSync(path.join(releaseRoot, "bun.lock"), "root-lock\n");
    writeFileSync(path.join(releaseRoot, "backend", "package.json"), "{}\n");
    writeFileSync(path.join(releaseRoot, "backend", "bun.lock"), "backend-lock\n");
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
                bunVersion: Bun.version,
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
