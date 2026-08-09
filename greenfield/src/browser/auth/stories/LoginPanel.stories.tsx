import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { fn } from "storybook/test";

import { Button } from "../../ui/Button.tsx";
import { FormField } from "../../ui/FormField.tsx";
import { Input } from "../../ui/Input.tsx";
import { LoginPanel } from "../LoginPanel.tsx";

const meta = {
    args: {
        children: (
            <div className="space-y-4">
                <FormField label="Username">
                    <Input
                        autoComplete="username"
                        className="mt-2"
                        defaultValue="operator"
                        placeholder="Example: operator"
                    />
                </FormField>
                <FormField label="Password">
                    <Input
                        autoComplete="current-password"
                        className="mt-2"
                        placeholder="Enter your password"
                        type="password"
                    />
                </FormField>
                <Button fullWidth onClick={fn()}>
                    Sign in
                </Button>
            </div>
        ),
        description: "Sign in with the local Dashboard operator account.",
        icon: ShieldCheck,
        title: "Welcome back",
    },
    component: LoginPanel,
    parameters: {
        layout: "padded",
    },
    title: "Authentication/LoginPanel",
} satisfies Meta<typeof LoginPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PasswordLogin: Story = {};

export const VerificationStep: Story = {
    args: {
        children: (
            <div className="space-y-4">
                <FormField
                    description="Enter the six-digit code from the configured authenticator."
                    label="Verification code"
                >
                    <Input
                        autoComplete="one-time-code"
                        className="mt-2"
                        inputMode="numeric"
                        placeholder="Example: 123456"
                    />
                </FormField>
                <Button fullWidth onClick={fn()}>
                    Verify
                </Button>
            </div>
        ),
        description: "Enter one more verification method to finish signing in.",
        icon: KeyRound,
        title: "Verify your identity",
    },
};
