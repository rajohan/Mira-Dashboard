import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import type { AccountSecuritySummary } from "../../../contracts/accountSecurity.ts";
import type { AuthSessionSummary } from "../../../contracts/auth.ts";
import type { SecurityAuditEventSummary } from "../../../contracts/securityAudit.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    authenticatedDashboardStoryStatus,
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";

const nowMs = 1_800_000_000_000;
const asyncStoryTimeout = { timeout: 5000 } as const;
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
const staleEnrollmentSummary = {
    ...enrollmentSummary,
    recentAuth: { mfa: { recent: false }, password: { recent: false } },
} as const satisfies AccountSecuritySummary;

function stalePasswordEnrollmentScenario(): {
    readonly allowSessionRefresh: () => void;
    readonly failSessionRefresh: () => Promise<void>;
    readonly fixtures: DashboardStoryFixtures;
    readonly reset: () => void;
} {
    let reauthenticationCompleted = false;
    let sessionRefreshAllowed = false;
    let pendingSessionRefresh: Promise<never> | undefined;
    let rejectSessionRefresh: ((error: TypeError) => void) | undefined;
    let signalSessionRefreshStarted: (() => void) | undefined;
    let sessionRefreshStarted: Promise<void>;

    const reset = () => {
        reauthenticationCompleted = false;
        sessionRefreshAllowed = false;
        pendingSessionRefresh = undefined;
        rejectSessionRefresh = undefined;
        sessionRefreshStarted = new Promise<void>((resolve) => {
            signalSessionRefreshStarted = resolve;
        });
    };
    reset();

    return {
        allowSessionRefresh: () => {
            sessionRefreshAllowed = true;
            pendingSessionRefresh = undefined;
            rejectSessionRefresh = undefined;
        },
        failSessionRefresh: async () => {
            await sessionRefreshStarted;
            const reject = rejectSessionRefresh;
            const pending = pendingSessionRefresh;
            if (reject === undefined || pending === undefined) {
                throw new TypeError("Session refresh was not pending");
            }
            await waitFor(async () => {
                reject(new TypeError("Safe session refresh failure"));
                await pending.catch(() => {});
            });
        },
        fixtures: accountSecurityFixtures(staleEnrollmentSummary, {
            mutations: {
                "accountSecurity.reauthenticatePassword": dashboardStoryResolver(() => {
                    reauthenticationCompleted = true;
                    return {
                        session: currentSession,
                        verifiedAtMs: nowMs,
                    };
                }),
            },
            queries: {
                "auth.status": dashboardStoryResolver(() => {
                    if (reauthenticationCompleted && !sessionRefreshAllowed) {
                        pendingSessionRefresh ??= new Promise<never>(
                            (_resolve, reject) => {
                                rejectSessionRefresh = reject;
                                signalSessionRefreshStarted?.();
                            }
                        );
                        return pendingSessionRefresh;
                    }
                    return authenticatedDashboardStoryStatus;
                }),
            },
        }),
        reset,
    };
}
const allMfaStaleSummary = {
    ...readySummary,
    mfa: {
        ...readySummary.mfa,
        methods: ["recovery", "totp", "webauthn"],
        webAuthnCredentials: [
            {
                backedUp: false,
                createdAtMs: nowMs - 86_400_000,
                deviceType: "singleDevice",
                id: "019fd978-1e89-7819-b845-0c843bec6937",
                label: "Storybook security key",
                transports: ["usb"],
                usable: true,
            },
        ],
    },
    recentAuth: { ...readySummary.recentAuth, mfa: { recent: false } },
} as const satisfies AccountSecuritySummary;
const storyRecoveryCodes = Array.from(
    { length: 10 },
    (_, index) =>
        `${index.toString(16).padStart(32, "0")}-${(index + 16)
            .toString(16)
            .padStart(32, "0")}`
);
const storyWebAuthnAuthenticationOptions = {
    allowCredentials: [{ id: "AAAAAAAA", type: "public-key" }],
    challenge: "A".repeat(32),
    rpId: "dashboard.test",
    timeout: 60_000,
    userVerification: "required",
} as const;
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
const paginatedAuditEvents = Array.from({ length: 51 }, (_, index) => ({
    ...auditEvent,
    action: index % 2 === 0 ? "auth.login" : "auth.session.revoke",
    id: `019fd977-c837-747d-9693-${index.toString(16).padStart(12, "0")}`,
    metadata:
        index % 3 === 0
            ? ({ reason: "invalid_current_password" } as const)
            : auditEvent.metadata,
    occurredAtMs: nowMs - index * 1000,
})) satisfies SecurityAuditEventSummary[];
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

