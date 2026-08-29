import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, within } from "storybook/test";

import type { AuthStatus, PendingLoginSummary } from "../../../contracts/auth.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const pendingLogin = {
    expiresAtMs: nowMs + 60_000,
    methods: ["totp", "recovery", "webauthn"],
    username: "operator",
} as const satisfies PendingLoginSummary;

const anonymous = { state: "anonymous" } as const satisfies AuthStatus;
const bootstrap = { state: "bootstrap-required" } as const satisfies AuthStatus;
const pendingMfa = { pendingLogin, state: "pending-mfa" } as const satisfies AuthStatus;

function loginStory(status: AuthStatus) {
    return {
        fixtures: { queries: { "auth.status": dashboardStoryValue(status) } },
        route: "/login" as const,
    };
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: {
            queries: {
                "auth.status": dashboardStoryResolver(
                    () =>
                        new Promise<never>(() => {
                            // Intentionally pending to render the route loading state.
                        })
                ),
            },
        },
        route: "/login",
    },
};

export const Unavailable: Story = {
    args: {
        fixtures: {
            queries: {
                "auth.status": dashboardStoryFailure(
                    new TypeError("Safe story transport failure")
                ),
            },
        },
        route: "/login",
    },
    play: async ({ canvasElement }) => {
        await expect(await within(canvasElement).findByRole("alert")).toBeVisible();
    },
};

export const Bootstrap: Story = { args: loginStory(bootstrap) };

export const Password: Story = { args: loginStory(anonymous) };

export const ForgotPassword: Story = {
    args: loginStory(anonymous),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Forgot password?" })
        );
        await expect(
            await canvas.findByRole("heading", { name: "Reset password" })
        ).toBeVisible();
    },
};

export const ResetPassword: Story = {
    args: {
        ...loginStory(anonymous),
        initialEntry: `/login?resetToken=${"a".repeat(32)}.${"b".repeat(64)}`,
    },
};

export const EmailVerification: Story = {
    args: {
        fixtures: {
            mutations: {
                "auth.verifyEmail": dashboardStoryValue({
                    email: "operator@example.com",
                }),
            },
            queries: { "auth.status": dashboardStoryValue(anonymous) },
        },
        initialEntry: `/login?verifyEmailToken=${"a".repeat(32)}.${"b".repeat(64)}`,
        route: "/login",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByText("operator@example.com is now verified.")
        ).toBeVisible();
    },
};

export const EmailVerificationError: Story = {
    args: {
        fixtures: {
            mutations: {
                "auth.verifyEmail": dashboardStoryFailure(
                    new TypeError("Safe expired verification link")
                ),
            },
            queries: { "auth.status": dashboardStoryValue(anonymous) },
        },
        initialEntry: `/login?verifyEmailToken=${"a".repeat(32)}.${"b".repeat(64)}`,
        route: "/login",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("alert")).toBeVisible();
    },
};

export const PendingTotp: Story = {
    args: loginStory(pendingMfa),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Use authenticator app" })
        );
        await expect(await canvas.findByLabelText("Authenticator code")).toBeVisible();
    },
};

export const RecoveryCode: Story = {
    args: loginStory(pendingMfa),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Use recovery code" })
        );
        await userEvent.click(await canvas.findByLabelText("Recovery code"));
        await expect(canvas.getByLabelText("Recovery code")).toHaveFocus();
    },
};

export const WebAuthn: Story = {
    args: loginStory(pendingMfa),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole("button", { name: "Use a security key" })
        ).toBeVisible();
    },
};

export const ProofError: Story = {
    args: {
        fixtures: {
            mutations: {
                "auth.loginTotp": dashboardStoryFailure(
                    new TypeError("Safe story proof failure")
                ),
            },
            queries: { "auth.status": dashboardStoryValue(pendingMfa) },
        },
        route: "/login",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Use authenticator app" })
        );
        await userEvent.type(
            await canvas.findByLabelText("Authenticator code"),
            "123456"
        );
        await userEvent.click(canvas.getByRole("button", { name: "Verify code" }));
        await expect(await canvas.findByRole("alert")).toBeVisible();
    },
};
