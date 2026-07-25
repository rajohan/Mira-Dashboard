import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import tailwindPlugin from "bun-plugin-tailwind";

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

function getAppCommit(): string {
    try {
        const result = Bun.spawnSync({
            cmd: ["git", "rev-parse", "HEAD"],
            stderr: "ignore",
            stdin: "ignore",
            stdout: "pipe",
        });

        if (result.exitCode !== 0) {
            return "unknown";
        }

        const commit = new TextDecoder().decode(result.stdout).trim();
        return /^[\da-f]{40}$/u.test(commit) ? commit : "unknown";
    } catch {
        return "unknown";
    }
}

export async function buildFrontend({
    mode,
    outdir = "dist",
}: FrontendBuildOptions): Promise<void> {
    const resolvedOutdir = path.resolve(outdir);
    const isProduction = mode === "production";
    const commitSha = getAppCommit();
    if (isProduction && commitSha === "unknown") {
        throw new Error("Production frontend build requires a full Git commit identity");
    }

    await rm(resolvedOutdir, { force: true, recursive: true });
    await mkdir(resolvedOutdir, { recursive: true });

    const result = await Bun.build({
        define: {
            __APP_COMMIT__: JSON.stringify(
                commitSha === "unknown" ? commitSha : commitSha.slice(0, 8)
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
