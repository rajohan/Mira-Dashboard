import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect } from "storybook/test";

import { Markdown } from "../Markdown.tsx";

const operatorReport = `# Host capacity report

The **Dashboard host** is healthy and all reviewed checks passed.

| Resource | Used | Status |
| --- | ---: | --- |
| Memory | 42% | Healthy |
| Disk | 61% | Healthy |

- Queue claiming is active
- No stale cache entries
- [Open the runbook](https://example.com/runbook)

\`cache.getStatus\` returned 12 entries.`;

const meta = {
    args: {
        source: operatorReport,
    },
    component: Markdown,
    parameters: {
        layout: "padded",
    },
    title: "UI/Markdown",
} satisfies Meta<typeof Markdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const GitHubFlavoredReport: Story = {};

export const RawHtmlRemainsInert: Story = {
    args: {
        source: `## Reviewed content

Raw HTML is not enabled.

<script>globalThis.storybookUnsafeMarkup = true</script>

The surrounding Markdown still renders.`,
    },
    play: async ({ canvasElement }) => {
        await expect(canvasElement.querySelector("script")).toBeNull();
    },
};
