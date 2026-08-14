import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

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
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { createDashboardRouter, type DashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { openClawGatewayRestartRecoveryStoragePrefix } from "./openClawSettingsOperations.ts";
import {
    openClawConfigurationQueryKey,
    openClawSkillsQueryKey,
} from "./openClawSettingsQueries.ts";

const { fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
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
const configurationRevisionHash = `${"R".repeat(42)}A`;
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
    modelNormalizationState: "clean" as const,
    revisionHash: configurationRevisionHash,
    security: {
        authProfileCount: 2,
        commandRestartEnabled: false,
        ownerAllowFromCount: 1,
        redactionMode: "strict",
    },
    sessionReset: {
        idleMinutes: 60,
        mode: "idle",
        state: "explicit-idle",
    },
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
} satisfies OpenClawConfigurationSnapshot);
const invalidEmptyConfiguration = Object.freeze({
    agentAccess: [],
    agentAccessTruncated: false,
    channels: [],
    channelsTruncated: false,
    hash: configurationHash,
    heartbeat: {},
    includesPresent: false,
    issueCount: 1,
    models: { fallbacks: [] },
    modelNormalizationState: "clean" as const,
    revisionHash: configurationRevisionHash,
    security: {
        authProfileCount: 0,
        commandRestartEnabled: true,
        ownerAllowFromCount: 0,
    },
    sessionReset: { state: "inherited-none" as const },
    tools: {
        agentToAgentEnabled: false,
        elevatedEnabled: true,
        execPolicy: { state: "inherited" as const },
        webFetchEnabled: true,
        webSearchEnabled: true,
    },
    valid: false,
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

function authenticatedStatusFor(
    userId: string,
    sessionId: string
): Extract<AuthStatus, { state: "authenticated" }> {
    return {
        ...authenticatedStatus,
        session: { ...authenticatedStatus.session, id: sessionId },
        user: { ...authenticatedStatus.user, id: userId },
    };
}

function successfulBackupResponse(body = '{"models":{}}'): Response {
    return new Response(body, {
        headers: {
            "content-disposition": 'attachment; filename="openclaw.json"',
            "content-length": String(new TextEncoder().encode(body).byteLength),
            "content-type": "application/json",
        },
        status: 200,
    });
}

function installBackupObjectUrlMocks() {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = mock((_backup: Blob) => "blob:openclaw-backup-test");
    const revokeObjectUrl = mock((_url: string) => {});
    Object.defineProperties(URL, {
        createObjectURL: { configurable: true, value: createObjectUrl },
        revokeObjectURL: { configurable: true, value: revokeObjectUrl },
    });
    return {
        createObjectUrl,
        restore() {
            if (createDescriptor === undefined) {
                Reflect.deleteProperty(URL, "createObjectURL");
            } else {
                Object.defineProperty(URL, "createObjectURL", createDescriptor);
            }
            if (revokeDescriptor === undefined) {
                Reflect.deleteProperty(URL, "revokeObjectURL");
            } else {
                Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
            }
        },
        revokeObjectUrl,
    };
}

class SettingsTransport implements DashboardTrpcTransport {
    readonly calls: TransportCall[] = [];
    authentication: AuthStatus = authenticatedStatus;
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
                return Promise.resolve({
                    sessions:
                        this.authentication.state === "authenticated"
                            ? [this.authentication.session]
                            : [],
                });
            }
            case "auth.status": {
                return Promise.resolve(this.authentication);
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
    readonly dispose: () => Promise<void>;
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
    const view = render(
        <DashboardBrowserApplication
            collections={collections}
            queryClient={queryClient}
            realtimeClient={noOpDashboardRealtimeClient}
            router={router}
            trpcClient={trpcClient}
            webAuthnClient={unexpectedWebAuthnClient}
        />
    );
    mountedViews.push(view);
    return {
        async dispose() {
            await act(async () => {
                view.unmount();
                await collections.cleanup();
                queryClient.clear();
            });
            const viewIndex = mountedViews.indexOf(view);
            if (viewIndex !== -1) mountedViews.splice(viewIndex, 1);
            const collectionsIndex = collectionRegistries.indexOf(collections);
            if (collectionsIndex !== -1) {
                collectionRegistries.splice(collectionsIndex, 1);
            }
            const queryClientIndex = queryClients.indexOf(queryClient);
            if (queryClientIndex !== -1) queryClients.splice(queryClientIndex, 1);
        },
        queryClient,
        router,
    };
}

function expectConfigurationControlsDisabled(): void {
    const configurationRegion = screen.getByRole("region", {
        name: "OpenClaw configuration",
    });
    const controls = [
        ...within(configurationRegion).queryAllByRole("button"),
        ...within(configurationRegion).queryAllByRole("combobox"),
        ...within(configurationRegion).queryAllByRole("spinbutton"),
        ...within(configurationRegion).queryAllByRole("switch"),
        ...within(configurationRegion).queryAllByRole("textbox"),
    ];

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toBeDisabled();
}

afterEach(async () => {
    await act(async () => {
        for (const view of mountedViews.splice(0)) view.unmount();
        await Promise.all(
            collectionRegistries.splice(0).map((collections) => collections.cleanup())
        );
        for (const queryClient of queryClients.splice(0)) queryClient.clear();
    });
    for (let index = globalThis.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = globalThis.sessionStorage.key(index);
        if (key?.startsWith(openClawGatewayRestartRecoveryStoragePrefix)) {
            globalThis.sessionStorage.removeItem(key);
        }
    }
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
        const navigation = screen.getByRole("navigation", {
            name: "Main navigation",
        });
        expect(
            within(navigation).queryByRole("link", { name: "Account security" })
        ).toBeNull();
        expect(within(navigation).getByRole("link", { name: "Settings" })).toBeTruthy();
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
        const { queryClient } = renderSettings(transport);
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
        expect(
            screen.getByRole("button", { name: "Download configuration backup" })
        ).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
        ).toBeEnabled();
        expect(
            screen.getByRole("button", { name: "Session visibility" })
        ).toHaveTextContent("Current agent");
        const lastTouchedAt = screen.getByText(
            formatDashboardDateTime(Date.parse(configuration.lastTouchedAt))
        );
        expect(lastTouchedAt.tagName).toBe("TIME");
        expect(lastTouchedAt).toHaveAttribute("dateTime", configuration.lastTouchedAt);

        const skillsRefreshSettled = Promise.withResolvers<void>();
        const unsubscribeSkillsRefresh = queryClient.getQueryCache().subscribe(() => {
            const skillsQueryCount = transport.calls.filter(
                ({ kind, path }) =>
                    kind === "query" && path === "openClawSettings.listSkills"
            ).length;
            if (
                skillsQueryCount === 2 &&
                queryClient.getQueryState(openClawSkillsQueryKey)?.fetchStatus === "idle"
            ) {
                skillsRefreshSettled.resolve();
            }
        });
        try {
            await user.clear(primaryModel);
            await user.type(primaryModel, "openai/gpt-5.6-terra");
            await user.click(screen.getByRole("button", { name: "Save model settings" }));

            expect(await screen.findByText("OpenClaw settings saved.")).toBeTruthy();
            const mutations = transport.calls.filter(({ kind }) => kind === "mutation");
            expect(mutations).toHaveLength(1);
            expect(mutations[0]).toMatchObject({
                input: {
                    baseHash: configurationHash,
                    baseRevisionHash: configurationRevisionHash,
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
            await act(() => skillsRefreshSettled.promise);
            expect(
                transport.calls.filter(
                    ({ kind, path }) =>
                        kind === "query" && path === "openClawSettings.listSkills"
                )
            ).toHaveLength(2);
            expect(
                screen.getByRole<HTMLInputElement>("textbox", {
                    name: "Primary model",
                }).value
            ).toBe("openai/gpt-5.6-terra");
        } finally {
            unsubscribeSkillsRefresh();
        }
    });

    test("keeps normalized heartbeat text changes as a semantic no-op", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            heartbeat: { everySeconds: 60, target: "operations" },
        };
        renderSettings(transport);
        const user = userEvent.setup();
        const interval = await screen.findByRole("spinbutton", {
            name: "Interval (seconds)",
        });
        const target = screen.getByRole("textbox", { name: "Target" });

        await user.clear(interval);
        await user.type(interval, "060");
        await user.type(target, "   ");

        expect(
            screen.getByRole("button", { name: "Save heartbeat settings" })
        ).toBeDisabled();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toHaveLength(0);
    });

    test("explains and hides inherited or legacy exec policy values", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            tools: {
                ...configuration.tools,
                execPolicy: { mode: "auto", state: "legacy-mode" },
            },
        };
        renderSettings(transport);

        expect(
            await screen.findByText(
                "Exec policy is locked because OpenClaw uses legacy mode “auto”. Unrelated tool changes preserve that mode."
            )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Exec approval policy" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Exec security mode" })).toBeNull();
    });

    test("edits only an explicit idle session-reset policy", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            sessionReset: {
                idleMinutes: 125,
                mode: "idle",
                state: "explicit-idle",
            },
        };
        renderSettings(transport);

        const idleMinutes = await screen.findByRole<HTMLInputElement>("spinbutton", {
            name: "Idle timeout (minutes)",
        });
        expect(idleMinutes).toBeEnabled();
        expect(idleMinutes.value).toBe("125");
        expect(screen.getByRole("button", { name: "Save session reset" })).toBeDisabled();
    });

    test("keeps a leading-zero session reset value as a semantic no-op", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            sessionReset: {
                idleMinutes: 125,
                mode: "idle",
                state: "explicit-idle",
            },
        };
        renderSettings(transport);
        const idleMinutes = await screen.findByRole<HTMLInputElement>("spinbutton", {
            name: "Idle timeout (minutes)",
        });

        fireEvent.change(idleMinutes, { target: { value: "0125" } });

        expect(idleMinutes.value).toBe("0125");
        expect(screen.getByRole("button", { name: "Save session reset" })).toBeDisabled();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toHaveLength(0);
    });

    for (const resetCase of [
        {
            message: "Session reset uses OpenClaw's inherited no-reset policy.",
            name: "inherited-none",
            sessionReset: { state: "inherited-none" },
        },
        {
            message:
                "Session reset is locked because the current OpenClaw object implicitly enables a daily reset.",
            name: "implicit-daily",
            sessionReset: { state: "implicit-daily" },
        },
        {
            message: "Session reset is locked in OpenClaw mode “daily”.",
            name: "locked-daily",
            sessionReset: { mode: "daily", state: "locked-mode" },
        },
        {
            message: "Session reset is locked in OpenClaw mode “none”.",
            name: "locked-none",
            sessionReset: { mode: "none", state: "locked-mode" },
        },
        {
            message:
                "Session reset is locked because the explicit idle policy has no editable bounded timeout.",
            name: "partial-idle",
            sessionReset: { state: "partial-idle" },
        },
    ] as const) {
        test(`renders the ${resetCase.name} session-reset state as read-only`, async () => {
            const transport = new SettingsTransport();
            transport.configuration = {
                ...configuration,
                sessionReset: resetCase.sessionReset,
            };
            renderSettings(transport);

            expect(await screen.findByText(resetCase.message)).toBeTruthy();
            expect(
                screen.queryByRole("spinbutton", {
                    name: "Idle timeout (minutes)",
                })
            ).toBeNull();
            expect(screen.getByRole("heading", { name: "Session reset" })).toBeTruthy();
        });
    }

    test("renders invalid and absent last-touched values without inventing a date", async () => {
        const invalidTransport = new SettingsTransport();
        invalidTransport.configuration = {
            ...configuration,
            lastTouchedAt: "not-a-timestamp",
        };
        renderSettings(invalidTransport);

        const invalidValue = await screen.findByText("not-a-timestamp");
        expect(invalidValue.closest("time")).toBeNull();

        const absentTransport = new SettingsTransport();
        absentTransport.configuration = {
            ...configuration,
            lastTouchedAt: undefined,
        };
        renderSettings(absentTransport);

        expect(await screen.findByText("Not reported")).toBeTruthy();
    });

    test("observes a one-shot backup GET before reporting a completed download", async () => {
        const transport = new SettingsTransport();
        const ticketId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.createConfigurationBackup") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            return Promise.resolve({
                downloadUrl: `/api/openclaw-settings/configuration-backups/${ticketId}`,
                expiresAtMs: Date.now() + 60_000,
                ticketId,
            });
        };
        const fetchBackup = spyOn(globalThis, "fetch").mockImplementation(() =>
            Promise.resolve(successfulBackupResponse())
        );
        const objectUrls = installBackupObjectUrlMocks();
        let activatedDownload:
            | { readonly download: string; readonly href: string }
            | undefined;
        const anchorClick = spyOn(
            HTMLAnchorElement.prototype,
            "click"
        ).mockImplementation(function (this: HTMLAnchorElement) {
            activatedDownload = { download: this.download, href: this.href };
        });
        try {
            const { queryClient } = renderSettings(transport);
            const user = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await user.click(
                screen.getByRole("button", {
                    name: "Download configuration backup",
                })
            );

            expect(
                await screen.findByText("OpenClaw configuration backup downloaded.")
            ).toBeTruthy();
            expect(fetchBackup).toHaveBeenCalledWith(
                `/api/openclaw-settings/configuration-backups/${ticketId}`,
                expect.objectContaining({
                    cache: "no-store",
                    credentials: "same-origin",
                    method: "GET",
                    signal: expect.any(AbortSignal),
                })
            );
            expect(anchorClick).toHaveBeenCalledTimes(1);
            expect(activatedDownload).toEqual({
                download: "openclaw.json",
                href: "blob:openclaw-backup-test",
            });
            expect(objectUrls.createObjectUrl).toHaveBeenCalledTimes(1);
            expect(objectUrls.revokeObjectUrl).toHaveBeenCalledWith(
                "blob:openclaw-backup-test"
            );
            expect(transport.calls.filter(({ kind }) => kind === "mutation")).toEqual([
                expect.objectContaining({
                    input: { confirmation: "export-openclaw-configuration" },
                    path: "openClawSettings.createConfigurationBackup",
                }),
            ]);
            expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(
                ticketId
            );
        } finally {
            anchorClick.mockRestore();
            fetchBackup.mockRestore();
            objectUrls.restore();
        }
    });

    for (const failure of [
        {
            message:
                "The configuration backup is no longer authorized for this session. Sign in or verify your identity again, then request a new backup.",
            status: 401,
        },
        {
            message:
                "The configuration backup ticket expired or was already used. Request a new backup.",
            status: 410,
        },
        {
            message:
                "The configuration backup is temporarily unavailable. Request a new backup and try again shortly.",
            status: 503,
        },
    ] as const) {
        test(`reports backup GET ${failure.status} without false download success`, async () => {
            const transport = new SettingsTransport();
            const ticketId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
            transport.mutationHandler = (path) => {
                if (path !== "openClawSettings.createConfigurationBackup") {
                    return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
                }
                return Promise.resolve({
                    downloadUrl: `/api/openclaw-settings/configuration-backups/${ticketId}`,
                    expiresAtMs: Date.now() + 60_000,
                    ticketId,
                });
            };
            const fetchBackup = spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(
                    new Response("private raw backup failure detail", {
                        status: failure.status,
                    })
                )
            );
            const anchorClick = spyOn(
                HTMLAnchorElement.prototype,
                "click"
            ).mockImplementation(() => {});
            try {
                renderSettings(transport);
                const user = userEvent.setup();
                await screen.findByRole("textbox", { name: "Primary model" });
                await user.click(
                    screen.getByRole("button", {
                        name: "Download configuration backup",
                    })
                );

                expect(await screen.findByText(failure.message)).toBeTruthy();
                expect(
                    screen.queryByText("OpenClaw configuration backup downloaded.")
                ).toBeNull();
                expect(
                    screen.queryByText(/private raw backup failure detail/iu)
                ).toBeNull();
                expect(anchorClick).not.toHaveBeenCalled();
            } finally {
                anchorClick.mockRestore();
                fetchBackup.mockRestore();
            }
        });
    }

    test("reuses the restart recovery key after a same-session reload and clears it on success", async () => {
        const transport = new SettingsTransport();
        let restartAttemptCount = 0;
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.restartGateway") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            restartAttemptCount += 1;
            return restartAttemptCount === 1
                ? Promise.reject(unknownOutcomeError())
                : Promise.resolve({
                      completedAtMs: Date.now(),
                      jobRunId: "019fe633-9133-7ba0-a5f9-809dd80dfb40",
                      status: "restarted",
                  });
        };
        const confirmRestart = spyOn(globalThis, "confirm").mockReturnValue(true);
        try {
            const firstView = renderSettings(transport);
            const user = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await user.click(
                screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
            );
            await screen.findByText(
                /could not confirm whether the Gateway restart completed/iu
            );
            const firstCall = transport.calls.find(
                ({ kind, path }) =>
                    kind === "mutation" && path === "openClawSettings.restartGateway"
            );
            expect(firstCall?.input).toMatchObject({
                confirmation: "restart-openclaw-gateway",
                idempotencyKey: expect.stringMatching(/^[0-9a-f]{32}$/u),
            });
            expect(
                screen.getByRole("link", { name: "Review Dashboard jobs" })
            ).toHaveAttribute("href", "/jobs");

            await firstView.dispose();
            renderSettings(transport);
            const reloadedUser = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await reloadedUser.click(
                await screen.findByRole("button", {
                    name: "Retry Gateway restart request",
                })
            );
            expect(
                await screen.findByText("OpenClaw Gateway restart completed.")
            ).toBeTruthy();
            await waitFor(() =>
                expect(
                    transport.calls.filter(
                        ({ kind, path }) =>
                            kind === "mutation" &&
                            path === "openClawSettings.restartGateway"
                    )
                ).toHaveLength(2)
            );
            const calls = transport.calls.filter(
                ({ kind, path }) =>
                    kind === "mutation" && path === "openClawSettings.restartGateway"
            );
            expect(calls[0]?.input).toMatchObject({
                confirmation: "restart-openclaw-gateway",
            });
            expect(calls[1]?.input).toEqual(calls[0]?.input);
            expect(
                screen.queryByRole("button", {
                    name: "Discard recovery key for new intent",
                })
            ).toBeNull();
            expect(
                screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
            ).toBeEnabled();
            expect(
                Array.from({ length: globalThis.sessionStorage.length }, (_, index) =>
                    globalThis.sessionStorage.key(index)
                ).filter((key) =>
                    key?.startsWith(openClawGatewayRestartRecoveryStoragePrefix)
                )
            ).toHaveLength(0);
            expect(confirmRestart).toHaveBeenCalledTimes(2);
        } finally {
            confirmRestart.mockRestore();
        }
    });

    test("preserves restart recovery when retry and discard confirmations are declined", async () => {
        const transport = new SettingsTransport();
        transport.mutationHandler = (path) =>
            path === "openClawSettings.restartGateway"
                ? Promise.reject(unknownOutcomeError())
                : Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
        const confirmRestart = spyOn(globalThis, "confirm").mockReturnValue(true);
        try {
            renderSettings(transport);
            const user = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await user.click(
                screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
            );
            await screen.findByText(
                /could not confirm whether the Gateway restart completed/iu
            );
            const restartCalls = () =>
                transport.calls.filter(
                    ({ kind, path }) =>
                        kind === "mutation" && path === "openClawSettings.restartGateway"
                );
            expect(restartCalls()).toHaveLength(1);
            const recoveryKey = Array.from(
                { length: globalThis.sessionStorage.length },
                (_, index) => globalThis.sessionStorage.key(index)
            ).find((key) => key?.startsWith(openClawGatewayRestartRecoveryStoragePrefix));
            if (recoveryKey === undefined || recoveryKey === null) {
                throw new Error("Gateway restart recovery key was not persisted");
            }
            const recoveryValue = globalThis.sessionStorage.getItem(recoveryKey);
            if (recoveryValue === null) {
                throw new Error("Gateway restart recovery value was not persisted");
            }
            expect(recoveryValue).toMatch(/^[0-9a-f]{32}$/u);

            confirmRestart.mockReturnValue(false);
            await user.click(
                screen.getByRole("button", {
                    name: "Retry Gateway restart request",
                })
            );
            expect(restartCalls()).toHaveLength(1);
            expect(globalThis.sessionStorage.getItem(recoveryKey)).toBe(recoveryValue);
            expect(
                screen.getByRole("button", {
                    name: "Retry Gateway restart request",
                })
            ).toBeEnabled();

            await user.click(
                screen.getByRole("button", {
                    name: "Discard recovery key for new intent",
                })
            );
            expect(restartCalls()).toHaveLength(1);
            expect(globalThis.sessionStorage.getItem(recoveryKey)).toBe(recoveryValue);
            expect(
                screen.getByRole("button", {
                    name: "Discard recovery key for new intent",
                })
            ).toBeEnabled();
            expect(
                screen.queryByText(/Previous Gateway restart recovery key discarded/iu)
            ).toBeNull();
            expect(confirmRestart).toHaveBeenCalledTimes(3);
        } finally {
            confirmRestart.mockRestore();
        }
    });

    test("isolates persisted restart recovery by exact authenticated identity", async () => {
        const firstTransport = new SettingsTransport();
        firstTransport.mutationHandler = () => Promise.reject(unknownOutcomeError());
        const confirmRestart = spyOn(globalThis, "confirm").mockReturnValue(true);
        try {
            const firstView = renderSettings(firstTransport);
            const user = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await user.click(
                await screen.findByRole("button", {
                    name: "Restart OpenClaw Gateway",
                })
            );
            await screen.findByText(
                /could not confirm whether the Gateway restart completed/iu
            );
            const firstInput = firstTransport.calls.find(
                ({ path }) => path === "openClawSettings.restartGateway"
            )?.input;

            await firstView.dispose();
            const secondTransport = new SettingsTransport();
            secondTransport.authentication = authenticatedStatusFor(
                "019fd974-54a2-74dd-a64b-d4186f8d8830",
                "b".repeat(32)
            );
            secondTransport.mutationHandler = () =>
                Promise.resolve({
                    completedAtMs: Date.now(),
                    jobRunId: "019fe633-9133-7ba0-a5f9-809dd80dfb41",
                    status: "restarted",
                });
            renderSettings(secondTransport);
            await screen.findByRole("textbox", { name: "Primary model" });
            const secondUser = userEvent.setup();
            expect(
                await screen.findByRole("button", {
                    name: "Restart OpenClaw Gateway",
                })
            ).toBeEnabled();
            expect(
                screen.queryByRole("button", {
                    name: "Retry Gateway restart request",
                })
            ).toBeNull();
            await secondUser.click(
                screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
            );
            await screen.findByText("OpenClaw Gateway restart completed.");
            const secondInput = secondTransport.calls.find(
                ({ path }) => path === "openClawSettings.restartGateway"
            )?.input;
            expect(secondInput).not.toEqual(firstInput);
            expect(
                Array.from({ length: globalThis.sessionStorage.length }, (_, index) =>
                    globalThis.sessionStorage.key(index)
                ).filter((key) =>
                    key?.startsWith(openClawGatewayRestartRecoveryStoragePrefix)
                )
            ).toHaveLength(1);
        } finally {
            confirmRestart.mockRestore();
        }
    });

    test("requires an explicit warned reset before creating a new restart intent", async () => {
        const transport = new SettingsTransport();
        let restartAttemptCount = 0;
        transport.mutationHandler = () => {
            restartAttemptCount += 1;
            return restartAttemptCount === 1
                ? Promise.reject(unknownOutcomeError())
                : Promise.resolve({
                      completedAtMs: Date.now(),
                      jobRunId: "019fe633-9133-7ba0-a5f9-809dd80dfb42",
                      status: "restarted",
                  });
        };
        const confirmRestart = spyOn(globalThis, "confirm").mockReturnValue(true);
        try {
            renderSettings(transport);
            const user = userEvent.setup();
            await screen.findByRole("textbox", { name: "Primary model" });
            await user.click(
                await screen.findByRole("button", {
                    name: "Restart OpenClaw Gateway",
                })
            );
            await screen.findByText(
                /could not confirm whether the Gateway restart completed/iu
            );
            expect(
                screen.getByText(/configuration refresh does not prove restart status/iu)
            ).toBeTruthy();
            expect(
                screen.getByRole("link", { name: "Review Dashboard jobs" })
            ).toHaveAttribute("href", "/jobs");

            await user.click(
                screen.getByRole("button", {
                    name: "Discard recovery key for new intent",
                })
            );
            expect(
                await screen.findByText(
                    /Previous Gateway restart recovery key discarded/iu
                )
            ).toBeTruthy();
            expect(
                screen.queryByRole("button", {
                    name: "Retry Gateway restart request",
                })
            ).toBeNull();

            const newIntentUser = userEvent.setup();
            await newIntentUser.click(
                screen.getByRole("button", { name: "Restart OpenClaw Gateway" })
            );
            await waitFor(() =>
                expect(
                    transport.calls.filter(
                        ({ path }) => path === "openClawSettings.restartGateway"
                    )
                ).toHaveLength(2)
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", {
                        name: "Restart OpenClaw Gateway",
                    })
                ).toBeEnabled()
            );
            const restartInputs = transport.calls
                .filter(({ path }) => path === "openClawSettings.restartGateway")
                .map(({ input }) => input);
            expect(restartInputs[1]).not.toEqual(restartInputs[0]);
            expect(confirmRestart).toHaveBeenNthCalledWith(
                2,
                expect.stringMatching(/second time[\s\S]*Review Dashboard jobs/iu)
            );
        } finally {
            confirmRestart.mockRestore();
        }
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
                baseRevisionHash: configurationRevisionHash,
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

    test("resets section drafts on a same-root revision remount while preserving the selected agent", async () => {
        const transport = new SettingsTransport();
        const canonicalTools = configuration.agentAccess[0]!.tools;
        transport.configuration = {
            ...configuration,
            agentAccess: [
                {
                    id: "alpha",
                    name: "Alpha worker",
                    tools: canonicalTools.map((tool) => ({ ...tool })),
                },
                {
                    id: "beta",
                    name: "Beta worker",
                    tools: canonicalTools.map((tool) => ({ ...tool })),
                },
            ],
        };
        const { queryClient } = renderSettings(transport);
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Selected OpenClaw agent" })
        );
        await user.click(screen.getByRole("option", { name: "Beta worker (beta)" }));
        const heartbeatTarget = screen.getByRole<HTMLInputElement>("textbox", {
            name: "Target",
        });
        await user.clear(heartbeatTarget);
        await user.type(heartbeatTarget, "stale-local-draft");
        expect(heartbeatTarget.value).toBe("stale-local-draft");

        transport.configuration = {
            ...transport.configuration,
            heartbeat: {
                ...transport.configuration.heartbeat,
                target: "fresh-server-target",
            },
            revisionHash: `${"S".repeat(42)}E`,
        };
        await act(async () => {
            await queryClient.refetchQueries({
                exact: true,
                queryKey: openClawConfigurationQueryKey,
            });
        });

        await waitFor(() =>
            expect(
                screen.getByRole<HTMLInputElement>("textbox", { name: "Target" }).value
            ).toBe("fresh-server-target")
        );
        expect(transport.configuration.hash).toBe(configurationHash);
        expect(
            screen.getByRole("button", { name: "Selected OpenClaw agent" })
        ).toHaveTextContent("Beta worker (beta)");
        expect(
            screen.getByRole("button", {
                name: "Exec override for Beta worker (beta)",
            })
        ).toHaveTextContent("Allow");
    });

    test("locks configuration includes while leaving leaf-only skill controls available", async () => {
        const transport = new SettingsTransport();
        transport.configuration = {
            ...configuration,
            includesPresent: true,
        };
        renderSettings(transport);

        expect(
            await screen.findByText(
                "Configuration changes are locked because this OpenClaw configuration uses included files. Edit the owning source in OpenClaw so an included value cannot change between review and persistence."
            )
        ).toBeTruthy();
        expectConfigurationControlsDisabled();
        expect(
            screen.getByRole("switch", { name: "Enable Disabled skill" })
        ).toBeEnabled();
    });

    for (const normalizationCase of [
        {
            message:
                "Configuration changes are locked because OpenClaw would canonicalize existing model references outside the requested setting. Save those references canonically in OpenClaw before editing here.",
            state: "pending",
        },
        {
            message:
                "Configuration changes are locked because the existing model-reference normalization state could not be verified safely. Review and save the configuration in OpenClaw before editing here.",
            state: "unknown",
        },
    ] as const) {
        test(`locks configuration for ${normalizationCase.state} model normalization while retaining reads and skills`, async () => {
            const transport = new SettingsTransport();
            transport.configuration = {
                ...configuration,
                modelNormalizationState: normalizationCase.state,
            };
            renderSettings(transport);

            expect(await screen.findByText(normalizationCase.message)).toBeTruthy();
            expectConfigurationControlsDisabled();
            expect(
                screen.getByRole<HTMLInputElement>("textbox", {
                    name: "Primary model",
                }).value
            ).toBe(configuration.models.primary);
            expect(screen.getByText(configuration.lastTouchedVersion)).toBeTruthy();
            expect(
                screen.getByRole("switch", { name: "Enable Disabled skill" })
            ).toBeEnabled();
        });
    }

    test("hides the default-looking projection produced by an invalid empty provider config", async () => {
        const transport = new SettingsTransport();
        transport.configuration = invalidEmptyConfiguration;
        renderSettings(transport);

        expect(
            await screen.findByText(
                "OpenClaw reports invalid configuration. Reviewed values stay hidden because the redacted snapshot cannot be treated as effective state. Repair the configuration in OpenClaw, then refresh this page."
            )
        ).toBeTruthy();
        const configurationRegion = screen.getByRole("region", {
            name: "OpenClaw configuration",
        });
        for (const role of [
            "button",
            "combobox",
            "spinbutton",
            "switch",
            "textbox",
        ] as const) {
            expect(within(configurationRegion).queryAllByRole(role)).toHaveLength(0);
        }
        for (const heading of [
            "Configuration status",
            "Models",
            "Channels",
            "Tools",
            "Security summary",
            "Session reset",
            "Heartbeat",
            "Agent access",
        ]) {
            expect(screen.queryByRole("heading", { name: heading })).toBeNull();
        }
        expect(
            screen.queryByText(/Saving a reviewed setting makes OpenClaw rewrite/iu)
        ).toBeNull();
        expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
        expect(
            screen.getByRole("switch", { name: "Enable Search first" })
        ).toBeDisabled();
    });

    test("allows an ineligible disabled skill to be enabled", async () => {
        const transport = new SettingsTransport();
        let finishMutation: ((result: unknown) => void) | undefined;
        transport.mutationHandler = (path) => {
            if (path !== "openClawSettings.setSkillEnabled") {
                return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
            }
            return new Promise((resolve) => {
                finishMutation = (result) => {
                    transport.skills = {
                        ...skills,
                        skills: skills.skills.map((skill) =>
                            skill.key === "disabled-skill"
                                ? { ...skill, enabled: true }
                                : skill
                        ),
                    };
                    resolve(result);
                };
            });
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

        await waitFor(() =>
            expect(
                transport.calls.filter(({ kind }) => kind === "mutation")
            ).toHaveLength(1)
        );
        expect(toggle).toBeDisabled();
        const skillsRegion = screen.getByRole("region", { name: "Skills" });
        expect(skillsRegion).toHaveAttribute("aria-busy", "true");
        expect(skillsRegion.querySelector("output")).toHaveTextContent("Saving skill…");
        act(() => {
            finishMutation?.({ enabled: true, skillKey: "disabled-skill" });
        });

        expect(
            await screen.findByText(
                "Skill setting saved and confirmed against current OpenClaw state."
            )
        ).toBeTruthy();
        expect(transport.calls.filter(({ kind }) => kind === "mutation")).toEqual([
            expect.objectContaining({
                input: {
                    baseHash: configurationHash,
                    baseRevisionHash: configurationRevisionHash,
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
        renderSettings(transport);

        expect(
            await screen.findByText(/OpenClaw configuration is unavailable/iu)
        ).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
        expect(
            screen.getByRole("switch", { name: "Enable Search first" })
        ).toBeDisabled();
        expect(screen.queryByText(/private upstream query detail/iu)).toBeNull();
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
    });

    test("locks only stale skill controls after an independent refresh failure", async () => {
        const transport = new SettingsTransport();
        const { queryClient } = renderSettings(transport);
        expect(
            await screen.findByRole("switch", { name: "Enable Disabled skill" })
        ).toBeEnabled();
        transport.skillsError = privateForbiddenError();
        await act(async () => {
            await queryClient.refetchQueries({
                exact: true,
                queryKey: openClawSkillsQueryKey,
            });
        });

        expect(
            await screen.findByText(/Current OpenClaw skills could not be refreshed/iu)
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
