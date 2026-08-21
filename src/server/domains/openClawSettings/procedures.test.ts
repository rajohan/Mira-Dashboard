import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationSnapshot,
} from "../../../contracts/openClawSettings.ts";
import type { ApplicationCapability } from "../../../contracts/security.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { router } from "../../trpc/trpc.ts";
import type { OpenClawSettingsMutationAccess } from "./mutationAccess.ts";
import { openClawSettingsRouter } from "./procedures.ts";
import {
    OpenClawSettingsServiceError,
    type OpenClawSettingsControlContext,
    type OpenClawSettingsService,
} from "./service.ts";

const configuration: OpenClawConfigurationSnapshot = {
    agentAccess: [],
    agentAccessTruncated: false,
    channels: [],
    channelsTruncated: false,
    hash: "a".repeat(64),
    heartbeat: {},
    includesPresent: false,
    issueCount: 0,
    models: { fallbacks: [] },
    modelNormalizationState: "clean",
    revisionHash: `${"R".repeat(42)}A`,
    security: {
        authProfileCount: 0,
        commandRestartEnabled: false,
        ownerAllowFromCount: 0,
    },
    sessionReset: { state: "inherited-none" },
    tools: {
        agentToAgentEnabled: false,
        elevatedEnabled: false,
        execPolicy: { ask: "always", security: "deny", state: "explicit" },
        webFetchEnabled: true,
        webSearchEnabled: true,
    },
    valid: true,
};

const skills: ListOpenClawSkillsResult = { skills: [], truncated: false };

const configurationBackup = Object.freeze({
    downloadUrl:
        "/api/openclaw-settings/configuration-backups/00000000-0000-4000-8000-000000000001",
    expiresAtMs: 1,
    ticketId: "00000000-0000-4000-8000-000000000001",
});

const configurationBackupInput = Object.freeze({
    confirmation: "export-openclaw-configuration" as const,
});

const gatewayRestart = Object.freeze({
    completedAtMs: 1,
    jobRunId: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
    status: "restarted" as const,
});

const gatewayRestartInput = Object.freeze({
    confirmation: "restart-openclaw-gateway" as const,
    idempotencyKey: "019ff1c6-1a9b-4770-8f1b-d5b863b0e7b4",
});

function testService(
    calls: string[],
    contexts: OpenClawSettingsControlContext[] = []
): OpenClawSettingsService {
    return {
        createConfigurationBackup: (input, context) => {
            context.reauthorize();
            contexts.push(context);
            calls.push(`backup:${input.confirmation}`);
            return Promise.resolve(configurationBackup);
        },
        getConfiguration: () => {
            calls.push("get-configuration");
            return Promise.resolve(configuration);
        },
        listSkills: () => {
            calls.push("list-skills");
            return Promise.resolve(skills);
        },
        restartGateway: (input, context) => {
            context.reauthorize();
            contexts.push(context);
            calls.push(`restart:${input.idempotencyKey}`);
            return Promise.resolve(gatewayRestart);
        },
        setSkillEnabled: (input, context) => {
            context.reauthorize();
            contexts.push(context);
            calls.push(`set-skill:${input.skillKey}:${input.enabled}`);
            return Promise.resolve({
                enabled: input.enabled,
                skillKey: input.skillKey,
            });
        },
        updateConfiguration: (input, context) => {
            context.reauthorize();
            contexts.push(context);
            calls.push(`update:${input.update.section}`);
            return Promise.resolve({
                changed: true,
                configuration,
                restartRequired: false,
                restartScheduled: false,
            });
        },
    };
}

