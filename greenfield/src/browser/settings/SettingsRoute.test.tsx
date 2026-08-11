import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import type { TRPCRequestOptions } from "@trpc/client";
import { act } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationSnapshot,
} from "../../contracts/openClawSettings.ts";
import { openClawReviewedAgentToolIds } from "../../contracts/openClawSettings.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { createDashboardRouter, type DashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import {
    openClawConfigurationQueryKey,
    openClawSkillsQueryKey,
} from "./openClawSettingsQueries.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = Date.now();
const authenticatedStatus = Object.freeze({
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password",
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
        userAgent: "Settings browser test",
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
} satisfies AuthStatus);
const accountSecuritySummary = Object.freeze({
    checkedAtMs: timestampMs,
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
            expiresAtMs: timestampMs + 300_000,
            recent: true,
            remainingMs: 300_000,
            verifiedAtMs: timestampMs,
        },
    },
    webAuthn: { available: true, rpId: "dashboard.test" },
} satisfies AccountSecuritySummary);
const configurationHash = "b".repeat(64);
const configuration = Object.freeze({
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
    hash: configurationHash,
    heartbeat: { everySeconds: 3600, target: "operations" },
    issueCount: 0,
    lastTouchedAt: "2026-08-11T12:00:00.000Z",
    lastTouchedVersion: "2026.8.11",
    models: {
        fallbacks: ["openai/gpt-5.6-terra"],
        primary: "openai/gpt-5.6-sol",
    },
    security: {
        authProfileCount: 2,
        commandRestartEnabled: false,
        ownerAllowFromCount: 1,
        redactionMode: "strict",
    },
    sessionReset: { idleMinutes: 60 },
    tools: {
        agentToAgentEnabled: true,
        elevatedEnabled: false,
        execAsk: "on-miss",
        execSecurity: "allowlist",
        profile: "coding",
        sessionsVisibility: "agent",
        webFetchEnabled: true,
        webSearchEnabled: true,
        webSearchProvider: "brave",
    },
    valid: true,
} satisfies OpenClawConfigurationSnapshot);
const skills = Object.freeze({
    skills: [
        {
            bundled: false,
            description: "Can be enabled even when its disabled state is ineligible.",
            eligible: false,
            enabled: false,
            installed: true,
            key: "disabled-skill",
            name: "Disabled skill",
            source: "openclaw-managed",
        },
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
    ],
    truncated: false,
} satisfies ListOpenClawSkillsResult);
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
    readonly signal: AbortSignal | undefined;
}

function privateForbiddenError(): Error {
    return Object.assign(new Error("private upstream query detail"), {
        data: { code: "FORBIDDEN" },
    });
}

function unknownOutcomeError(): Error {
    return Object.assign(new Error("private lost acknowledgement detail"), {
        data: {
            code: "SERVICE_UNAVAILABLE",
            reason: "operation_outcome_unknown",
        },
    });
}

class SettingsTransport implements DashboardTrpcTransport {
    readonly calls: TransportCall[] = [];
    configuration: OpenClawConfigurationSnapshot = configuration;
    configurationError: Error | undefined;
    mutationHandler: (
        path: string,
        input: unknown,
        options?: TRPCRequestOptions
    ) => Promise<unknown> = (path) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    skills: ListOpenClawSkillsResult = skills;
    skillsError: Error | undefined;

