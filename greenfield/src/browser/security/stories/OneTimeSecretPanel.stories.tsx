import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import { OneTimeSecretPanel, SecuritySection } from "../SecurityUi.tsx";

const meta = {
    args: {
        children:
            "0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        id: "issued-automation-token",
        onDismiss: fn(),
        title: "Automation token issued",
    },
    component: OneTimeSecretPanel,
    parameters: {
        layout: "padded",
    },
    render: (properties) => (
        <SecuritySection
            description="Create automation accounts and manage their access tokens."
            id="automation-security-heading"
            title="Automation security"
        >
            <OneTimeSecretPanel {...properties} />
        </SecuritySection>
    ),
    title: "Security/OneTimeSecretPanel",
} satisfies Meta<typeof OneTimeSecretPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NewlyIssued: Story = {
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", { name: "Dismiss" })
        );
        await expect(args.onDismiss).toHaveBeenCalledOnce();
    },
};
