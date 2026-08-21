import type { Preview } from "@storybook/tanstack-react";
import { themes } from "storybook/theming";

import {
    prepareStorybookBrowserStorage,
    resetStorybookBrowserStorage,
} from "../src/browser/storySupport/storybookBrowserStorage.ts";

import "../src/browser/storySupport/storybook.css";

const dashboardBackground = "#121316";

const preview: Preview = {
    afterEach: resetStorybookBrowserStorage,
    beforeEach: prepareStorybookBrowserStorage,
    initialGlobals: {
        backgrounds: {
            value: "dashboard",
        },
    },
    parameters: {
        a11y: {
            // Headless UI's intentionally focusable dialog sentinels are hidden from
            // assistive technology and otherwise produce an axe "incomplete" result.
            context: {
                exclude: 'button[data-headlessui-focus-guard="true"][aria-hidden="true"]',
            },
            test: "error",
        },
        backgrounds: {
            options: {
                dashboard: {
                    name: "Dashboard",
                    value: dashboardBackground,
                },
            },
        },
        controls: {
            matchers: {
                color: /(background|color)$/iu,
                date: /Date$/u,
            },
        },
        docs: {
            theme: themes.dark,
        },
        layout: "centered",
        options: {
            storySort: {
                method: "alphabetical",
                order: [
                    "Pages",
                    "UI",
                    "Authentication",
                    "Agents",
                    "Cache",
                    "Chat",
                    "Jobs",
                    "Monitoring",
                    "Notifications",
                    "Security",
                    "Tasks",
                ],
            },
        },
    },
    tags: ["autodocs"],
};

export default preview;
