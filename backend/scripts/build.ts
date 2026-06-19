import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const backendDir = path.resolve(import.meta.dirname, "..");
const outdir = path.join(backendDir, "dist");

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
    entrypoints: [path.join(backendDir, "src/serverStart.ts")],
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
