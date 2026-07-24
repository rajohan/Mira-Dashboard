import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const backendDirectory = path.resolve(import.meta.dirname, "..");
const outdir = path.join(backendDirectory, "dist");

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
    entrypoints: [
        path.join(backendDirectory, "src/serverStart.ts"),
        path.join(backendDirectory, "src/workerStart.ts"),
        path.join(backendDirectory, "src/databasePreflight.ts"),
        path.join(backendDirectory, "src/resetDashboardPassword.ts"),
    ],
    format: "esm",
    outdir,
    packages: "external",
    splitting: false,
    sourcemap: "external",
    target: "bun",
});

if (!result.success) {
    throw new AggregateError(result.logs, "Backend build failed");
}
