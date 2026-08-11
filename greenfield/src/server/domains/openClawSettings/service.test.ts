import { describe, expect, test } from "bun:test";

import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationSnapshot,
    UpdateOpenClawConfigurationResult,
} from "../../../contracts/openClawSettings.ts";
import {
    openClawSettingsAuditTargetFingerprint,
    type OpenClawSettingsOperationAuditInput,
} from "./operationAudit.ts";
import {
    OpenClawSettingsProviderError,
    type OpenClawSettingsProvider,
} from "./provider.ts";
import {
    createOpenClawSettingsService,
    OpenClawSettingsServiceError,
} from "./service.ts";

const configuration = Object.freeze({
    agentAccess: [],
    agentAccessTruncated: false,
    channels: [{ enabled: true, id: "discord" }],
    hash: "a".repeat(64),
    heartbeat: { everySeconds: 3600, target: "last" },
    issueCount: 0,
    models: { fallbacks: ["openai/gpt-5.6-sol"], primary: "openai/gpt-5.6" },
    security: {
        authProfileCount: 2,
        commandRestartEnabled: false,
        ownerAllowFromCount: 1,
        redactionMode: "tools",
    },
    sessionReset: { idleMinutes: 60 },
    tools: {
        agentToAgentEnabled: false,
        elevatedEnabled: false,
        execAsk: "always",
        execSecurity: "deny",
        profile: "coding",
        sessionsVisibility: "tree",
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
            description: "Reviewed skill",
            eligible: true,
            enabled: true,
            installed: true,
            key: "reviewed-skill",
            name: "Reviewed skill",
            source: "openclaw-workspace",
        },
    ],
    truncated: false,
} satisfies ListOpenClawSkillsResult);

const updateResult = Object.freeze({
    changed: true,
    configuration,
    restartRequired: false,
    restartScheduled: false,
} satisfies UpdateOpenClawConfigurationResult);

function provider(
    overrides: Partial<OpenClawSettingsProvider> = {}
): OpenClawSettingsProvider {
    return Object.freeze({
        getConfiguration:
            overrides.getConfiguration ?? (() => Promise.resolve(configuration)),
        listSkills: overrides.listSkills ?? (() => Promise.resolve(skills)),
        setSkillEnabled:
            overrides.setSkillEnabled ??
            (async ({ authorizeDispatch, enabled, skillKey }) => {
                await authorizeDispatch();
                return { enabled, skillKey };
            }),
        updateConfiguration:
            overrides.updateConfiguration ??
            (async ({ authorizeDispatch }) => {
                await authorizeDispatch();
                return updateResult;
            }),
    });
}

const controlContext = Object.freeze({
    actor: {
        authenticatorId: "b".repeat(32),
        id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
        kind: "user" as const,
    },
    reauthorize: () => {},
    requestId: "request-1",
});

