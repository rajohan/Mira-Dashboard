import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { procedureContracts, rawHttpContracts } from "./contractRegistry.ts";
import {
    createOpenClawConfigurationBackupInputSchema,
    createOpenClawConfigurationBackupResultSchema,
    listOpenClawSkillsResultSchema,
    openClawConfigurationSnapshotSchema,
    openClawConfigurationUpstreamMaximumBytes,
    openClawGatewaySkillSources,
    openClawReviewedAgentToolIds,
    openClawSettingsProcedureContracts,
    openClawSettingsRawHttpContracts,
    openClawSkillMaximum,
    openClawSkillsUpstreamMaximumBytes,
    openClawSkillSources,
    restartOpenClawGatewayInputSchema,
    restartOpenClawGatewayResultSchema,
    updateOpenClawConfigurationInputSchema,
} from "./openClawSettings.ts";

const configurationHash = "a".repeat(64);
const configurationRevisionHash = `${"R".repeat(42)}A`;
const agentTools = openClawReviewedAgentToolIds.map((id) => ({
    editable: true,
    id,
    override: "inherit" as const,
}));
const validConfiguration = {
    agentAccess: [{ id: "main", name: "Main", tools: agentTools }],
    agentAccessTruncated: false,
    channels: [
        { enabled: true, id: "discord" },
        { enabled: false, id: "signal" },
    ],
    channelsTruncated: false,
    hash: configurationHash,
    heartbeat: { everySeconds: 300, target: "last" },
    includesPresent: false,
    issueCount: 0,
    lastTouchedAt: "2026-08-11T17:00:00.000Z",
    lastTouchedVersion: "2026.7.2-beta.7",
    models: {
        fallbacks: ["openai/gpt-5.5"],
        primary: "openai/gpt-5.6",
    },
    modelNormalizationState: "clean" as const,
    revisionHash: configurationRevisionHash,
    security: {
        authProfileCount: 2,
        commandRestartEnabled: false,
        ownerAllowFromCount: 1,
        redactionMode: "tools",
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
        sessionsVisibility: "tree",
        webFetchEnabled: true,
        webSearchEnabled: true,
        webSearchProvider: "brave",
    },
    valid: true,
};

function updateInput(update: unknown) {
    return {
        baseHash: configurationHash,
        baseRevisionHash: configurationRevisionHash,
        confirmation: "apply-reviewed-settings",
        update,
    };
}

