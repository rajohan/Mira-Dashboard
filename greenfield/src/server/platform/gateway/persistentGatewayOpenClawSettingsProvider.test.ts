import { describe, expect, test } from "bun:test";

import { openClawReviewedAgentToolIds } from "../../../contracts/openClawSettings.ts";
import { OpenClawSettingsProviderError } from "../../domains/openClawSettings/provider.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createPersistentGatewayOpenClawSettingsProvider,
    type PersistentGatewayOpenClawSettingsTransport,
} from "./persistentGatewayOpenClawSettingsProvider.ts";
import type {
    PersistentGatewayOpenClawSettingsReadMethod,
    PersistentGatewayOpenClawSettingsWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    persistentGatewayConfigurationChangedReason,
    type PersistentGatewayOpenClawSettingsWriteOptions,
    type PersistentGatewayRequestOptions,
    PersistentGatewayRequestError,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

const currentHash = "a".repeat(64);
const nextHash = "b".repeat(64);
const hiddenValue = "must-not-cross-the-settings-provider";
const authorizeDispatch = (): Promise<void> => Promise.resolve();

function expectedAgentToolOverride(
    id: (typeof openClawReviewedAgentToolIds)[number]
): "allow" | "deny" | "inherit" {
    if (id === "automations") return "allow";
    if (id === "web_search") return "deny";
    return "inherit";
}

interface FixtureResponse {
    readonly bytes?: number;
    readonly payload?: unknown;
    readonly rejection?: Error;
}

interface FixtureCall {
    readonly lane: "read" | "write";
    readonly method:
        | PersistentGatewayOpenClawSettingsReadMethod
        | PersistentGatewayOpenClawSettingsWriteMethod;
    readonly options?:
        | PersistentGatewayOpenClawSettingsWriteOptions
        | PersistentGatewayRequestOptions;
    readonly parameters: Readonly<Record<string, unknown>>;
}

function encodedResponseBytes(payload: unknown): number {
    return Buffer.byteLength(
        JSON.stringify({ id: "fixture", ok: true, payload, type: "res" }),
        "utf8"
    );
}

function createFixtureTransport(input: {
    readonly reads?: readonly FixtureResponse[];
    readonly writes?: readonly FixtureResponse[];
}): Readonly<{
    calls: FixtureCall[];
    transport: PersistentGatewayOpenClawSettingsTransport;
}> {
    const calls: FixtureCall[] = [];
    const reads = [...(input.reads ?? [])];
    const writes = [...(input.writes ?? [])];
    const settle = (
        response: FixtureResponse | undefined,
        options: PersistentGatewayRequestOptions | undefined
    ): Promise<unknown> => {
        if (response === undefined) {
            return Promise.reject(new Error("Missing fixture response"));
        }
        if (response.rejection !== undefined) {
            return Promise.reject(response.rejection);
        }
        options?.onResponseBytes?.(
            response.bytes ?? encodedResponseBytes(response.payload)
        );
        return Promise.resolve(response.payload);
    };
    return {
        calls,
        transport: {
            requestOpenClawSettingsRead(method, parameters, options) {
                calls.push({ lane: "read", method, options, parameters });
                return settle(reads.shift(), options);
            },
            async requestOpenClawSettingsWrite(method, parameters, options) {
                calls.push({ lane: "write", method, options, parameters });
                await options.beforeDispatch();
                return settle(writes.shift(), options);
            },
        },
    };
}

function configGetFixture(hash = currentHash): unknown {
    return {
        config: {
            agents: {
                defaults: {
                    heartbeat: { every: "1h30m", target: "discord" },
                    model: {
                        fallbacks: ["openai/gpt-5.6-terra"],
                        primary: "openai/gpt-5.6-sol",
                    },
                },
                entries: {
                    main: {
                        default: true,
                        identity: { privatePath: `/home/fixture/${hiddenValue}` },
                        name: "Main",
                        tools: {
                            allow: [],
                            alsoAllow: ["cron", "custom-provider-tool"],
                            deny: ["web_search", "custom-denied-tool"],
                        },
                    },
                },
            },
            auth: {
                profiles: {
                    first: { token: hiddenValue },
                    second: { password: hiddenValue },
                },
            },
            channels: {
                telegram: { enabled: false, token: hiddenValue },
                discord: { enabled: true, token: hiddenValue },
            },
            commands: {
                ownerAllowFrom: ["owner-one", "owner-two"],
                restart: false,
            },
            logging: { redactSensitive: "tools" },
            meta: {
                lastTouchedAt: "2026-08-11T10:00:00.000Z",
                lastTouchedVersion: "2026.7.2-beta.7",
            },
            session: { reset: { idleMinutes: 45 } },
            skills: {
                entries: {
                    "config-only": { enabled: false, token: hiddenValue },
                    imagegen: { apiKey: hiddenValue, enabled: true },
                    zotero: {
                        enabled: false,
                        env: { SECRET_VALUE: hiddenValue },
                    },
                },
            },
            tools: {
                agentToAgent: { enabled: true },
                elevated: { enabled: false },
                exec: { mode: "ask" },
                profile: "coding",
                sessions: { visibility: "agent" },
                web: {
                    fetch: { enabled: false },
                    search: { enabled: true, provider: "brave" },
                },
            },
        },
        hash,
        issues: [{ message: hiddenValue, path: hiddenValue }],
        legacyIssues: [],
        path: `/home/fixture/${hiddenValue}/openclaw.json`,
        raw: hiddenValue,
        valid: true,
    };
}

function configGetFixtureWithSkill(
    enabled: boolean,
    hash: string,
    skillKey = "imagegen"
): unknown {
    const fixture = structuredClone(configGetFixture(hash)) as {
        config: {
            skills: { entries: Record<string, { enabled: boolean }> };
        };
    };
    const entry = fixture.config.skills.entries[skillKey];
    if (entry === undefined) throw new Error("Expected configured skill fixture");
    entry.enabled = enabled;
    return fixture;
}

function skillsFixture(): unknown {
    return {
        managedSkillsDir: `/home/fixture/${hiddenValue}/skills`,
        skills: [
            {
                baseDir: `/home/fixture/${hiddenValue}/skills/zotero`,
                bundled: false,
                description: "Collect citations",
                disabled: true,
                eligible: false,
                filePath: `/home/fixture/${hiddenValue}/skills/zotero/SKILL.md`,
                name: "Zotero",
                skillKey: "zotero",
                source: "openclaw-managed",
            },
            {
                baseDir: `/home/fixture/${hiddenValue}/skills/imagegen`,
                bundled: true,
                description: "Generate images",
                disabled: false,
                eligible: true,
                filePath: `/home/fixture/${hiddenValue}/skills/imagegen/SKILL.md`,
                name: "Image generation",
                skillKey: "imagegen",
                source: "openclaw-bundled",
            },
        ],
        workspaceDir: `/home/fixture/${hiddenValue}`,
    };
}

describe("persistent Gateway OpenClaw Settings provider", () => {
    test("projects a bounded secret-free configuration on the dedicated read lane", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });
        const provider = createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        );

        const result = await provider.getConfiguration({});

        expect(result).toEqual({
            agentAccess: [
                {
                    id: "main",
                    name: "Main",
                    tools: openClawReviewedAgentToolIds.map((id) => ({
                        editable: true,
                        id,
                        override: expectedAgentToolOverride(id),
                    })),
                },
            ],
            agentAccessTruncated: false,
            channels: [
                { enabled: true, id: "discord" },
                { enabled: false, id: "telegram" },
            ],
            hash: currentHash,
            heartbeat: { everySeconds: 5400, target: "discord" },
            issueCount: 1,
            lastTouchedAt: "2026-08-11T10:00:00.000Z",
            lastTouchedVersion: "2026.7.2-beta.7",
            models: {
                fallbacks: ["openai/gpt-5.6-terra"],
                primary: "openai/gpt-5.6-sol",
            },
            security: {
                authProfileCount: 2,
                commandRestartEnabled: false,
                ownerAllowFromCount: 2,
                redactionMode: "tools",
            },
            sessionReset: { idleMinutes: 45 },
            tools: {
                agentToAgentEnabled: true,
                elevatedEnabled: false,
                execAsk: "on-miss",
                execSecurity: "allowlist",
                profile: "coding",
                sessionsVisibility: "agent",
                webFetchEnabled: false,
                webSearchEnabled: true,
                webSearchProvider: "brave",
            },
            valid: true,
        });
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toMatchObject({
            lane: "read",
            method: "config.get",
            parameters: {},
        });
        expect(fixture.calls[0]?.options).toMatchObject({ timeoutMs: 15_000 });
        expect(JSON.stringify(result)).not.toContain(hiddenValue);
        expect(JSON.stringify(result)).not.toContain("/home/");
    });

    test("fails closed when elevated tool configuration is absent", async () => {
        const fixture = createFixtureTransport({
            reads: [
                {
                    payload: {
                        config: {},
                        hash: currentHash,
                        issues: [],
                        legacyIssues: [],
                        valid: true,
                    },
                },
            ],
        });

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).getConfiguration({});

        expect(result.tools.elevatedEnabled).toBe(false);
    });

    test("omits unsafe agent ids and locks ambiguous agent policy rows", async () => {
        const unsafe = structuredClone(configGetFixture()) as {
            config: {
                agents: {
                    entries: Record<string, Record<string, unknown>>;
                };
            };
        };
        unsafe.config.agents.entries["main.with-dot"] = {
            default: false,
            name: "Unsafe dotted row",
        };
        unsafe.config.agents.entries["constructor"] = {
            default: false,
            name: "Dangerous row",
        };
        const unsafeResult = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({ reads: [{ payload: unsafe }] }).transport
        ).getConfiguration({});
        expect(unsafeResult.agentAccess.map(({ id }) => id)).toEqual(["main"]);
        expect(unsafeResult.agentAccessTruncated).toBe(true);
        expect(unsafeResult.agentAccess[0]?.tools.every(({ editable }) => editable)).toBe(
            true
        );

        const ambiguous = structuredClone(configGetFixture()) as {
            config: {
                agents: {
                    entries: Record<string, Record<string, unknown>>;
                };
            };
        };
        ambiguous.config.agents.entries.Main = {
            default: false,
            name: "Case collision",
        };
        const ambiguousResult = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({ reads: [{ payload: ambiguous }] }).transport
        ).getConfiguration({});
        expect(ambiguousResult.agentAccessTruncated).toBe(true);
        expect(
            ambiguousResult.agentAccess[0]?.tools.every(({ editable }) => !editable)
        ).toBe(true);

        const allowMode = structuredClone(configGetFixture()) as {
            config: {
                agents: {
                    entries: {
                        main: { tools: { allow: string[] } };
                    };
                };
            };
        };
        allowMode.config.agents.entries.main.tools.allow = ["read"];
        const fixture = createFixtureTransport({
            reads: [{ payload: allowMode }],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        agentId: "main",
                        override: "allow",
                        section: "agent-tool-access",
                        toolId: "web_fetch",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls).toHaveLength(1);
    });

    test("sorts installed skills and discards every upstream filesystem field", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
        });
        const provider = createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        );

        const result = await provider.listSkills({});

        expect(result).toEqual({
            skills: [
                {
                    bundled: false,
                    eligible: false,
                    enabled: false,
                    installed: false,
                    key: "config-only",
                    name: "config-only",
                    source: "openclaw-configured",
                },
                {
                    bundled: true,
                    description: "Generate images",
                    eligible: true,
                    enabled: true,
                    installed: true,
                    key: "imagegen",
                    name: "Image generation",
                    source: "openclaw-bundled",
                },
                {
                    bundled: false,
                    description: "Collect citations",
                    eligible: false,
                    enabled: false,
                    installed: true,
                    key: "zotero",
                    name: "Zotero",
                    source: "openclaw-managed",
                },
            ],
            truncated: false,
        });
        expect(fixture.calls[1]).toMatchObject({
            lane: "read",
            method: "skills.status",
            parameters: {},
        });
        expect(JSON.stringify(result)).not.toContain(hiddenValue);
        expect(JSON.stringify(result)).not.toContain("baseDir");
        expect(JSON.stringify(result)).not.toContain("filePath");
    });

    test("omits unadmitted configured skill keys without invalidating the list", async () => {
        const configuration = structuredClone(configGetFixture()) as {
            config: {
                skills: { entries: Record<string, { enabled: boolean }> };
            };
        };
        configuration.config.skills.entries["invalid skill key"] = { enabled: true };
        const result = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({
                reads: [{ payload: configuration }, { payload: skillsFixture() }],
            }).transport
        ).listSkills({});

        expect(result.skills.some(({ key }) => key === "invalid skill key")).toBe(false);
        expect(result.truncated).toBe(true);
    });

    test("omits control-bearing skill descriptions without dropping the skill", async () => {
        const payload = structuredClone(skillsFixture()) as {
            skills: Array<Record<string, unknown>>;
        };
        payload.skills[0] = {
            ...payload.skills[0],
            description: "looks safe\u0007hidden",
        };
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload }],
        });

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).listSkills({});

        expect(result.skills.find(({ key }) => key === "zotero")).toEqual({
            bundled: false,
            eligible: false,
            enabled: false,
            installed: true,
            key: "zotero",
            name: "Zotero",
            source: "openclaw-managed",
        });
    });

    test("builds the exact hash-fenced model patch on a fresh Settings write lane", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as {
            agents: {
                defaults: {
                    heartbeat: Record<string, unknown>;
                    model: Record<string, unknown>;
                };
            };
            meta: Record<string, unknown>;
        };
        acknowledgedConfig.agents.defaults.model = {
            fallbacks: ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
            primary: "openai/gpt-5.6-sol",
        };
        acknowledgedConfig.meta.lastTouchedVersion = "2026.8.0";
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    payload: {
                        config: acknowledgedConfig,
                        hash: nextHash,
                        ok: true,
                        restart: { ok: true, pid: 1234 },
                        sentinel: {
                            payload: { stats: { requiresRestart: true } },
                            persisted: true,
                        },
                    },
                },
            ],
        });
        const provider = createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        );

        const result = await provider.updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            confirmation: "apply-reviewed-settings",
            update: {
                fallbacks: ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
                primary: "openai/gpt-5.6-sol",
                section: "models",
            },
        });

        const write = fixture.calls[1];
        expect(write).toMatchObject({ lane: "write", method: "config.patch" });
        expect(write?.parameters).toMatchObject({
            baseHash: currentHash,
            note: "Updated from Mira Dashboard settings",
            replacePaths: ["agents.defaults.model.fallbacks"],
        });
        expect(JSON.parse(String(write?.parameters.raw))).toEqual({
            agents: {
                defaults: {
                    model: {
                        fallbacks: ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
                        primary: "openai/gpt-5.6-sol",
                    },
                },
            },
        });
        expect(result).toMatchObject({
            changed: true,
            configuration: {
                hash: nextHash,
                lastTouchedVersion: "2026.8.0",
                models: {
                    fallbacks: ["openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
                    primary: "openai/gpt-5.6-sol",
                },
            },
            restartRequired: true,
            restartScheduled: true,
        });
        expect(JSON.stringify(result)).not.toContain("raw");
        expect(JSON.stringify(result)).not.toContain("path");
    });

    test("preserves agent session visibility through the tools patch round trip", async () => {
        const acknowledgedConfig = (
            configGetFixture() as { config: Record<string, unknown> }
        ).config;
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    payload: {
                        config: acknowledgedConfig,
                        hash: nextHash,
                        ok: true,
                        sentinel: {
                            payload: { stats: { requiresRestart: false } },
                            persisted: true,
                        },
                    },
                },
            ],
        });
        const settings = {
            agentToAgentEnabled: true,
            elevatedEnabled: false,
            execAsk: "on-miss" as const,
            execSecurity: "allowlist" as const,
            profile: "coding",
            sessionsVisibility: "agent" as const,
            webFetchEnabled: false,
            webSearchEnabled: true,
            webSearchProvider: "brave",
        };

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            confirmation: "apply-reviewed-settings",
            update: { section: "tools", settings },
        });

        const rawPatch = JSON.parse(String(fixture.calls[1]?.parameters.raw)) as {
            readonly tools: { readonly sessions: unknown };
        };
        expect(rawPatch.tools.sessions).toEqual({ visibility: "agent" });
        expect(result.configuration.tools).toEqual(settings);
        expect(result.configuration.hash).toBe(nextHash);
    });

    test("patches one editable agent tool override while preserving unknown policy entries", async () => {
        const acknowledged = structuredClone(configGetFixture(nextHash)) as {
            config: {
                agents: {
                    entries: {
                        main: {
                            tools: { alsoAllow: string[]; deny: string[] };
                        };
                    };
                };
            };
        };
        acknowledged.config.agents.entries.main.tools.alsoAllow.push("web_fetch");
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    payload: {
                        config: acknowledged.config,
                        hash: nextHash,
                        ok: true,
                        sentinel: {
                            payload: { stats: { requiresRestart: true } },
                            persisted: true,
                        },
                    },
                },
            ],
        });

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            confirmation: "apply-reviewed-settings",
            update: {
                agentId: "main",
                override: "allow",
                section: "agent-tool-access",
                toolId: "web_fetch",
            },
        });

        const write = fixture.calls[1];
        expect(write?.parameters.replacePaths).toEqual([
            "agents.entries.main.tools.alsoAllow",
            "agents.entries.main.tools.deny",
        ]);
        expect(JSON.parse(String(write?.parameters.raw))).toEqual({
            agents: {
                entries: {
                    main: {
                        tools: {
                            alsoAllow: ["cron", "custom-provider-tool", "web_fetch"],
                            deny: ["web_search", "custom-denied-tool"],
                        },
                    },
                },
            },
        });
        expect(
            result.configuration.agentAccess[0]?.tools.find(
                ({ id }) => id === "web_fetch"
            )
        ).toEqual({ editable: true, id: "web_fetch", override: "allow" });
        expect(JSON.stringify(result)).not.toContain(hiddenValue);
    });

    test("rejects an unexpected config.patch noop without the requested readback", async () => {
        const current = configGetFixture() as { config: unknown };
        const fixture = createFixtureTransport({
            reads: [{ payload: current }],
            writes: [{ payload: { config: current.config, noop: true, ok: true } }],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        agentId: "main",
                        override: "allow",
                        section: "agent-tool-access",
                        toolId: "web_fetch",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
        expect(fixture.calls.filter(({ lane }) => lane === "write")).toHaveLength(1);
    });

    test("atomically fences skill toggles with an exact config.patch readback", async () => {
        const acknowledgement = configGetFixtureWithSkill(false, nextHash) as {
            config: unknown;
        };
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
            writes: [
                {
                    payload: {
                        config: acknowledgement.config,
                        hash: nextHash,
                        ok: true,
                        sentinel: {
                            payload: { stats: { requiresRestart: true } },
                            persisted: true,
                        },
                    },
                },
            ],
        });
        const provider = createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        );

        expect(
            await provider.setSkillEnabled({
                authorizeDispatch,
                baseHash: currentHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.calls.map(({ lane, method }) => `${lane}:${method}`)).toEqual([
            "read:config.get",
            "read:skills.status",
            "write:config.patch",
        ]);
        expect(fixture.calls[2]?.parameters).toMatchObject({
            baseHash: currentHash,
            note: "Updated from Mira Dashboard settings",
        });
        expect(JSON.parse(String(fixture.calls[2]?.parameters.raw))).toEqual({
            skills: { entries: { imagegen: { enabled: false } } },
        });
        expect(JSON.stringify(acknowledgement.config)).toContain(hiddenValue);
    });

    test("allows a bounded config-only skill toggle through the same CAS patch", async () => {
        const acknowledgement = configGetFixtureWithSkill(
            true,
            nextHash,
            "config-only"
        ) as { config: unknown };
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
            writes: [
                {
                    payload: {
                        config: acknowledgement.config,
                        hash: nextHash,
                        ok: true,
                        sentinel: {
                            payload: { stats: { requiresRestart: false } },
                            persisted: true,
                        },
                    },
                },
            ],
        });

        expect(
            await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).setSkillEnabled({
                authorizeDispatch,
                baseHash: currentHash,
                enabled: true,
                skillKey: "config-only",
            })
        ).toEqual({ enabled: true, skillKey: "config-only" });
        expect(JSON.parse(String(fixture.calls[2]?.parameters.raw))).toEqual({
            skills: { entries: { "config-only": { enabled: true } } },
        });
    });

    test("returns an installed skill no-op without opening a write lane", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
        });

        expect(
            await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).setSkillEnabled({
                authorizeDispatch,
                baseHash: currentHash,
                enabled: true,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: true, skillKey: "imagegen" });
        expect(fixture.calls.map(({ lane }) => lane)).toEqual(["read", "read"]);
    });

    test("reconciles one uncertain skill write exactly once without replaying it", async () => {
        const fixture = createFixtureTransport({
            reads: [
                { payload: configGetFixture() },
                { payload: skillsFixture() },
                { payload: configGetFixtureWithSkill(false, nextHash) },
            ],
            writes: [{ rejection: new PersistentGatewayUnknownOutcomeError() }],
        });

        expect(
            await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).setSkillEnabled({
                authorizeDispatch,
                baseHash: currentHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.calls.filter(({ lane }) => lane === "write")).toHaveLength(1);
        expect(fixture.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "skills.status",
            "config.patch",
            "config.get",
        ]);
    });

    test("keeps an inconclusive skill patch unknown without replaying it", async () => {
        const fixture = createFixtureTransport({
            reads: [
                { payload: configGetFixture() },
                { payload: skillsFixture() },
                { payload: configGetFixture() },
            ],
            writes: [{ rejection: new PersistentGatewayUnknownOutcomeError() }],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).setSkillEnabled({
                    authorizeDispatch,
                    baseHash: currentHash,
                    enabled: false,
                    skillKey: "imagegen",
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
        expect(fixture.calls.filter(({ lane }) => lane === "write")).toHaveLength(1);
        expect(fixture.calls.at(-1)?.method).toBe("config.get");
    });

    test("rejects stale hashes and missing installed skills before dispatch", async () => {
        const stale = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });
        const staleProvider = createPersistentGatewayOpenClawSettingsProvider(
            stale.transport
        );
        expect(
            await captureFailure(() =>
                staleProvider.updateConfiguration({
                    authorizeDispatch,
                    baseHash: "c".repeat(64),
                    confirmation: "apply-reviewed-settings",
                    update: {
                        idleMinutes: 60,
                        section: "session-reset",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("conflict"));
        expect(stale.calls).toHaveLength(1);

        const missing = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
        });
        const missingProvider = createPersistentGatewayOpenClawSettingsProvider(
            missing.transport
        );
        expect(
            await captureFailure(() =>
                missingProvider.setSkillEnabled({
                    authorizeDispatch,
                    baseHash: currentHash,
                    enabled: true,
                    skillKey: "not-installed",
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("not-found"));
        expect(missing.calls.every(({ lane }) => lane === "read")).toBe(true);
    });

    test("rejects controls on invalid config and mismatched channel identity sets", async () => {
        const invalid = createFixtureTransport({
            reads: [
                {
                    payload: { ...(configGetFixture() as object), valid: false },
                },
            ],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    invalid.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, section: "session-reset" },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(invalid.calls).toHaveLength(1);

        const channels = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    channels.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        channels: [{ enabled: false, id: "discord" }],
                        section: "channels",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(channels.calls).toHaveLength(1);
    });

    test("preserves a pre-dispatch authorization failure after provider preflight", async () => {
        const authorizationFailure = new Error("recent MFA expired");
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    payload: {
                        config: {},
                        hash: nextHash,
                        ok: true,
                    },
                },
            ],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch: () => Promise.reject(authorizationFailure),
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, section: "session-reset" },
                })
            )
        ).toBe(authorizationFailure);
        expect(fixture.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "config.patch",
        ]);
    });

    test("maps sanitized conflicts and post-dispatch uncertainty without raw errors", async () => {
        const conflict = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    rejection: new PersistentGatewayRequestError({
                        code: "INVALID_REQUEST",
                        reason: persistentGatewayConfigurationChangedReason,
                    }),
                },
            ],
        });
        const conflictProvider = createPersistentGatewayOpenClawSettingsProvider(
            conflict.transport
        );
        const update = {
            authorizeDispatch,
            baseHash: currentHash,
            confirmation: "apply-reviewed-settings" as const,
            update: { idleMinutes: 60, section: "session-reset" as const },
        };
        expect(
            await captureFailure(() => conflictProvider.updateConfiguration(update))
        ).toEqual(new OpenClawSettingsProviderError("conflict"));

        const uncertain = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [{ rejection: new PersistentGatewayUnknownOutcomeError() }],
        });
        const uncertainProvider = createPersistentGatewayOpenClawSettingsProvider(
            uncertain.transport
        );
        const error = await captureFailure(() =>
            uncertainProvider.updateConfiguration(update)
        );
        expect(error).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
        expect(JSON.stringify(error)).not.toContain(hiddenValue);
    });

    test("fails closed on missing or over-budget authenticated byte observations", async () => {
        const missingBytes = createFixtureTransport({
            reads: [{ bytes: 0, payload: configGetFixture() }],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    missingBytes.transport
                ).getConfiguration({})
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));

        const oversizedWrite = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    bytes: 2 * 1024 * 1024 + 1,
                    payload: {
                        config: {},
                        hash: nextHash,
                        ok: true,
                        sentinel: {
                            payload: { stats: { requiresRestart: false } },
                            persisted: true,
                        },
                    },
                },
            ],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    oversizedWrite.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, section: "session-reset" },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
    });
});
