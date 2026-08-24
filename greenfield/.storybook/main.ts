import type { StorybookConfig } from "@storybook/tanstack-react";
import tailwindcss from "@tailwindcss/vite";
import { createLogger } from "vite";

const pinnedBrowserDiagnostics = Object.freeze([
    "flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering. Consider moving this call to a scheduler task or micro task.",
    "useInsertionEffect must not schedule updates.",
]);

function createStorybookLogger() {
    const logger = createLogger();
    const writeError = logger.error.bind(logger);
    logger.error = (message, options) => {
        if (pinnedBrowserDiagnostics.some((diagnostic) => message.includes(diagnostic))) {
            return;
        }
        writeError(message, options);
    };
    return logger;
}

const config: StorybookConfig = {
    addons: ["@storybook/addon-a11y", "@storybook/addon-docs", "@storybook/addon-vitest"],
    framework: {
        name: "@storybook/tanstack-react",
        options: {},
    },
    stories: ["../src/browser/**/*.stories.tsx"],
    viteFinal(viteConfiguration) {
        return {
            ...viteConfiguration,
            // Vitest independently verifies the exact story provenance before waiving
            // these pinned upstream diagnostics. This only removes Vite's duplicate.
            customLogger: createStorybookLogger(),
            optimizeDeps: {
                ...viteConfiguration.optimizeDeps,
                include: [
                    ...(viteConfiguration.optimizeDeps?.include ?? []),
                    "@daypicker/react",
                    "@daypicker/react/locale",
                ],
            },
            plugins: [...(viteConfiguration.plugins ?? []), tailwindcss()],
        };
    },
};

export default config;
