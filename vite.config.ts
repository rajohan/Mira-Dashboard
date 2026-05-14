import { execSync } from "node:child_process";

import babel from "@rolldown/plugin-babel";
import { devtools } from "@tanstack/devtools-vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appCommit = (() => {
    try {
        return execSync("git rev-parse --short HEAD", {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "unknown";
    }
})();

const apiTarget = process.env.DASHBOARD_API_TARGET || "http://localhost:3100";

export default defineConfig({
    plugins: [devtools(), react(), babel({ presets: [reactCompilerPreset()] })],
    define: {
        __APP_COMMIT__: JSON.stringify(appCommit),
    },
    server: {
        host: true, // Listen on all addresses (needed for Tailscale)
        proxy: {
            "/api": {
                target: apiTarget,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        chunkSizeWarningLimit: 1500,
        rolldownOptions: {
            checks: {
                pluginTimings: false,
            },
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name(id) {
                                if (
                                    id.includes("node_modules/@headlessui/react") ||
                                    id.includes("node_modules/lucide-react")
                                ) {
                                    return "ui";
                                }
                                if (id.includes("node_modules/@tanstack/react-router")) {
                                    return "router";
                                }
                                if (id.includes("node_modules/@tanstack/react-query")) {
                                    return "query";
                                }
                                if (
                                    id.includes("node_modules/react-markdown") ||
                                    id.includes("node_modules/remark-gfm")
                                ) {
                                    return "markdown";
                                }
                                if (
                                    id.includes("node_modules/react-syntax-highlighter")
                                ) {
                                    return "syntax";
                                }
                                return null;
                            },
                        },
                    ],
                },
            },
        },
    },
});
