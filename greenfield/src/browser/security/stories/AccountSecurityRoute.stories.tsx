import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { AccountSecuritySummary } from "../../../contracts/accountSecurity.ts";
import type { AuthSessionSummary } from "../../../contracts/auth.ts";
import type { SecurityAuditEventSummary } from "../../../contracts/securityAudit.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const currentSession = {
    authenticatedAtMs: nowMs - 60_000,
    authMethod: "password",
    createdAtMs: nowMs - 60_000,
    expiresAtMs: nowMs + 86_400_000,
    id: "a".repeat(32),
    isCurrent: true,
    lastSeenAtMs: nowMs,
    userAgent: "Current Storybook browser",
} as const satisfies AuthSessionSummary;
const otherSession = {
    ...currentSession,
    authenticatedAtMs: nowMs - 3_600_000,
    createdAtMs: nowMs - 3_600_000,
    id: "b".repeat(32),
    isCurrent: false,
    lastSeenAtMs: nowMs - 120_000,
    userAgent: "Tablet browser",
} as const satisfies AuthSessionSummary;
const totpFactor = {
    confirmedAtMs: nowMs - 86_400_000,
    createdAtMs: nowMs - 86_500_000,
    id: "019fd976-9d52-7a1b-86f4-3fc41d89dedd",
    label: "Primary authenticator",
} as const;
const recentVerification = {
    expiresAtMs: nowMs + 300_000,
    recent: true,
    remainingMs: 300_000,
    verifiedAtMs: nowMs,
} as const;
const readySummary = {
    checkedAtMs: nowMs,
    mfa: {
        enabled: true,
        enabledAtMs: nowMs - 86_400_000,
        methods: ["recovery", "totp"],
        recoveryCodesRemaining: 8,
        totpFactors: [totpFactor],
        webAuthnCredentials: [],
    },
    recentAuth: { mfa: recentVerification, password: recentVerification },
    webAuthn: { available: true, rpId: "dashboard.test" },
} as const satisfies AccountSecuritySummary;
const enrollmentSummary = {
    checkedAtMs: nowMs,
    mfa: {
        enabled: false,
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentAuth: { mfa: { recent: false }, password: recentVerification },
    webAuthn: { available: true, rpId: "dashboard.test" },
} as const satisfies AccountSecuritySummary;
const auditEvent = {
    action: "auth.login",
    actor: {
        authenticatorId: currentSession.id,
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        kind: "user",
    },
    id: "019fd977-c837-747d-9693-bcb8e34f6d6c",
    metadata: { method: "password" },
    occurredAtMs: nowMs,
    outcome: "succeeded",
    target: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        type: "user",
    },
} as const satisfies SecurityAuditEventSummary;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function accountSecurityFixtures(
    summary: AccountSecuritySummary,
    overrides: Partial<DashboardStoryFixtures> = {}
): DashboardStoryFixtures {
    return {
        mutations: overrides.mutations,
        queries: {
            "accountSecurity.summary": dashboardStoryValue(summary),
            "auth.sessions": dashboardStoryValue({
                sessions: [currentSession, otherSession],
            }),
            "automationSecurity.listPrincipals": dashboardStoryValue({
                activePrincipalCount: 0,
                principals: [],
                totalPrincipalCount: 0,
            }),
            "notifications.list": dashboardStoryValue(notifications),
            "securityAudit.listEvents": dashboardStoryValue({ events: [auditEvent] }),
            ...overrides.queries,
        },
    };
}

const pendingSummary = dashboardStoryResolver(
    () =>
        new Promise<never>(() => {
            // Intentionally pending to preserve the route-level loading state.
        })
);

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
    title: "Pages/Account security",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            queries: { "accountSecurity.summary": pendingSummary },
        }),
        route: "/account-security",
    },
};

export const Ready: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary),
        route: "/account-security",
    },
};

export const InitialError: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            queries: {
                "accountSecurity.summary": dashboardStoryFailure(
                    new TypeError("Safe account-security story failure")
                ),
            },
        }),
        route: "/account-security",
    },
};

export const DestructiveConfirmation: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", {
                name: `Remove authenticator ${totpFactor.label}`,
            })
        );
        const dialog = await page.findByRole("dialog", {
            name: "Remove authenticator?",
        });
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
        });
        const removeButton = within(dialog).getByRole("button", {
            name: "Remove authenticator",
        });
        await waitFor(async () => {
            await expect(removeButton).toBeVisible();
        });
    },
};

export const EnrollmentSecret: Story = {
    args: {
        fixtures: accountSecurityFixtures(enrollmentSummary, {
            mutations: {
                "accountSecurity.beginTotpEnrollment": dashboardStoryValue({
                    enrollment: {
                        expiresAtMs: nowMs + 300_000,
                        factorId: totpFactor.id,
                        label: "Storybook phone",
                        otpauthUri:
                            "otpauth://totp/Mira:operator?secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        secret: "A".repeat(32),
                    },
                }),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Add authenticator app" })
        );
        const labelDialog = await page.findByRole("dialog", {
            name: "Add authenticator app",
        });
        await userEvent.type(
            within(labelDialog).getByLabelText("Name"),
            "Storybook phone"
        );
        await userEvent.click(
            within(labelDialog).getByRole("button", { name: "Continue" })
        );
        await expect(
            await page.findByRole("heading", {
                name: "Finish authenticator app setup",
            })
        ).toBeVisible();
        await expect(await page.findByText("A".repeat(32))).toBeVisible();
        await expect(page.getByTitle("Authenticator enrollment QR code")).toBeVisible();
    },
};
