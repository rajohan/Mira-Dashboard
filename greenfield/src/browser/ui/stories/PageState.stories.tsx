import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { SearchX } from "lucide-react";
import { fn } from "storybook/test";

import { Button } from "../Button.tsx";
import { Card } from "../Card.tsx";
import { Heading } from "../Heading.tsx";
import { PageState } from "../PageState.tsx";
import { Text } from "../Text.tsx";

const meta = {
    component: PageState,
    parameters: {
        layout: "padded",
    },
} satisfies Meta<typeof PageState>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        label: "Loading cache entries…",
        status: "loading",
    },
};

export const Empty: Story = {
    args: {
        action: (
            <Button onClick={fn()} variant="secondary">
                Clear filters
            </Button>
        ),
        description: "Try another query or remove the active filters.",
        icon: SearchX,
        status: "empty",
        title: "No matching entries",
    },
};

export const Error: Story = {
    args: {
        message: "The cache inventory could not be loaded.",
        onRetry: fn(),
        retryLabel: "Reload inventory",
        status: "error",
        title: "Cache unavailable",
    },
};

export const ErrorRetrying: Story = {
    args: {
        message: "The durable job inventory could not be loaded.",
        onRetry: fn(),
        retryBusy: true,
        status: "error",
        title: "Jobs unavailable",
    },
};

export const Ready: Story = {
    args: {
        children: (
            <Card>
                <Heading level={2}>Ready content</Heading>
                <Text className="mt-2">The requested data is available.</Text>
            </Card>
        ),
        status: "ready",
    },
};
