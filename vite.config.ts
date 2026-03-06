import { execSync } from "node:child_process";

import { devtools } from "@tanstack/devtools-vite";
import react from "@vitejs/plugin-react";
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

export default defineConfig({
    plugins: [
        devtools(),
        react({
            babel: {
                plugins: [["babel-plugin-react-compiler", {}]],
            },
        }),
    ],
    define: {
        __APP_COMMIT__: JSON.stringify(appCommit),
    },
    server: {
        host: true, // Listen on all addresses (needed for Tailscale)
        proxy: {
            "/api": {
                target: "http://localhost:3100",
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    ui: ["@headlessui/react", "lucide-react"],
                    router: ["@tanstack/react-router"],
                    query: ["@tanstack/react-query"],
                    charts: ["recharts"],
                    markdown: ["react-markdown", "remark-gfm"],
                    syntax: ["react-syntax-highlighter"],
                },
            },
        },
        // Add version to bust browser cache
        watch: {},
    },
});
