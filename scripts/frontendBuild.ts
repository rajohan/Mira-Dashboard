import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

import { currentBunRuntimeIdentity } from "../backend/src/services/releases/runtime.ts";
import {
    isReleaseBuildCommit,
    resolveBuildSourceIdentity,
} from "./buildSourceIdentity.ts";
import {
    assertFrontendBundleBudgets,
    measureFrontendBundle,
    writeFrontendHtmlAppEntrypoint,
    writePrecompressedFrontendAssets,
} from "./frontendBuildArtifacts";
import reactCompilerPlugin from "./reactCompilerPlugin";

type FrontendBuildMode = "development" | "production";

interface FrontendBuildOptions {
    mode: FrontendBuildMode;
    outdir?: string;
}

const productionDevtoolsPlugin: Bun.BunPlugin = {
    name: "production-devtools-stub",
    setup(build) {
        build.onLoad(
            { filter: /src\/components\/devtools\/DashboardDevtools\.tsx$/ },
            () => ({
                contents:
                    "export default function DashboardDevtools() { return undefined; }",
                loader: "tsx",
            })
        );
    },
};

export async function buildFrontend({
    mode,
    outdir = "dist",
}: FrontendBuildOptions): Promise<void> {
    const resolvedOutdir = path.resolve(outdir);
    const isProduction = mode === "production";
    const commitSha = resolveBuildSourceIdentity();
    if (isProduction && commitSha === "unknown") {
        throw new Error("Production frontend build requires a full Git commit identity");
    }

    await rm(resolvedOutdir, { force: true, recursive: true });
    await mkdir(resolvedOutdir, { recursive: true });

    const result = await Bun.build({
        define: {
            __APP_COMMIT__: JSON.stringify(
                isReleaseBuildCommit(commitSha) ? commitSha.slice(0, 8) : commitSha
            ),
            "process.env.PUBLIC_DASHBOARD_WS_PORT": "undefined",
            "process.env.NODE_ENV": JSON.stringify(mode),
        },
        entrypoints: ["./frontend/index.html"],
        env: "PUBLIC_*",
        minify: isProduction,
        metafile: true,
        naming: {
            asset: "assets/[name]-[hash].[ext]",
            chunk: "assets/[name]-[hash].[ext]",
        },
        outdir: resolvedOutdir,
        plugins: [
            ...(isProduction ? [productionDevtoolsPlugin] : []),
            tailwindPlugin,
            reactCompilerPlugin,
        ],
        publicPath: "/",
        sourcemap: isProduction ? "none" : "linked",
        splitting: true,
        target: "browser",
    });

    if (!result.success) {
        throw new AggregateError(result.logs, "Frontend build failed");
    }
    if (!result.metafile) {
        throw new Error("Frontend build did not produce bundle metadata");
    }
    await writeFrontendHtmlAppEntrypoint(result.metafile, resolvedOutdir);

    await writeFile(
        path.join(resolvedOutdir, "build-identity.json"),
        `${JSON.stringify(
            {
                bunVersion: currentBunRuntimeIdentity(),
                commitSha,
                component: "frontend",
                formatVersion: 1,
            },
            undefined,
            2
        )}\n`
    );

    if (isProduction) {
        const bundleMetrics = await measureFrontendBundle(
            result.metafile,
            resolvedOutdir
        );
        await writeFile(
            path.join(resolvedOutdir, "frontend-bundle-metrics.json"),
            `${JSON.stringify(bundleMetrics, undefined, 2)}\n`
        );
        assertFrontendBundleBudgets(bundleMetrics.measurements);
        const compressedFileCount = await writePrecompressedFrontendAssets(
            result.outputs.map(({ path: outputPath }) => outputPath)
        );
        console.log(
            `Frontend bundle: ${bundleMetrics.measurements.initialJavaScriptGzipBytes} bytes initial JS gzip, ${bundleMetrics.measurements.totalJavaScriptGzipBytes} bytes total JS gzip, ${compressedFileCount} compressed sidecars`
        );
    }
}