const modelUpdate = Object.freeze({
    baseHash: configuration.hash,
    confirmation: "apply-reviewed-settings" as const,
    update: {
        fallbacks: ["openai/gpt-5.6-sol"],
        primary: "openai/gpt-5.6",
        section: "models" as const,
    },
});

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("OpenClaw settings service", () => {
    test("returns only contract-valid secret-free read projections", async () => {
        const service = createOpenClawSettingsService({
            auditRequired: false,
            provider: provider(),
        });

        expect(await service.getConfiguration()).toEqual(configuration);
        expect(await service.listSkills()).toEqual(skills);

        const invalid = createOpenClawSettingsService({
            auditRequired: false,
            provider: provider({
                getConfiguration: () =>
                    Promise.resolve({
                        ...configuration,
                        hash: "PRIVATE-UPSTREAM-VALUE",
                    } as OpenClawConfigurationSnapshot),
            }),
        });
        const failure = await captureFailure(() => invalid.getConfiguration());
        expect(failure).toBeInstanceOf(OpenClawSettingsServiceError);
        expect(failure).toMatchObject({ reason: "provider-data-invalid" });
    });

    test("durably audits and reauthorizes at the provider dispatch boundary", async () => {
        const order: string[] = [];
        const audit: OpenClawSettingsOperationAuditInput[] = [];
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: (input) => {
                    order.push(`audit:${input.settlement}`);
                    audit.push(input);
                    return Promise.resolve();
                },
            },
            provider: provider({
                updateConfiguration: async ({ authorizeDispatch }) => {
                    order.push("provider:preflight");
                    await authorizeDispatch();
                    order.push("provider:dispatch");
                    return updateResult;
                },
            }),
        });

        expect(
            await service.updateConfiguration(modelUpdate, {
                ...controlContext,
                reauthorize: () => order.push("reauthorize"),
            })
        ).toEqual(updateResult);
        expect(order).toEqual([
            "audit:attempted",
            "provider:preflight",
            "reauthorize",
            "provider:dispatch",
            "audit:succeeded",
        ]);
        expect(audit.map(({ settlement, targetId }) => [settlement, targetId])).toEqual([
            ["attempted", "configuration:models"],
            ["succeeded", "configuration:models"],
        ]);
    });

    test("fails closed before dispatch when attempted audit persistence is unavailable", async () => {
        let providerCalls = 0;
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: () => Promise.reject(new Error("private database detail")),
            },
            provider: provider({
                updateConfiguration: () => {
                    providerCalls += 1;
                    return Promise.resolve(updateResult);
                },
            }),
        });

        const failure = await captureFailure(() =>
            service.updateConfiguration(modelUpdate, controlContext)
        );
        expect(failure).toBeInstanceOf(OpenClawSettingsServiceError);
        expect(failure).toMatchObject({ reason: "audit-unavailable" });
        expect(providerCalls).toBe(0);
    });

    test("audits one agent-tool intent without persisting policy arrays", async () => {
        const audit: OpenClawSettingsOperationAuditInput[] = [];
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: (input) => {
                    audit.push(input);
                    return Promise.resolve();
                },
            },
            provider: provider(),
        });

        await service.updateConfiguration(
            {
                baseHash: configuration.hash,
                confirmation: "apply-reviewed-settings",
                update: {
                    agentId: "main",
                    override: "deny",
                    section: "agent-tool-access",
                    toolId: "web_search",
                },
            },
            controlContext
        );

        expect(audit.map(({ settlement, targetId }) => [settlement, targetId])).toEqual([
            ["attempted", "configuration:agent-tool-access:main:web_search"],
            ["succeeded", "configuration:agent-tool-access:main:web_search"],
        ]);
        expect(
            audit.map(({ targetId }) => openClawSettingsAuditTargetFingerprint(targetId))
        ).toEqual([
            expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        ]);
        expect(JSON.stringify(audit)).not.toContain("alsoAllow");
        expect(JSON.stringify(audit)).not.toContain('deny"');
    });

    test("fails closed when authorization changes during provider preflight", async () => {
        const settlements: string[] = [];
        let providerCalls = 0;
        let dispatchCalls = 0;
        let revoked = false;
        const preflightStarted = Promise.withResolvers<void>();
        const releasePreflight = Promise.withResolvers<void>();
        const authorizationFailure = new Error("session changed");
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: (input) => {
                    settlements.push(input.settlement);
                    return Promise.resolve();
                },
            },
            provider: provider({
                updateConfiguration: async ({ authorizeDispatch }) => {
                    providerCalls += 1;
                    preflightStarted.resolve();
                    await releasePreflight.promise;
                    await authorizeDispatch();
                    dispatchCalls += 1;
                    return updateResult;
                },
            }),
        });

        const operation = service.updateConfiguration(modelUpdate, {
            ...controlContext,
            reauthorize: () => {
                if (revoked) throw authorizationFailure;
            },
        });
        await preflightStarted.promise;
        revoked = true;
        releasePreflight.resolve();
        const failure = await captureFailure(() => operation);
        expect(failure).toBe(authorizationFailure);
        expect(settlements).toEqual(["attempted", "failed"]);
        expect(providerCalls).toBe(1);
        expect(dispatchCalls).toBe(0);
    });

    test("never retries an unknown skill outcome and classifies its audit as partial", async () => {
        const settlements: string[] = [];
        let providerCalls = 0;
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: (input) => {
                    settlements.push(input.settlement);
                    return Promise.resolve();
                },
            },
            provider: provider({
                setSkillEnabled: () => {
                    providerCalls += 1;
                    return Promise.reject(
                        new OpenClawSettingsProviderError("unknown-outcome")
                    );
                },
            }),
        });

        const failure = await captureFailure(() =>
            service.setSkillEnabled(
                {
                    baseHash: configuration.hash,
                    enabled: false,
                    skillKey: "reviewed-skill",
                },
                controlContext
            )
        );
        expect(failure).toBeInstanceOf(OpenClawSettingsServiceError);
        expect(failure).toMatchObject({ reason: "unknown-outcome" });
        expect(providerCalls).toBe(1);
        expect(settlements).toEqual(["attempted", "partial"]);
    });

    test("does not rewrite a known result when terminal audit settlement fails", async () => {
        let auditCalls = 0;
        const failures: unknown[] = [];
        const service = createOpenClawSettingsService({
            auditWriter: {
                record: () => {
                    auditCalls += 1;
                    return auditCalls === 1
                        ? Promise.resolve()
                        : Promise.reject(new Error("private settlement detail"));
                },
            },
            onAuditSettlementFailure: (failure) => failures.push(failure),
            provider: provider(),
        });

        expect(await service.updateConfiguration(modelUpdate, controlContext)).toEqual(
            updateResult
        );
        expect(failures).toEqual([
            expect.objectContaining({
                operation: "update-configuration",
                settlement: "succeeded",
                targetFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            }),
        ]);
        expect(JSON.stringify(failures)).not.toContain("configuration:models");
    });
});
