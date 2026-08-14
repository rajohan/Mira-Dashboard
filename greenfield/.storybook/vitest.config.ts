import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
    createStorybookTestProjectPlan,
    discoverStorybookTestFiles,
} from "../scripts/storybookTestProjects.ts";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(configDirectory, "..");

export default defineConfig(async () => {
    const storyFiles = await discoverStorybookTestFiles(projectRoot);
    const projectPlans = createStorybookTestProjectPlan(storyFiles);

    return {
        test: {
            onConsoleLog(_log: string, type: "stderr" | "stdout", _entity: unknown) {
                if (type === "stderr") {
                    process.stderr.write("[Storybook unexpected stderr]\n");
                }
            },
            projects: projectPlans.map((plan) => ({
                extends: true as const,
                plugins: [storybookTest({ configDir: configDirectory })],
                test: {
                    exclude: [...plan.excludedFiles],
                    name: plan.name,
                    sequence: { groupOrder: plan.groupOrder },
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright({}),
                        instances: [{ browser: "chromium" as const }],
                    },
                },
            })),
        },
    };
});