const stalePasswordEnrollment = stalePasswordEnrollmentScenario();

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
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            await canvas.findByRole(
                "heading",
                { level: 1, name: "Account security" },
                asyncStoryTimeout
            )
        ).toBeInTheDocument();
        await expect(
            await canvas.findByText("Current Storybook browser", {}, asyncStoryTimeout)
        ).toBeVisible();
        await expect(
            await canvas.findByText("No automation accounts", {}, asyncStoryTimeout)
        ).toBeVisible();
        await expect(
            await canvas.findByRole(
                "region",
                { name: "Security audit events" },
                asyncStoryTimeout
            )
        ).toBeVisible();
    },
};

export const EmailChange: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            mutations: {
                "auth.changeEmail": dashboardStoryValue({
                    email: "new-address@example.com",
                }),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Change email" }, asyncStoryTimeout)
        );
        const page = within(canvasElement.ownerDocument.body);
        await expect(await page.findByLabelText("Email")).toHaveValue(
            authenticatedDashboardStoryStatus.user.email
        );
    },
};

export const PaginatedAudit: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            queries: {
                "securityAudit.listEvents": dashboardStoryResolver((input, callIndex) => {
                    const cursor = (input as { cursor?: { id?: string } }).cursor;
                    if (cursor === undefined) {
                        const page = paginatedAuditEvents.slice(0, 50);
                        const last = page.at(-1);
                        return {
                            events: page,
                            nextCursor:
                                last === undefined
                                    ? undefined
                                    : { id: last.id, occurredAtMs: last.occurredAtMs },
                        };
                    }
                    if (
                        cursor.id === paginatedAuditEvents.at(49)?.id &&
                        callIndex === 2
                    ) {
                        throw new TypeError("Safe older-audit failure");
                    }
                    return { events: paginatedAuditEvents.slice(50) };
                }),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(async () => {
            await expect(
                canvas.getByRole("region", { name: "Security audit events" })
            ).toHaveAttribute("data-virtualized", "true");
        }, asyncStoryTimeout);
        const auditRegion = canvas.getByRole("region", {
            name: "Security audit events",
        });
        const audit = within(auditRegion);
        await waitFor(async () => {
            await expect(auditRegion.scrollHeight).toBeGreaterThan(
                auditRegion.clientHeight
            );
        }, asyncStoryTimeout);
        auditRegion.scrollTop = auditRegion.scrollHeight;
        await fireEvent.scroll(auditRegion);
        await fireEvent.scroll(auditRegion);
        await expect(
            await audit.findByText("The request could not be completed. Try again.")
        ).toBeVisible();
        await userEvent.click(audit.getByRole("button", { name: "Try again" }));
        await waitFor(async () => {
            await expect(
                audit.queryByText("The request could not be completed. Try again.")
            ).not.toBeInTheDocument();
        }, asyncStoryTimeout);
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

export const StalePasswordEnrollment: Story = {
    args: {
        fixtures: stalePasswordEnrollment.fixtures,
        route: "/account-security",
    },
    beforeEach: () => {
        stalePasswordEnrollment.reset();
        return stalePasswordEnrollment.reset;
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole(
                "button",
                { name: "Add authenticator app" },
                asyncStoryTimeout
            )
        );
        const verification = await page.findByRole(
            "dialog",
            { name: "Verify current password" },
            asyncStoryTimeout
        );
        const password = within(verification).getByLabelText("Current password");
        await fireEvent.change(password, { target: { value: "current password" } });
        await userEvent.click(
            within(verification).getByRole("button", { name: "Verify password" })
        );
        const enrollment = await page.findByRole(
            "dialog",
            { name: "Add authenticator app" },
            asyncStoryTimeout
        );
        await expect(within(enrollment).getByLabelText("Name")).toBeVisible();
        await fireEvent.click(within(enrollment).getByRole("button", { name: "Cancel" }));
        await page.findByRole(
            "status",
            { name: "Refreshing secure session…" },
            asyncStoryTimeout
        );
        await stalePasswordEnrollment.failSessionRefresh();
        const retry = await page.findByRole(
            "button",
            {
                name: "Retry secure session refresh",
            },
            asyncStoryTimeout
        );
        stalePasswordEnrollment.allowSessionRefresh();
        await fireEvent.click(retry);
        await waitFor(async () => {
            await expect(
                page.queryByRole("button", {
                    name: "Retry secure session refresh",
                })
            ).not.toBeInTheDocument();
        }, asyncStoryTimeout);
    },
};

