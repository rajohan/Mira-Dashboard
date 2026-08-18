import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { AccountSecuritySummary } from "../../../contracts/accountSecurity.ts";
import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationSnapshot,
} from "../../../contracts/openClawSettings.ts";
import { openClawReviewedAgentToolIds } from "../../../contracts/openClawSettings.ts";
import { DashboardPageStory } from "../../storySupport/dashboardPageStoryHarness.tsx";
import {
    dashboardStoryFailure,
    dashboardStoryResolver,
    dashboardStoryValue,
    type DashboardStoryFixtures,
} from "../../storySupport/dashboardStoryTransport.ts";
import { openClawConfigurationQueryKey } from "../openClawSettingsQueries.ts";

const nowMs = 1_800_000_000_000;
const configurationHash = "b".repeat(64);
const configurationRevisionHash = `${"R".repeat(42)}A`;
const configuration = {
    agentAccess: [
        {
            id: "main",
            name: "Main",
            tools: openClawReviewedAgentToolIds.map((id) => ({
                editable: id !== "gateway",
                id,
                override: id === "exec" ? ("allow" as const) : ("inherit" as const),
            })),
        },
    ],
    agentAccessTruncated: false,
    channels: [
        { enabled: true, id: "discord" },
        { enabled: false, id: "webchat" },
    ],
    channelsTruncated: false,
    hash: configurationHash,
    heartbeat: { everySeconds: 3600, target: "operations" },
    includesPresent: false,
    issueCount: 0,
    lastTouchedAt: "2026-08-11T12:00:00.000Z",
    lastTouchedVersion: "2026.8.11",
    models: {
        fallbacks: ["openai/gpt-5.6-terra"],
        primary: "openai/gpt-5.6-sol",
    },
    modelNormalizationState: "clean",
    revisionHash: configurationRevisionHash,
    security: {
        authProfileCount: 2,
        commandRestartEnabled: false,
        ownerAllowFromCount: 1,
        redactionMode: "strict",
    },
    sessionReset: { idleMinutes: 60, mode: "idle", state: "explicit-idle" },
    tools: {
        agentToAgentEnabled: true,
        elevatedEnabled: false,
        execPolicy: {
            ask: "on-miss",
            security: "allowlist",
            state: "explicit",
        },
        profile: "coding",
        sessionsVisibility: "agent",
        webFetchEnabled: true,
        webSearchEnabled: true,
        webSearchProvider: "brave",
    },
    valid: true,
} as const satisfies OpenClawConfigurationSnapshot;
const skills = {
    skills: [
        {
            bundled: true,
            description: "Search existing source before implementation.",
            eligible: true,
            enabled: true,
            installed: true,
            key: "search-first",
            name: "Search first",
            source: "openclaw-bundled",
        },
        {
            bundled: false,
            description: "Installed but unavailable on this host.",
            eligible: false,
            enabled: false,
            installed: true,
            key: "unavailable-skill",
            name: "Unavailable skill",
            source: "openclaw-managed",
        },
    ],
    truncated: false,
} as const satisfies ListOpenClawSkillsResult;
const accountSummary = {
    checkedAtMs: nowMs,
    mfa: {
        enabled: false,
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentAuth: {
        mfa: { recent: false },
        password: {
            expiresAtMs: nowMs + 300_000,
            recent: true,
            remainingMs: 300_000,
            verifiedAtMs: nowMs,
        },
    },
    webAuthn: { available: true, rpId: "dashboard.test" },
} as const satisfies AccountSecuritySummary;
const notifications = { notifications: [], readCount: 0, unreadCount: 0 } as const;

function codedError(code: string, reason?: string): Error {
    return Object.assign(new Error("Private Storybook failure detail"), {
        data: { code, reason },
    });
}

function accountQueries(): NonNullable<DashboardStoryFixtures["queries"]> {
    return {
        "accountSecurity.summary": dashboardStoryValue(accountSummary),
        "auth.sessions": dashboardStoryValue({ sessions: [] }),
        "automationSecurity.listPrincipals": dashboardStoryValue({
            activePrincipalCount: 0,
            principals: [],
            totalPrincipalCount: 0,
        }),
        "notifications.list": dashboardStoryValue(notifications),
        "securityAudit.listEvents": dashboardStoryValue({ events: [] }),
    };
}

function openClawFixtures(
    overrides: Partial<DashboardStoryFixtures> = {}
): DashboardStoryFixtures {
    return {
        mutations: overrides.mutations,
        queries: {
            "notifications.list": dashboardStoryValue(notifications),
            "openClawSettings.getConfiguration": dashboardStoryValue(configuration),
            "openClawSettings.listSkills": dashboardStoryValue(skills),
            ...overrides.queries,
        },
    };
}

async function openOpenClawSettings(canvasElement: HTMLElement) {
    const canvas = within(canvasElement);
    await userEvent.click(
        await canvas.findByRole("tab", { name: "OpenClaw settings" }, { timeout: 3000 })
    );
    await expect(
        await canvas.findByRole("button", { name: "Restart OpenClaw Gateway" })
    ).toBeVisible();
    return canvas;
}

async function openModelSettings(canvasElement: HTMLElement) {
    const canvas = await openOpenClawSettings(canvasElement);
    const section = await canvas.findByRole(
        "button",
        { name: "Model Configuration" },
        { timeout: 5000 }
    );
    await userEvent.click(section);
    await expect(section).toHaveAttribute("aria-expanded", "true");
    const primary = await canvas.findByRole("textbox", { name: "Default model" });
    await waitFor(() => expect(primary).toBeVisible(), { timeout: 3000 });
    return canvas;
}

async function submitModelChange(canvasElement: HTMLElement) {
    const canvas = await openModelSettings(canvasElement);
    const primary = canvas.getByRole("textbox", { name: "Default model" });
    await userEvent.clear(primary);
    await userEvent.type(primary, "openai/gpt-5.6-terra");
    await userEvent.click(canvas.getByRole("button", { name: "Save model settings" }));
    return canvas;
}

const meta = {
    component: DashboardPageStory,
    parameters: { layout: "fullscreen" },
    render: (args, context) => <DashboardPageStory {...args} key={context.id} />,
    title: "Pages/Settings",
} satisfies Meta<typeof DashboardPageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DashboardTab: Story = {
    args: { fixtures: { queries: accountQueries() }, route: "/settings" },
};

export const OpenClawFresh: Story = {
    args: { fixtures: openClawFixtures(), route: "/settings" },
    play: async ({ canvasElement }) => {
        await openOpenClawSettings(canvasElement);
    },
};

export const PartialStale: Story = {
    args: {
        fixtures: openClawFixtures({
            queries: {
                "openClawSettings.getConfiguration": dashboardStoryFailure(
                    codedError("FORBIDDEN")
                ),
            },
        }),
        querySeeds: [
            {
                key: openClawConfigurationQueryKey,
                updatedAtMs: 1,
                value: configuration,
            },
        ],
        route: "/settings",
    },
    play: async ({ canvasElement }) => {
        const canvas = await openModelSettings(canvasElement);
        await expect(
            await canvas.findByText(
                /Current OpenClaw configuration could not be refreshed/iu
            )
        ).toBeVisible();
        const primaryModel = canvas.getByRole("textbox", { name: "Default model" });
        await expect(primaryModel).toHaveValue("openai/gpt-5.6-sol");
        await expect(primaryModel).toBeDisabled();
    },
};

export const ConfigurationUnavailable: Story = {
    args: {
        fixtures: openClawFixtures({
            queries: {
                "openClawSettings.getConfiguration": dashboardStoryFailure(
                    codedError("FORBIDDEN")
                ),
                "openClawSettings.listSkills": dashboardStoryFailure(
                    codedError("FORBIDDEN")
                ),
            },
        }),
        route: "/settings",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(
            await canvas.findByRole("tab", { name: "OpenClaw settings" })
        );
        await expect(
            await canvas.findByText(/OpenClaw configuration is unavailable/iu)
        ).toBeVisible();
        await expect(canvas.getByText(/OpenClaw skills are unavailable/iu)).toBeVisible();
    },
};

export const MutationBusy: Story = {
    args: {
        fixtures: openClawFixtures({
            mutations: {
                "openClawSettings.updateConfiguration": dashboardStoryResolver(
                    () =>
                        new Promise<never>(() => {
                            // Intentionally pending to keep the production busy state visible.
                        })
                ),
            },
        }),
        route: "/settings",
    },
    play: async ({ canvasElement }) => {
        const canvas = await submitModelChange(canvasElement);
        const savingButtons = await canvas.findAllByRole("button", {
            name: "Saving…",
        });
        await expect(savingButtons.length).toBeGreaterThan(0);
        for (const button of savingButtons) {
            await expect(button).toBeDisabled();
            await expect(button).toHaveAttribute("aria-busy", "true");
        }
    },
};

export const MutationError: Story = {
    args: {
        fixtures: openClawFixtures({
            mutations: {
                "openClawSettings.updateConfiguration": dashboardStoryFailure(
                    codedError("SERVICE_UNAVAILABLE")
                ),
            },
        }),
        route: "/settings",
    },
    play: async ({ canvasElement }) => {
        const canvas = await submitModelChange(canvasElement);
        await expect(
            await canvas.findByText(/Dashboard is temporarily unavailable/iu)
        ).toBeVisible();
    },
};

export const RestartRecovery: Story = {
    args: {
        fixtures: openClawFixtures({
            mutations: {
                "openClawSettings.restartGateway": dashboardStoryFailure(
                    codedError("SERVICE_UNAVAILABLE", "operation_outcome_unknown")
                ),
            },
        }),
        route: "/settings",
    },
    play: async ({ canvasElement }) => {
        const canvas = await openOpenClawSettings(canvasElement);
        await userEvent.click(
            canvas.getByRole("button", { name: "Restart OpenClaw Gateway" })
        );
        const page = within(canvasElement.ownerDocument.body);
        await userEvent.click(
            await page.findByRole("button", { name: "Restart Gateway" })
        );
        await expect(
            await canvas.findByText(
                /could not confirm whether the Gateway restart completed/iu
            )
        ).toBeVisible();
        await expect(
            canvas.getByRole("button", { name: "Retry Gateway restart request" })
        ).toBeVisible();
    },
};
