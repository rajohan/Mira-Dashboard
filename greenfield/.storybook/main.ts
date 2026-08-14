import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { StorybookConfig } from "@storybook/tanstack-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv } from "vite";

const storybookAllowedHostEnvironmentName = "MIRA_DASHBOARD_STORYBOOK_ALLOWED_HOST";
const storybookBrowserPort = 6006;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const storybookEnvironment = loadEnv(
    "storybook",
    fileURLToPath(new URL(".", import.meta.url)),
    "MIRA_DASHBOARD_STORYBOOK_"
);

function optionalStorybookAllowedHost(): string | undefined {
    const configured = storybookEnvironment[storybookAllowedHostEnvironmentName];
    if (configured === undefined) return;
    if (
        configured.length > 253 ||
        configured.length === 0 ||
        configured !== configured.trim() ||
        configured !== configured.toLowerCase() ||
        isIP(configured) !== 0 ||
        configured.split(".").some((label) => !dnsLabelPattern.test(label))
    ) {
        throw new Error(
            `${storybookAllowedHostEnvironmentName} must be an exact DNS host`
        );
    }
    return configured;
}

const storybookAllowedHost = optionalStorybookAllowedHost();

const config: StorybookConfig = {
    addons: ["@storybook/addon-a11y", "@storybook/addon-docs", "@storybook/addon-vitest"],
    ...(storybookAllowedHost === undefined
        ? {}
        : { core: { allowedHosts: [storybookAllowedHost] } }),
    framework: {
        name: "@storybook/tanstack-react",
        options: {},
    },
    stories: ["../src/browser/**/*.stories.tsx"],
    viteFinal(viteConfiguration) {
        return {
            ...viteConfiguration,
            optimizeDeps: {
                ...viteConfiguration.optimizeDeps,
                include: [
                    ...(viteConfiguration.optimizeDeps?.include ?? []),
                    "@daypicker/react",
                    "@daypicker/react/locale",
                ],
            },
            plugins: [...(viteConfiguration.plugins ?? []), tailwindcss()],
            ...(storybookAllowedHost === undefined
                ? {}
                : {
                      server: {
                          ...viteConfiguration.server,
                          allowedHosts:
                              viteConfiguration.server?.allowedHosts === true
                                  ? true
                                  : [
                                        ...(viteConfiguration.server?.allowedHosts ?? []),
                                        storybookAllowedHost,
                                    ],
                          ws:
                              viteConfiguration.server?.ws === false
                                  ? false
                                  : {
                                        ...viteConfiguration.server?.ws,
                                        clientPort: storybookBrowserPort,
                                    },
                      },
                  }),
        };
    },
};

export default config;