export const StaleMfaEnrollment: Story = {
    args: {
        fixtures: accountSecurityFixtures(allMfaStaleSummary, {
            mutations: {
                "accountSecurity.stepUpRecovery": dashboardStoryFailure(
                    Object.assign(new Error("Safe recovery proof failure"), {
                        data: { code: "UNAUTHORIZED" },
                    })
                ),
                "accountSecurity.stepUpTotp": dashboardStoryValue({
                    method: "totp",
                    session: { ...currentSession, authMethod: "totp" },
                    verifiedAtMs: nowMs,
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
        const verification = await page.findByRole("dialog", {
            name: "Verify your session",
        });
        await userEvent.click(
            within(verification).getByRole("button", { name: "Use recovery code" })
        );
        await fireEvent.change(within(verification).getByLabelText("Recovery code"), {
            target: { value: storyRecoveryCodes[0]! },
        });
        await userEvent.click(
            within(verification).getByRole("button", { name: "Use recovery code" })
        );
        const recoveryError = await within(verification).findByText(
            "The credentials or session are no longer valid.",
            {},
            asyncStoryTimeout
        );
        await waitFor(async () => {
            await expect(recoveryError).toBeVisible();
        }, asyncStoryTimeout);
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Choose another method",
            })
        );
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        await fireEvent.change(
            within(verification).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Verify authenticator",
            })
        );
        const enrollment = await page.findByRole("dialog", {
            name: "Add authenticator app",
        });
        await expect(within(enrollment).getByLabelText("Name")).toBeVisible();
    },
};

export const StaleWebAuthnEnrollment: Story = {
    args: {
        fixtures: accountSecurityFixtures(allMfaStaleSummary, {
            mutations: {
                "accountSecurity.beginWebAuthnStepUp": dashboardStoryValue({
                    expiresAtMs: nowMs + 60_000,
                    options: storyWebAuthnAuthenticationOptions,
                }),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Add security key" })
        );
        const verification = await page.findByRole("dialog", {
            name: "Verify your session",
        });
        await userEvent.click(
            within(verification).getByRole("button", { name: "Use security key" })
        );
        await waitFor(async () => {
            await expect(
                within(verification).getByText(
                    "The request could not be completed. Try again."
                )
            ).toBeVisible();
        }, asyncStoryTimeout);
    },
};

export const EnrollmentRequired: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            mutations: {
                "accountSecurity.rotateRecoveryCodes": dashboardStoryFailure(
                    Object.assign(new Error("Safe enrollment-required failure"), {
                        data: {
                            code: "FORBIDDEN",
                            reason: "mfa_enrollment_required",
                        },
                    })
                ),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Create new codes" })
        );
        const confirmation = await page.findByRole("dialog", {
            name: "Create new recovery codes?",
        });
        await userEvent.click(
            within(confirmation).getByRole("button", {
                name: "Create new recovery codes",
            })
        );
        const verification = await page.findByRole("dialog", {
            name: "Protect privileged actions",
        });
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Open Dashboard security settings",
            })
        );
        await waitFor(async () => {
            await expect(
                page.queryByRole("dialog", { name: "Protect privileged actions" })
            ).not.toBeInTheDocument();
        }, asyncStoryTimeout);
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
        const dialog = await page.findByRole(
            "dialog",
            {
                name: "Remove authenticator?",
            },
            asyncStoryTimeout
        );
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
        }, asyncStoryTimeout);
        const removeButton = within(dialog).getByRole("button", {
            name: "Remove authenticator",
        });
        await waitFor(async () => {
            await expect(removeButton).toBeVisible();
        }, asyncStoryTimeout);
    },
};

