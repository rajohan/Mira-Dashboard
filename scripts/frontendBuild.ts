import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

import {
    isReleaseBuildCommit,
    resolveBuildSourceIdentity,
} from "../backend/scripts/buildSourceIdentity.ts";
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
        entrypoints: ["./index.html"],
        env: "PUBLIC_*",
        minify: isProduction,
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

    await writeFile(
        path.join(resolvedOutdir, "build-identity.json"),
        `${JSON.stringify(
            {
                bunVersion: Bun.version,
                commitSha,
                component: "frontend",
                formatVersion: 1,
            },
            undefined,
            2
        )}\n`
    );
}