describe("OpenClaw settings contracts", () => {
    test("registers exact session-only read and recent-MFA control procedures", () => {
        expect(
            openClawSettingsProcedureContracts.map(
                ({ access, kind, name, transport }) => ({
                    access,
                    kind,
                    name,
                    transport,
                })
            )
        ).toEqual([
            {
                access: {
                    capabilities: ["openclaw-settings:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "openClawSettings.getConfiguration",
                transport: {
                    batching: "adapter-default",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["openclaw-settings:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "openClawSettings.listSkills",
                transport: {
                    batching: "adapter-default",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["openclaw-settings:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "openClawSettings.updateConfiguration",
                transport: {
                    batching: "forbidden",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["openclaw-settings:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "openClawSettings.setSkillEnabled",
                transport: {
                    batching: "forbidden",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["openclaw-settings:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "openClawSettings.createConfigurationBackup",
                transport: {
                    batching: "forbidden",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["openclaw-settings:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "openClawSettings.restartGateway",
                transport: {
                    batching: "forbidden",
                    handler: "default",
                    requestBody: "default",
                },
            },
        ]);
        expect(
            procedureContracts
                .filter(({ domain }) => domain === "openclaw-settings")
                .map(({ name }) => name)
        ).toEqual(openClawSettingsProcedureContracts.map(({ name }) => name));
        expect(openClawSettingsProcedureContracts[3].errors).toEqual([
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ]);
    });

    test("keeps secret exports out of tRPC and publishes one-shot raw download metadata", () => {
        expect(
            v.parse(createOpenClawConfigurationBackupInputSchema, {
                confirmation: "export-openclaw-configuration",
            })
        ).toEqual({ confirmation: "export-openclaw-configuration" });
        const ticketId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
        expect(
            v.parse(createOpenClawConfigurationBackupResultSchema, {
                downloadUrl: `/api/openclaw-settings/configuration-backups/${ticketId}`,
                expiresAtMs: 1_786_464_060_000,
                ticketId,
            })
        ).toMatchObject({ ticketId });
        expect(
            v.safeParse(createOpenClawConfigurationBackupResultSchema, {
                bytes: '{"token":"secret"}',
                downloadUrl: `/api/openclaw-settings/configuration-backups/${ticketId}`,
                expiresAtMs: 1_786_464_060_000,
                ticketId,
            }).success
        ).toBe(false);
        expect(
            openClawSettingsRawHttpContracts.map(({ method, path }) => [method, path])
        ).toEqual([
            ["GET", "/api/openclaw-settings/configuration-backups/:ticketId"],
            ["HEAD", "/api/openclaw-settings/configuration-backups/:ticketId"],
        ]);
        expect(
            rawHttpContracts.filter(({ path }) =>
                path.startsWith("/api/openclaw-settings/configuration-backups/")
            )
        ).toHaveLength(2);
    });

    test("requires a stable caller idempotency key for fixed Gateway restart", () => {
        const input = {
            confirmation: "restart-openclaw-gateway" as const,
            idempotencyKey: "restart-gateway-019fe633-9133-4ba0-8b80-809dd80dfb40",
        };
        expect(v.parse(restartOpenClawGatewayInputSchema, input)).toEqual(input);
        expect(
            v.parse(restartOpenClawGatewayResultSchema, {
                completedAtMs: 1_786_464_060_000,
                jobRunId: "019fe633-9133-7ba0-a5f9-809dd80dfb40",
                status: "restarted",
            })
        ).toMatchObject({ status: "restarted" });
    });

    test("accepts only the bounded secret-free configuration projection", () => {
        expect(v.parse(openClawConfigurationSnapshotSchema, validConfiguration)).toEqual(
            validConfiguration
        );
        expect(
            v.parse(openClawConfigurationSnapshotSchema, {
                ...validConfiguration,
                tools: {
                    ...validConfiguration.tools,
                    sessionsVisibility: "agent",
                },
            }).tools.sessionsVisibility
        ).toBe("agent");

        for (const invalid of [
            { ...validConfiguration, raw: JSON.stringify({ token: "secret" }) },
            {
                ...validConfiguration,
                security: { ...validConfiguration.security, gatewayToken: "secret" },
            },
            {
                ...validConfiguration,
                channels: validConfiguration.channels.toReversed(),
            },
            {
                ...validConfiguration,
                models: { ...validConfiguration.models, fallbacks: ["same", "same"] },
            },
        ]) {
            expect(
                v.safeParse(openClawConfigurationSnapshotSchema, invalid).success
            ).toBe(false);
        }

        for (const agentId of [
            "CONSTRUCTOR",
            "__Proto__",
            "__proto__",
            "constructor",
            "main/child",
            String.raw`main\child`,
            "main.with-dot",
            "main%2Fchild",
            "..",
            "prototype",
            "K",
            "ſ",
            " main",
            "main ",
        ]) {
            expect(
                v.safeParse(
                    updateOpenClawConfigurationInputSchema,
                    updateInput({
                        agentId,
                        override: "deny",
                        section: "agent-tool-access",
                        toolId: "exec",
                    })
                ).success
            ).toBe(false);
        }

        for (const agentId of ["Main", "OPS_1", "_ops"]) {
            expect(
                v.safeParse(
                    updateOpenClawConfigurationInputSchema,
                    updateInput({
                        agentId,
                        override: "deny",
                        section: "agent-tool-access",
                        toolId: "exec",
                    })
                ).success
            ).toBe(true);
        }

        for (const id of ["constructor", "prototype"]) {
            expect(
                v.safeParse(
                    updateOpenClawConfigurationInputSchema,
                    updateInput({
                        channels: [{ enabled: true, id }],
                        section: "channels",
                    })
                ).success
            ).toBe(false);
        }
    });

    test("accepts only exact hash-fenced section updates", () => {
        const updates = [
            {
                agentId: "main",
                override: "deny",
                section: "agent-tool-access",
                toolId: "exec",
            },
            {
                channels: validConfiguration.channels,
                section: "channels",
            },
            {
                everySeconds: 300,
                section: "heartbeat",
                target: null,
            },
            {
                fallbacks: ["openai/gpt-5.5"],
                primary: "openai/gpt-5.6",
                section: "models",
            },
            { idleMinutes: 60, mode: "idle", section: "session-reset" },
            { section: "tools", settings: validConfiguration.tools },
        ];
        for (const update of updates) {
            expect(
                v.safeParse(updateOpenClawConfigurationInputSchema, updateInput(update))
                    .success
            ).toBe(true);
        }

        for (const invalid of [
            { ...updateInput(updates[0]), baseHash: "A".repeat(64) },
            { ...updateInput(updates[0]), baseRevisionHash: "A".repeat(42) },
            { ...updateInput(updates[0]), baseRevisionHash: "A".repeat(44) },
            { ...updateInput(updates[0]), baseRevisionHash: `${"A".repeat(42)}B` },
            { ...updateInput(updates[0]), baseRevisionHash: `${"A".repeat(42)}!` },
            { ...updateInput(updates[0]), confirmation: "apply" },
            updateInput({ raw: "{}", section: "raw" }),
            updateInput({
                agents: validConfiguration.agentAccess,
                section: "agent-access",
            }),
            updateInput({
                agentId: "main",
                allow: ["exec"],
                override: "allow",
                section: "agent-tool-access",
                toolId: "exec",
            }),
            updateInput({
                agentId: "main",
                alsoAllow: ["exec"],
                deny: [],
                override: "allow",
                section: "agent-tool-access",
                toolId: "exec",
            }),
            updateInput({
                agentId: ["main", "worker"],
                override: "deny",
                section: "agent-tool-access",
                toolId: "exec",
            }),
            updateInput({
                agentId: "main",
                override: "allow",
                section: "agent-tool-access",
                toolId: "database",
            }),
            updateInput({ everySeconds: 9, section: "heartbeat", target: null }),
            updateInput({
                fallbacks: ["same", "same"],
                primary: "same",
                section: "models",
            }),
        ]) {
            expect(
                v.safeParse(updateOpenClawConfigurationInputSchema, invalid).success
            ).toBe(false);
        }
    });

    test("accepts only complete canonical agent-level tool overrides", () => {
        expect(openClawReviewedAgentToolIds).toEqual([
            "automations",
            "browser",
            "edit",
            "exec",
            "gateway",
            "image",
            "image_generate",
            "memory_search",
            "message",
            "music_generate",
            "nodes",
            "read",
            "sessions_history",
            "sessions_list",
            "tts",
            "video_generate",
            "web_fetch",
            "web_search",
            "write",
        ]);

        for (const agentAccess of [
            [{ ...validConfiguration.agentAccess[0], tools: agentTools.slice(1) }],
            [
                {
                    ...validConfiguration.agentAccess[0],
                    tools: agentTools.with(0, {
                        editable: true,
                        id: "database" as (typeof agentTools)[number]["id"],
                        override: "inherit",
                    }),
                },
            ],
            [
                {
                    ...validConfiguration.agentAccess[0],
                    allow: ["exec"],
                },
            ],
            [
                {
                    ...validConfiguration.agentAccess[0],
                    alsoAllow: ["exec"],
                },
            ],
            [
                {
                    ...validConfiguration.agentAccess[0],
                    deny: ["gateway"],
                },
            ],
            [
                {
                    id: "main",
                    tools: { allow: ["exec"], deny: ["gateway"] },
                },
            ],
            [
                { id: "z-agent", tools: agentTools },
                { id: "a-agent", tools: agentTools },
            ],
            [{ id: "__proto__", tools: agentTools }],
            [{ id: "main.with-dot", tools: agentTools }],
        ]) {
            expect(
                v.safeParse(openClawConfigurationSnapshotSchema, {
                    ...validConfiguration,
                    agentAccess,
                }).success
            ).toBe(false);
        }
    });

    test("projects stable path-free skill rows from a closed source vocabulary", () => {
        expect(openClawGatewaySkillSources).toEqual([
            "agents-skills-personal",
            "agents-skills-project",
            "openclaw-bundled",
            "openclaw-extra",
            "openclaw-managed",
            "openclaw-node",
            "openclaw-workspace",
            "unknown",
        ]);
        expect(openClawSkillSources).toEqual([
            "agents-skills-personal",
            "agents-skills-project",
            "openclaw-bundled",
            "openclaw-configured",
            "openclaw-extra",
            "openclaw-managed",
            "openclaw-node",
            "openclaw-unknown",
            "openclaw-workspace",
        ]);
        const skills = [
            {
                bundled: true,
                description: "Built-in skill",
                eligible: true,
                enabled: true,
                installed: true,
                key: "alpha",
                name: "Alpha",
                source: "openclaw-bundled",
            },
            {
                bundled: false,
                eligible: false,
                enabled: false,
                installed: true,
                key: "beta",
                name: "Beta",
                source: "openclaw-workspace",
            },
            {
                bundled: false,
                eligible: false,
                enabled: true,
                installed: false,
                key: "configured-only",
                name: "configured-only",
                source: "openclaw-configured",
            },
        ];
        const result = { skills, truncated: false };
        expect(v.parse(listOpenClawSkillsResultSchema, result)).toEqual(result);

        for (const invalid of [
            { skills: skills.toReversed(), truncated: false },
            { skills: [skills[0], skills[0]], truncated: false },
            {
                skills: [{ ...skills[1], filePath: "/home/operator/SKILL.md" }],
                truncated: false,
            },
            {
                skills: [{ ...skills[1], source: "/home/operator/skills" }],
                truncated: false,
            },
            {
                skills: [{ ...skills[1], key: "constructor" }],
                truncated: false,
            },
            {
                skills: [{ ...skills[1], key: "PROTOTYPE" }],
                truncated: false,
            },
            {
                skills: [{ ...skills[1], bundled: true }],
                truncated: false,
            },
            {
                skills: [{ ...skills[2], installed: true }],
                truncated: false,
            },
        ]) {
            expect(v.safeParse(listOpenClawSkillsResultSchema, invalid).success).toBe(
                false
            );
        }
    });

    test("publishes explicit upstream and row budgets", () => {
        expect(openClawConfigurationUpstreamMaximumBytes).toBe(2 * 1024 * 1024);
        expect(openClawSkillsUpstreamMaximumBytes).toBe(1024 * 1024);
        expect(openClawSkillMaximum).toBe(512);

        const oversizedSkills = Array.from(
            { length: openClawSkillMaximum + 1 },
            (_, index) => ({
                bundled: false,
                eligible: true,
                enabled: true,
                installed: true,
                key: `skill-${String(index).padStart(3, "0")}`,
                name: `Skill ${index}`,
                source: "openclaw-workspace",
            })
        );
        expect(
            v.safeParse(listOpenClawSkillsResultSchema, {
                skills: oversizedSkills,
                truncated: true,
            }).success
        ).toBe(false);
    });
});