export const DisableMfaRecovery: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            mutations: {
                "accountSecurity.disableMfa": dashboardStoryResolver(
                    (_input, callIndex) => {
                        if (callIndex === 0) {
                            throw Object.assign(new Error("Safe MFA disable failure"), {
                                data: { code: "UNAUTHORIZED" },
                            });
                        }
                        return {
                            disabled: true,
                            revokedSessions: 1,
                            session: currentSession,
                        };
                    }
                ),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        const openDisable = async () => {
            await userEvent.click(
                await canvas.findByRole("button", { name: "Disable" }, asyncStoryTimeout)
            );
            return page.findByRole(
                "dialog",
                { name: "Disable two-step login" },
                asyncStoryTimeout
            );
        };

        let dialog = await openDisable();
        await fireEvent.change(within(dialog).getByLabelText("Current password"), {
            target: { value: "discarded password" },
        });
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(async () => {
            await expect(
                page.queryByRole("dialog", { name: "Disable two-step login" })
            ).not.toBeInTheDocument();
        }, asyncStoryTimeout);

        dialog = await openDisable();
        await fireEvent.change(within(dialog).getByLabelText("Current password"), {
            target: { value: "current password" },
        });
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Turn off MFA" })
        );
        await waitFor(async () => {
            await expect(
                within(dialog).getByText(
                    "The credentials or session are no longer valid."
                )
            ).toBeVisible();
        }, asyncStoryTimeout);
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Turn off MFA" })
        );
        await waitFor(async () => {
            await expect(
                page.queryByRole("dialog", { name: "Disable two-step login" })
            ).not.toBeInTheDocument();
        }, asyncStoryTimeout);
    },
};

export const VerificationMethodSwitch: Story = {
    args: {
        fixtures: accountSecurityFixtures(readySummary, {
            mutations: {
                "accountSecurity.stepUpRecovery": dashboardStoryValue({
                    method: "recovery",
                    recoveryCodesRemaining: 7,
                    session: { ...currentSession, authMethod: "recovery" },
                    verifiedAtMs: nowMs,
                }),
                "accountSecurity.stepUpTotp": dashboardStoryFailure(
                    Object.assign(new Error("Safe authenticator proof failure"), {
                        data: { code: "UNAUTHORIZED" },
                    })
                ),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(await canvas.findByRole("button", { name: "Verify now" }));
        const verification = await page.findByRole("dialog", {
            name: "Verify second factor",
        });
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        await fireEvent.change(
            within(verification).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Verify authenticator",
            })
        );
        const authenticatorError = await within(verification).findByText(
            "The credentials or session are no longer valid.",
            {},
            asyncStoryTimeout
        );
        await waitFor(async () => {
            await expect(authenticatorError).toBeVisible();
        }, asyncStoryTimeout);
        await userEvent.click(
            within(verification).getByRole("button", {
                name: "Choose another method",
            })
        );
        await userEvent.click(
            within(verification).getByRole("button", { name: "Use recovery code" })
        );
        await fireEvent.change(within(verification).getByLabelText("Recovery code"), {
            target: { value: storyRecoveryCodes[0]! },
        });
        await userEvent.click(
            within(verification).getByRole("button", { name: "Use recovery code" })
        );
        await expect(await canvas.findByText("Recovery code accepted.")).toBeVisible();
    },
};

export const LocalPasswordVerification: Story = {
    args: {
        fixtures: accountSecurityFixtures(staleEnrollmentSummary, {
            mutations: {
                "accountSecurity.reauthenticatePassword": dashboardStoryValue({
                    session: currentSession,
                    verifiedAtMs: nowMs,
                }),
            },
        }),
        route: "/account-security",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await canvas.findByRole("button", { name: "Verify password" })
        );
        const verification = await page.findByRole("dialog", {
            name: "Verify current password",
        });
        await fireEvent.change(
            within(verification).getByLabelText("Password to confirm your identity"),
            { target: { value: "current password" } }
        );
        await userEvent.click(
            within(verification).getByRole("button", { name: "Verify password" })
        );
        await expect(await canvas.findByText("Password confirmed.")).toBeVisible();
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
        await fireEvent.change(within(labelDialog).getByLabelText("Name"), {
            target: { value: "Storybook phone" },
        });
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
