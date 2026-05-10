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
            include: [
                "src/utils/**/*.{ts,tsx}",
                "src/components/ui/**/*.{ts,tsx}",
                "src/hooks/**/*.{ts,tsx}",
                "src/stores/**/*.{ts,tsx}",
                "src/collections/**/*.{ts,tsx}",
                "src/lib/**/*.{ts,tsx}",
            ],
            exclude: ["src/**/*.test.{ts,tsx}"],
        },
    },
});
