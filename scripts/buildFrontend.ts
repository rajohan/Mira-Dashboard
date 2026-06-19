import { execSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import reactCompilerPlugin from "./reactCompilerPlugin";

const outdir = path.resolve("dist");

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
        return execSync("git rev-parse --short HEAD", {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "unknown";
    }
}

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
    define: {
        __APP_COMMIT__: JSON.stringify(getAppCommit()),
        "process.env.PUBLIC_DASHBOARD_WS_PORT": "undefined",
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    entrypoints: ["./index.html"],
    env: "PUBLIC_*",
    minify: true,
    naming: {
        asset: "assets/[name]-[hash].[ext]",
        chunk: "assets/[name]-[hash].[ext]",
    },
    outdir,
    plugins: [productionDevtoolsPlugin, reactCompilerPlugin],
    publicPath: "/",
    splitting: true,
    target: "browser",
});

if (!result.success) {
    throw new AggregateError(result.logs, "Frontend build failed");
}
