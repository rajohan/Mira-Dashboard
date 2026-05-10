import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        globals: false,
        setupFiles: ["src/test/setup.ts"],
        maxWorkers: 2,
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/**/*.{ts,tsx}"],
            exclude: [
                "src/**/*.test.{ts,tsx}",
                "src/test/**",
                "src/types/**",
                "src/**/*.d.ts",
                "src/main.tsx",
                "src/router.tsx",
                "src/App.tsx",
                "src/polyfills.ts",
                "src/**/index.ts",
            ],
        },
    },
});