    mutation(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path, signal: options?.signal });
        return this.mutationHandler(path, input, options);
    }

    query(path: string, input?: unknown, options?: TRPCRequestOptions): Promise<unknown> {
        this.calls.push({ input, kind: "query", path, signal: options?.signal });
        switch (path) {
            case "accountSecurity.summary": {
                return Promise.resolve(accountSecuritySummary);
            }
            case "auth.sessions": {
                return Promise.resolve({ sessions: [authenticatedStatus.session] });
            }
            case "auth.status": {
                return Promise.resolve(authenticatedStatus);
            }
            case "automationSecurity.listPrincipals": {
                return Promise.resolve({
                    activePrincipalCount: 0,
                    principals: [],
                    totalPrincipalCount: 0,
                });
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "openClawSettings.getConfiguration": {
                return this.configurationError === undefined
                    ? Promise.resolve(this.configuration)
                    : Promise.reject(this.configurationError);
            }
            case "openClawSettings.listSkills": {
                return this.skillsError === undefined
                    ? Promise.resolve(this.skills)
                    : Promise.reject(this.skillsError);
            }
            case "securityAudit.listEvents": {
                return Promise.resolve({ events: [] });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

function renderSettings(
    transport: SettingsTransport,
    initialEntry = "/settings?view=openclaw"
): {
    readonly queryClient: ReturnType<typeof createDashboardQueryClient>;
    readonly router: DashboardRouter;
} {
    const queryClient = createDashboardQueryClient();
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: [initialEntry] })
    );
    const trpcClient = createDashboardTrpcClient(transport);
    const collections = createDashboardBrowserCollections(queryClient, trpcClient);
    queryClients.push(queryClient);
    collectionRegistries.push(collections);
    mountedViews.push(
        render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={router}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        )
    );
    return { queryClient, router };
}

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard Settings route", () => {
    test("selects the exact URL-backed OpenClaw tab", async () => {
        const transport = new SettingsTransport();
        const { router } = renderSettings(transport);

        expect(
            await screen.findByRole("textbox", { name: "Primary model" })
        ).toBeEnabled();
        expect(
            screen.getByRole("heading", {
                level: 1,
                name: "OpenClaw settings",
            })
        ).toBeTruthy();
        expect(screen.getByRole("tab", { name: "OpenClaw settings" })).toHaveAttribute(
            "aria-selected",
            "true"
        );
        expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
        expect(
            await screen.findByRole("button", {
                name: "Notifications, none unread",
            })
        ).toBeTruthy();
        expect(router.state.location.pathname).toBe("/settings");
        expect(router.state.location.search).toEqual({ view: "openclaw" });
    });

    test("preserves account security as the Dashboard settings panel", async () => {
        const transport = new SettingsTransport();
        const { router } = renderSettings(transport, "/settings?view=dashboard");

        expect(await screen.findByText("Settings browser test")).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "No automation accounts",
            })
        ).toBeTruthy();
        expect(
            await screen.findByRole("heading", {
                level: 2,
                name: "No security events",
            })
        ).toBeTruthy();
        expect(
            screen.getByRole("heading", {
                level: 1,
                name: "Account security",
            })
        ).toBeTruthy();
        expect(router.state.location.pathname).toBe("/settings");
        expect(router.state.location.search).toEqual({ view: "dashboard" });
        expect(screen.getByRole("tab", { name: "Dashboard settings" })).toHaveAttribute(
            "aria-selected",
            "true"
        );
    });

    test("renders only bounded fields and submits one exact hash-fenced section", async () => {
        const transport = new SettingsTransport();
        const updatedConfiguration: OpenClawConfigurationSnapshot = {
            ...configuration,
            hash: "c".repeat(64),
            models: { ...configuration.models, primary: "openai/gpt-5.6-terra" },
        };
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.updateConfiguration") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            transport.configuration = updatedConfiguration;
            return Promise.resolve({
                changed: true,
                configuration: updatedConfiguration,
                restartRequired: false,
                restartScheduled: false,
            });
        };
        renderSettings(transport);
        const user = userEvent.setup();
        const primaryModel = await screen.findByRole("textbox", {
            name: "Primary model",
        });

        for (const section of [
            "Models",
            "Channels",
            "Tools",
            "Security summary",
            "Session reset",
            "Heartbeat",
            "Agent access",
            "Skills",
        ]) {
            expect(screen.getByRole("heading", { name: section })).toBeTruthy();
        }
        expect(screen.queryByRole("textbox", { name: /json/iu })).toBeNull();
        expect(screen.queryByRole("button", { name: /backup|restart/iu })).toBeNull();
        expect(
            screen.getByRole("button", { name: "Session visibility" })
        ).toHaveTextContent("Current agent");

        await user.clear(primaryModel);
        await user.type(primaryModel, "openai/gpt-5.6-terra");
        await user.click(screen.getByRole("button", { name: "Save model settings" }));

        expect(await screen.findByText("OpenClaw settings saved.")).toBeTruthy();
        const mutations = transport.calls.filter(({ kind }) => kind === "mutation");
        expect(mutations).toHaveLength(1);
        expect(mutations[0]).toMatchObject({
            input: {
                baseHash: configurationHash,
                confirmation: "apply-reviewed-settings",
                update: {
                    fallbacks: ["openai/gpt-5.6-terra"],
                    primary: "openai/gpt-5.6-terra",
                    section: "models",
                },
            },
            path: "openClawSettings.updateConfiguration",
        });
        expect(mutations[0]?.signal).toBeInstanceOf(AbortSignal);
        await waitFor(() =>
            expect(
                transport.calls.filter(
                    ({ kind, path }) =>
                        kind === "query" && path === "openClawSettings.listSkills"
                )
            ).toHaveLength(2)
        );
        expect(
            screen.getByRole<HTMLInputElement>("textbox", {
                name: "Primary model",
            }).value
        ).toBe("openai/gpt-5.6-terra");
    });

    test("submits one exact agent tool override intent without browser policy arrays", async () => {
        const transport = new SettingsTransport();
        let finishMutation: ((result: unknown) => void) | undefined;
        const updatedConfiguration: OpenClawConfigurationSnapshot = {
            ...configuration,
            agentAccess: configuration.agentAccess.map((agent) => ({
                ...agent,
                tools: agent.tools.map((tool) =>
                    tool.id === "exec" ? { ...tool, override: "deny" } : tool
                ),
            })),
            hash: "d".repeat(64),
        };
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.updateConfiguration") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            return new Promise((resolve) => {
                finishMutation = (result) => {
                    transport.configuration = updatedConfiguration;
                    resolve(result);
                };
            });
        };
        renderSettings(transport);
        const user = userEvent.setup();
        const override = await screen.findByRole("button", {
            name: "Exec override for Main (main)",
        });

        expect(override).toHaveTextContent("Allow");
        await user.click(override);
        await user.click(screen.getByRole("option", { name: /^Deny/iu }));

        await waitFor(() =>
            expect(
                transport.calls.filter(({ kind }) => kind === "mutation")
            ).toHaveLength(1)
        );
        expect(override).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Selected OpenClaw agent" })
        ).toBeDisabled();
        const agentAccessRegion = screen.getByRole("region", {
            name: "Agent access",
        });
        expect(agentAccessRegion).toHaveAttribute("aria-busy", "true");
        expect(agentAccessRegion.querySelector("output")).toHaveTextContent(
            "Saving override…"
        );
        const mutation = transport.calls.find(({ kind }) => kind === "mutation");
        expect(mutation).toMatchObject({
            input: {
                baseHash: configurationHash,
                confirmation: "apply-reviewed-settings",
                update: {
                    agentId: "main",
                    override: "deny",
                    section: "agent-tool-access",
                    toolId: "exec",
                },
            },
            path: "openClawSettings.updateConfiguration",
        });
        expect(JSON.stringify(mutation?.input)).not.toMatch(
            /"(?:allow|alsoAllow|deny)"\s*:/u
        );
        expect(JSON.stringify(mutation?.input)).not.toContain('"agents"');
        act(() => {
            finishMutation?.({
                changed: true,
                configuration: updatedConfiguration,
                restartRequired: false,
                restartScheduled: false,
            });
        });
        expect(await screen.findByText("OpenClaw settings saved.")).toBeTruthy();
        expect(
            await screen.findByRole("button", {
                name: "Exec override for Main (main)",
            })
        ).toHaveTextContent("Deny");
        expect(screen.getByRole("region", { name: "Agent access" })).not.toHaveAttribute(
            "aria-busy"
        );
    });

    test("keeps truncated duplicate-name agents distinguishable without caching raw policy arrays", async () => {
        const transport = new SettingsTransport();
        const canonicalTools = configuration.agentAccess[0]!.tools;
        transport.configuration = {
            ...configuration,
            agentAccess: [
                {
                    id: "alpha",
                    name: "Worker",
                    tools: canonicalTools.map((tool) => ({ ...tool })),
                },
                {
                    id: "beta",
                    name: "Worker",
                    tools: canonicalTools.map((tool) => ({ ...tool })),
                },
            ],
            agentAccessTruncated: true,
        };
        const { queryClient } = renderSettings(transport);
        const user = userEvent.setup();

        expect(
            await screen.findByText(/Some OpenClaw agent entries could not enter/iu)
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Selected OpenClaw agent" })
        ).toHaveTextContent("Worker (alpha)");
        expect(
            screen.getAllByRole("button", {
                name: / override for Worker \(alpha\)$/u,
            })
        ).toHaveLength(openClawReviewedAgentToolIds.length);
        expect(screen.getByText(/including restart-capable operations/iu)).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Gateway override for Worker (alpha)",
            })
        ).toBeDisabled();
        expect(
            JSON.stringify(queryClient.getQueryData(openClawConfigurationQueryKey))
        ).not.toMatch(/"(?:allow|alsoAllow|deny)"\s*:/u);

        await user.click(screen.getByRole("button", { name: "Selected OpenClaw agent" }));
        await user.click(screen.getByRole("option", { name: "Worker (beta)" }));

        expect(
            screen.getByRole("button", { name: "Selected OpenClaw agent" })
        ).toHaveTextContent("Worker (beta)");
        expect(
            screen.getByRole("button", {
                name: "Exec override for Worker (beta)",
            })
        ).toHaveTextContent("Allow");
    });

    test("locks every control and explains an invalid configuration", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            issueCount: 2,
            valid: false,
        };
        renderSettings(transport);

        expect(
            await screen.findByText(/OpenClaw reports invalid configuration/iu)
        ).toBeTruthy();
        const controls = [
            ...screen.getAllByRole("textbox"),
            ...screen.getAllByRole("spinbutton"),
            ...screen.getAllByRole("switch"),
            ...screen.queryAllByRole("combobox"),
        ];
        expect(controls.length).toBeGreaterThan(0);
        expect(controls.every((control) => control.hasAttribute("disabled"))).toBeTrue();
        expect(
            screen
                .getAllByRole("button", { name: /^Save /u })
                .every((button) => button.hasAttribute("disabled"))
        ).toBeTrue();
        expect(
            screen.getByRole("button", { name: "Exec override for Main (main)" })
        ).toBeDisabled();
    });

    test("allows an ineligible disabled skill to be enabled", async () => {
        const transport = new SettingsTransport();
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.setSkillEnabled") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            transport.skills = {
                ...skills,
                skills: skills.skills.map((skill) =>
                    skill.key === "disabled-skill" ? { ...skill, enabled: true } : skill
                ),
            };
            return Promise.resolve({ enabled: true, skillKey: "disabled-skill" });
        };
        renderSettings(transport);
        const user = userEvent.setup();
        const toggle = await screen.findByRole("switch", {
            name: "Enable Disabled skill",
        });

        expect(toggle).toBeEnabled();
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(screen.getByText("Unavailable")).toBeTruthy();
        await user.click(toggle);

        expect(
            await screen.findByText(
                "Skill setting saved and confirmed against current OpenClaw state."
            )
        ).toBeTruthy();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toEqual([
            expect.objectContaining({
                input: {
                    baseHash: configurationHash,
                    enabled: true,
                    skillKey: "disabled-skill",
                },
                path: "openClawSettings.setSkillEnabled",
            }),
        ]);
        expect(
            screen.getByRole("switch", { name: "Enable Disabled skill" })
        ).toHaveAttribute("aria-checked", "true");
    });

    test("renders a fresh independent skill result but locks it without configuration", async () => {
        const transport = new SettingsTransport();
        transport.configurationError = privateForbiddenError();
        const consoleError = spyOn(console, "error").mockImplementation(() => {});
        try {
            renderSettings(transport);

            expect(
                await screen.findByText(/OpenClaw configuration is unavailable/iu)
            ).toBeTruthy();
            expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
            expect(
                screen.getByRole("switch", { name: "Enable Search first" })
            ).toBeDisabled();
            expect(screen.queryByText(/private upstream query detail/iu)).toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });

    test("locks stale controls after a partial refresh failure", async () => {
        const transport = new SettingsTransport();
        const { queryClient } = renderSettings(transport);
        expect(
            await screen.findByRole("textbox", { name: "Primary model" })
        ).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Exec override for Main (main)" })
        ).toBeEnabled();
        transport.configurationError = privateForbiddenError();
        const consoleError = spyOn(console, "error").mockImplementation(() => {});
        try {
            await act(async () => {
                await queryClient.refetchQueries({
                    exact: true,
                    queryKey: openClawConfigurationQueryKey,
                });
            });

            expect(
                await screen.findByText(
                    /Current OpenClaw configuration could not be refreshed/iu
                )
            ).toBeTruthy();
            expect(screen.getByRole("textbox", { name: "Primary model" })).toBeDisabled();
            expect(
                screen.getByRole("switch", { name: "Enable Search first" })
            ).toBeDisabled();
            expect(
                screen.getByRole("button", {
                    name: "Exec override for Main (main)",
                })
            ).toBeDisabled();
        } finally {
            consoleError.mockRestore();
        }
    });

    test("locks only stale skill controls after an independent refresh failure", async () => {
        const transport = new SettingsTransport();
        const { queryClient } = renderSettings(transport);
        expect(
            await screen.findByRole("switch", { name: "Enable Disabled skill" })
        ).toBeEnabled();
        transport.skillsError = privateForbiddenError();
        const consoleError = spyOn(console, "error").mockImplementation(() => {});
        try {
            await act(async () => {
                await queryClient.refetchQueries({
                    exact: true,
                    queryKey: openClawSkillsQueryKey,
                });
            });

            expect(
                await screen.findByText(
                    /Current OpenClaw skills could not be refreshed/iu
                )
            ).toBeTruthy();
            expect(
                screen.getByRole("switch", { name: "Enable Disabled skill" })
            ).toBeDisabled();
            expect(screen.getByRole("textbox", { name: "Primary model" })).toBeEnabled();
            expect(
                screen.getByRole("button", {
                    name: "Exec override for Main (main)",
                })
            ).toBeEnabled();
        } finally {
            consoleError.mockRestore();
        }
    });

    test("never retries an unknown mutation outcome and unlocks only after reconciliation", async () => {
        const transport = new SettingsTransport();
        transport.mutationHandler = () => Promise.reject(unknownOutcomeError());
        renderSettings(transport);
        const user = userEvent.setup();
        const primaryModel = await screen.findByRole("textbox", {
            name: "Primary model",
        });
        await user.clear(primaryModel);
        await user.type(primaryModel, "openai/gpt-5.6-terra");
        await user.click(screen.getByRole("button", { name: "Save model settings" }));

        expect(
            await screen.findByText(
                /could not confirm whether OpenClaw applied the change/iu
            )
        ).toBeTruthy();
        expect(screen.queryByText(/private lost acknowledgement detail/iu)).toBeNull();
        expect(screen.getByRole("textbox", { name: "Primary model" })).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Exec override for Main (main)" })
        ).toBeDisabled();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toHaveLength(1);

        await user.click(
            screen.getByRole("button", {
                name: "Refresh current OpenClaw status",
            })
        );
        expect(
            await screen.findByText(/Current OpenClaw state refreshed/iu)
        ).toBeTruthy();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toHaveLength(1);
        expect(screen.getByRole("textbox", { name: "Primary model" })).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Exec override for Main (main)" })
        ).toBeEnabled();
    });
});
