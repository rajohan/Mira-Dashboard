import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [
        react({
            babel: {
                plugins: [["babel-plugin-react-compiler", {}]],
            },
        }),
    ],
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
    },
});
