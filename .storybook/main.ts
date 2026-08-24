import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { StorybookConfig } from "@storybook/tanstack-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv } from "vite";

const storybookAllowedHostEnvironmentName = "MIRA_DASHBOARD_STORYBOOK_ALLOWED_HOST";
const storybookPortEnvironmentName = "MIRA_DASHBOARD_STORYBOOK_PORT";
// Storybook's generated docs runtime is intentionally self-contained and is not
// shipped with the Dashboard browser bundle. Keep its build budget explicit.
const storybookChunkSizeWarningLimitKiB = 3600;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const storybookEnvironment = loadEnv(
    "storybook",
    fileURLToPath(new URL(".", import.meta.url)),
    "MIRA_DASHBOARD_STORYBOOK_"
);

function storybookBrowserPort(): number {
    const configured = storybookEnvironment[storybookPortEnvironmentName] ?? "6006";
    if (!/^[1-9][0-9]{0,4}$/u.test(configured)) {
        throw new Error(`${storybookPortEnvironmentName} must be a valid TCP port`);
    }
    const port = Number(configured);
    if (port > 65_535) {
        throw new Error(`${storybookPortEnvironmentName} must be a valid TCP port`);
    }
    return port;
}

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
const storybookPort = storybookBrowserPort();

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
            build: {
                ...viteConfiguration.build,
                chunkSizeWarningLimit: storybookChunkSizeWarningLimitKiB,
            },
            optimizeDeps: {
                ...viteConfiguration.optimizeDeps,
                include: [
                    ...(viteConfiguration.optimizeDeps?.include ?? []),
                    "@date-fns/tz",
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
                                        clientPort: storybookPort,
                                    },
                      },
                  }),
        };
    },
};

export default config;