function sessionContext(
    service: OpenClawSettingsService,
    access: OpenClawSettingsMutationAccess,
    capabilities: readonly ApplicationCapability[] = [
        "openclaw-settings:read",
        "openclaw-settings:write",
    ]
): RequestContext {
    return {
        authentication: {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: [...capabilities],
                authenticatorId: "b".repeat(32),
                id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "session",
            },
        },
        authenticationLease: {
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            revalidate: () => Promise.reject(new Error("Not used by this test")),
        },
        openClawSettingsMutationAccess: access,
        openClawSettingsService: service,
        requestId: "request-1",
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

function anonymousContext(service: OpenClawSettingsService): RequestContext {
    return {
        authentication: { kind: "anonymous" },
        openClawSettingsService: service,
        requestId: "request-1",
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

function automationContext(service: OpenClawSettingsService): RequestContext {
    return {
        authentication: {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: ["openclaw-settings:read", "openclaw-settings:write"],
                authenticatorId: "019ff1c6-1a9b-7771-9f1b-d5b863b0e7b4",
                id: "test-automation",
                kind: "automation",
            },
        },
        authenticationLease: {
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            revalidate: () => Promise.reject(new Error("Not used by this test")),
        },
        openClawSettingsService: service,
        requestId: "request-1",
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

const testRouter = router({ openClawSettings: openClawSettingsRouter });

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("OpenClaw settings procedures", () => {
    test("serves bounded reads and recently-authorized exact controls", async () => {
        const calls: string[] = [];
        const contexts: OpenClawSettingsControlContext[] = [];
        let authorizationChecks = 0;
        const caller = testRouter.createCaller(
            sessionContext(testService(calls, contexts), {
                authorizeRecentMfa: () => {
                    authorizationChecks += 1;
                    return "authorized";
                },
            })
        ).openClawSettings;

        expect(await caller.getConfiguration({})).toEqual(configuration);
        expect(await caller.listSkills({})).toEqual(skills);
        expect(await caller.createConfigurationBackup(configurationBackupInput)).toEqual(
            configurationBackup
        );
        expect(await caller.restartGateway(gatewayRestartInput)).toEqual(gatewayRestart);
        await caller.updateConfiguration({
            baseHash: configuration.hash,
            baseRevisionHash: configuration.revisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                fallbacks: [],
                primary: "openai/gpt-5.6",
                section: "models",
            },
        });
        expect(
            await caller.setSkillEnabled({
                baseHash: configuration.hash,
                baseRevisionHash: configuration.revisionHash,
                enabled: false,
                skillKey: "reviewed-skill",
            })
        ).toEqual({ enabled: false, skillKey: "reviewed-skill" });

        expect(calls).toEqual([
            "get-configuration",
            "list-skills",
            "backup:export-openclaw-configuration",
            `restart:${gatewayRestartInput.idempotencyKey}`,
            "update:models",
            "set-skill:reviewed-skill:false",
        ]);
        expect(authorizationChecks).toBe(8);
        expect(contexts).toHaveLength(4);
        expect(contexts[0]).toMatchObject({
            actor: {
                authenticatorId: "b".repeat(32),
                id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "user",
            },
            requestId: "request-1",
        });
    });

    test("rejects non-session reads and enforces separate session capabilities", async () => {
        const calls: string[] = [];
        const service = testService(calls);
        const access = { authorizeRecentMfa: () => "authorized" as const };

        const anonymous = testRouter.createCaller(
            anonymousContext(service)
        ).openClawSettings;
        expect(await captureFailure(() => anonymous.getConfiguration({}))).toMatchObject({
            code: "UNAUTHORIZED",
        });
        const automation = testRouter.createCaller(
            automationContext(service)
        ).openClawSettings;
        expect(await captureFailure(() => automation.getConfiguration({}))).toMatchObject(
            { code: "FORBIDDEN" }
        );
        expect(
            await captureFailure(() =>
                automation.createConfigurationBackup(configurationBackupInput)
            )
        ).toMatchObject({ code: "FORBIDDEN" });
        expect(
            await captureFailure(() => automation.restartGateway(gatewayRestartInput))
        ).toMatchObject({ code: "FORBIDDEN" });

        const readOnly = testRouter.createCaller(
            sessionContext(service, access, ["openclaw-settings:read"])
        ).openClawSettings;
        expect(await readOnly.listSkills({})).toEqual(skills);
        expect(
            await captureFailure(() =>
                readOnly.setSkillEnabled({
                    baseHash: configuration.hash,
                    baseRevisionHash: configuration.revisionHash,
                    enabled: true,
                    skillKey: "reviewed-skill",
                })
            )
        ).toMatchObject({ code: "FORBIDDEN" });
        expect(
            await captureFailure(() =>
                readOnly.createConfigurationBackup(configurationBackupInput)
            )
        ).toMatchObject({ code: "FORBIDDEN" });
        expect(
            await captureFailure(() => readOnly.restartGateway(gatewayRestartInput))
        ).toMatchObject({ code: "FORBIDDEN" });

        const writeOnly = testRouter.createCaller(
            sessionContext(service, access, ["openclaw-settings:write"])
        ).openClawSettings;
        expect(await captureFailure(() => writeOnly.listSkills({}))).toMatchObject({
            code: "FORBIDDEN",
        });
        expect(calls).toEqual(["list-skills"]);
    });

    test("denies controls without recent MFA before invoking the service", async () => {
        for (const status of [
            "mfa-enrollment-required",
            "step-up-required",
            "session-changed",
        ] as const) {
            const calls: string[] = [];
            const context = sessionContext(testService(calls), {
                authorizeRecentMfa: () => status,
            });
            const caller = testRouter.createCaller(context).openClawSettings;
            const failure = await captureFailure(() => {
                switch (status) {
                    case "mfa-enrollment-required": {
                        return caller.setSkillEnabled({
                            baseHash: configuration.hash,
                            baseRevisionHash: configuration.revisionHash,
                            enabled: true,
                            skillKey: "reviewed-skill",
                        });
                    }
                    case "step-up-required": {
                        return caller.createConfigurationBackup(configurationBackupInput);
                    }
                    case "session-changed": {
                        return caller.restartGateway(gatewayRestartInput);
                    }
                }
            });

            expect(failure).toBeInstanceOf(TRPCError);
            expect(calls).toEqual([]);
            if (status === "session-changed") {
                expect(context.responseHeaders.get("set-cookie")).toContain("Max-Age=0");
            }
        }
    });

    test("maps exact control failures to fixed tRPC errors", async () => {
        for (const [operation, reason, code, message] of [
            ["skill", "conflict", "CONFLICT", "OpenClaw configuration state changed"],
            ["skill", "not-found", "NOT_FOUND", "OpenClaw setting target was not found"],
            [
                "backup",
                "capacity",
                "TOO_MANY_REQUESTS",
                "OpenClaw configuration export capacity is exhausted",
            ],
            [
                "backup",
                "provider-unavailable",
                "SERVICE_UNAVAILABLE",
                "OpenClaw settings are temporarily unavailable",
            ],
            [
                "restart",
                "unknown-outcome",
                "SERVICE_UNAVAILABLE",
                "OpenClaw settings outcome could not be confirmed",
            ],
        ] as const) {
            const base = testService([]);
            const privateDetail = `private ${operation} provider detail`;
            const serviceFailure = new OpenClawSettingsServiceError(reason, {
                cause: new Error(privateDetail),
            });
            const service: OpenClawSettingsService = {
                ...base,
                createConfigurationBackup:
                    operation === "backup"
                        ? () => Promise.reject(serviceFailure)
                        : base.createConfigurationBackup,
                restartGateway:
                    operation === "restart"
                        ? () => Promise.reject(serviceFailure)
                        : base.restartGateway,
                setSkillEnabled:
                    operation === "skill"
                        ? () => Promise.reject(serviceFailure)
                        : base.setSkillEnabled,
            };
            const caller = testRouter.createCaller(
                sessionContext(service, {
                    authorizeRecentMfa: () => "authorized",
                })
            ).openClawSettings;
            const failure = await captureFailure(() => {
                switch (operation) {
                    case "backup": {
                        return caller.createConfigurationBackup(configurationBackupInput);
                    }
                    case "restart": {
                        return caller.restartGateway(gatewayRestartInput);
                    }
                    case "skill": {
                        return caller.setSkillEnabled({
                            baseHash: configuration.hash,
                            baseRevisionHash: configuration.revisionHash,
                            enabled: true,
                            skillKey: "reviewed-skill",
                        });
                    }
                }
            });

            expect(failure).toBeInstanceOf(TRPCError);
            expect(failure).toMatchObject({ code, message });
            expect(String(failure)).not.toContain(privateDetail);
            if (reason === "unknown-outcome") {
                expect(failure).toHaveProperty(
                    "cause.reason",
                    "operation_outcome_unknown"
                );
            }
        }
    });
});
