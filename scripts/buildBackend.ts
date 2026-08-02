import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { currentBunRuntimeIdentity } from "../backend/src/services/releases/runtime.ts";
import { resolveBuildSourceIdentity } from "./buildSourceIdentity.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const backendDirectory = path.join(repoRoot, "backend");
const outdir = path.join(backendDirectory, "dist");
const commitSha = resolveBuildSourceIdentity(repoRoot);
if (commitSha === "unknown") {
    throw new Error("Backend build requires a full Git commit identity");
}

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
    define: {
        __BACKEND_BUILD_COMMIT__: JSON.stringify(commitSha),
    },
    entrypoints: [
        path.join(backendDirectory, "src/serverStart.ts"),
        path.join(backendDirectory, "src/workerStart.ts"),
        path.join(backendDirectory, "src/databasePreflight.ts"),
        path.join(backendDirectory, "src/pullRequestPreviewGatewayProxy.ts"),
        path.join(backendDirectory, "src/releaseLifecycle.ts"),
        path.join(backendDirectory, "src/resetDashboardPassword.ts"),
    ],
    format: "esm",
    outdir,
    packages: "bundle",
    splitting: false,
    sourcemap: "external",
    target: "bun",
});

if (!result.success) {
    throw new AggregateError(result.logs, "Backend build failed");
}

await writeFile(
    path.join(outdir, "build-identity.json"),
    `${JSON.stringify(
        {
            bunVersion: currentBunRuntimeIdentity(),
            commitSha,
            component: "backend",
            formatVersion: 1,
        },
        undefined,
        2
    )}\n`
);
