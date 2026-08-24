import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const ignoredPinnedUpstreamDiagnostics = [
    {
        message:
            "flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering. Consider moving this call to a scheduler task or micro task.",
        module: "/src/browser/jobs/stories/ScheduleEditor.stories.tsx",
        test: "Interval To Daily Transition",
    },
    {
        message: "useInsertionEffect must not schedule updates.",
        module: "/src/browser/tasks/stories/TaskBoard.stories.tsx",
        test: "Busy",
    },
] as const;

export default defineConfig({
    test: {
        onConsoleLog(log, type, entity) {
            if (
                type === "stderr" &&
                entity?.type === "test" &&
                ignoredPinnedUpstreamDiagnostics.some(
                    (diagnostic) =>
                        diagnostic.message === log.trim() &&
                        entity.name === diagnostic.test &&
                        entity.module.moduleId.includes(diagnostic.module)
                )
            ) {
                return false;
            }
            if (type === "stderr") {
                process.stderr.write("[Storybook unexpected stderr]\n");
            }
        },
        projects: [
            {
                extends: true,
                plugins: [storybookTest({ configDir: configDirectory })],
                test: {
                    name: "storybook",
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright({}),
                        instances: [{ browser: "chromium" }],
                    },
                },
            },
        ],
    },
});
