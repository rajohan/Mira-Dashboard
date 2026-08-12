import { describe, expect, test } from "bun:test";

import { openClawReviewedAgentToolIds } from "../../../contracts/openClawSettings.ts";
import { OpenClawSettingsProviderError } from "../../domains/openClawSettings/provider.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createPersistentGatewayOpenClawSettingsProvider,
    type PersistentGatewayOpenClawSettingsTransport,
} from "./persistentGatewayOpenClawSettingsProvider.ts";
import {
    assertPersistentGatewayOpenClawSettingsWriteParameters,
    persistentGatewayOpenClawSettingsPatchMaximumBytes,
    type PersistentGatewayOpenClawSettingsReadMethod,
    type PersistentGatewayOpenClawSettingsWriteMethod,
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
const currentRevisionHash = `${"C".repeat(42)}A`;
const nextRevisionHash = `${"D".repeat(42)}E`;
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
    readonly consumePredispatchRead?: boolean;
    readonly reads?: readonly FixtureResponse[];
    readonly writes?: readonly FixtureResponse[];
}): Readonly<{
    calls: FixtureCall[];
    dispatchedWrites: FixtureCall[];
    transport: PersistentGatewayOpenClawSettingsTransport;
}> {
    const calls: FixtureCall[] = [];
    const dispatchedWrites: FixtureCall[] = [];
    const reads = [...(input.reads ?? [])];
    const writes = [...(input.writes ?? [])];
    let beforeDispatchPending = false;
    let lastConfigResponse: unknown;
    let lastWrite:
        | Readonly<{
              method: PersistentGatewayOpenClawSettingsWriteMethod;
              parameters: Readonly<Record<string, unknown>>;
              payload: unknown;
          }>
        | undefined;
    let postWriteReadPending = false;
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
    const derivedPostWriteRead = (): FixtureResponse | undefined => {
        if (lastConfigResponse === undefined || lastWrite === undefined) return undefined;
        const response = structuredClone(lastConfigResponse) as Record<string, unknown>;
        if (lastWrite.method === "config.patch") {
            const acknowledgement = lastWrite.payload as {
                config?: unknown;
                hash?: unknown;
                noop?: unknown;
            };
            if (acknowledgement.config !== undefined) {
                response.config = acknowledgement.config;
                response.parsed = acknowledgement.config;
                response.sourceConfig = acknowledgement.config;
            }
            if (typeof acknowledgement.hash === "string") {
                response.hash = acknowledgement.hash;
                response.configRevisionHash = nextRevisionHash;
            } else if (acknowledgement.noop !== true) {
                return undefined;
            }
        } else {
            const enabled = lastWrite.parameters.enabled;
            const skillKey = lastWrite.parameters.skillKey;
            if (typeof enabled !== "boolean" || typeof skillKey !== "string") {
                return undefined;
            }
            for (const field of ["config", "parsed", "sourceConfig"] as const) {
                const configuration = response[field] as {
                    skills?: { entries?: Record<string, { enabled?: boolean }> };
                };
                const entries = configuration.skills?.entries;
                if (entries === undefined) return undefined;
                entries[skillKey] = { ...entries[skillKey], enabled };
            }
            response.hash = nextHash;
            response.configRevisionHash = nextRevisionHash;
        }
        lastConfigResponse = response;
        return { payload: response };
    };
    return {
        calls,
        dispatchedWrites,
        transport: {
            requestOpenClawSettingsRead(method, parameters, options) {
                calls.push({ lane: "read", method, options, parameters });
                if (
                    method === "config.get" &&
                    beforeDispatchPending &&
                    input.consumePredispatchRead !== true
                ) {
                    return settle({ payload: lastConfigResponse }, options);
                }
                let response: FixtureResponse | undefined;
                if (method === "config.get" && postWriteReadPending) {
                    postWriteReadPending = false;
                    response = reads.shift() ?? derivedPostWriteRead();
                } else {
                    response = reads.shift();
                }
                if (method === "config.get" && response?.payload !== undefined) {
                    lastConfigResponse = response.payload;
                }
                return settle(response, options);
            },
            async requestOpenClawSettingsWrite(method, parameters, options) {
                assertPersistentGatewayOpenClawSettingsWriteParameters(
                    method,
                    parameters
                );
                const call = { lane: "write" as const, method, options, parameters };
                calls.push(call);
                beforeDispatchPending = true;
                try {
                    await options.beforeDispatch();
                } finally {
                    beforeDispatchPending = false;
                }
                dispatchedWrites.push(call);
                const response = writes.shift();
                try {
                    const payload = await settle(response, options);
                    lastWrite = { method, parameters, payload };
                    postWriteReadPending = true;
                    return payload;
                } catch (error) {
                    if (error instanceof PersistentGatewayUnknownOutcomeError) {
                        lastWrite = { method, parameters, payload: undefined };
                        postWriteReadPending = true;
                    }
                    throw error;
                }
            },
        },
    };
}

function configGetFixture(hash = currentHash): unknown {
    const config = {
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
        session: { reset: { idleMinutes: 45, mode: "idle" } },
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
    };
    return {
        config,
        configRevisionHash: hash === currentHash ? currentRevisionHash : nextRevisionHash,
        hash,
        includedPaths: [],
        issues: [{ message: hiddenValue, path: hiddenValue }],
        legacyIssues: [],
        parsed: config,
        path: `/home/fixture/${hiddenValue}/openclaw.json`,
        raw: hiddenValue,
        sourceConfig: config,
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
            channelsTruncated: false,
            hash: currentHash,
            heartbeat: { everySeconds: 5400, target: "discord" },
            includesPresent: false,
            issueCount: 1,
            lastTouchedAt: "2026-08-11T10:00:00.000Z",
            lastTouchedVersion: "2026.7.2-beta.7",
            models: {
                fallbacks: ["openai/gpt-5.6-terra"],
                primary: "openai/gpt-5.6-sol",
            },
            modelNormalizationState: "clean",
            revisionHash: currentRevisionHash,
            security: {
                authProfileCount: 2,
                commandRestartEnabled: false,
                ownerAllowFromCount: 2,
                redactionMode: "tools",
            },
            sessionReset: {
                idleMinutes: 45,
                mode: "idle",
                state: "explicit-idle",
            },
            tools: {
                agentToAgentEnabled: true,
                elevatedEnabled: false,
                execPolicy: { mode: "ask", state: "legacy-mode" },
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

    test("uses audited tool defaults without inventing an exec policy", async () => {
        const emptyConfiguration = structuredClone(configGetFixture()) as Record<
            string,
            unknown
        >;
        emptyConfiguration.config = {};
        emptyConfiguration.parsed = {};
        emptyConfiguration.sourceConfig = {};
        const fixture = createFixtureTransport({
            reads: [{ payload: emptyConfiguration }],
        });

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).getConfiguration({});

        expect(result.tools.elevatedEnabled).toBe(true);
        expect(result.tools.execPolicy).toEqual({ state: "inherited" });
    });

    test("projects the complete source-derived session reset state matrix", async () => {
        const cases = [
            [undefined, { state: "inherited-none" }],
            [{}, { state: "implicit-daily" }],
            [{ mode: "daily" }, { mode: "daily", state: "locked-mode" }],
            [{ mode: "none" }, { mode: "none", state: "locked-mode" }],
            [
                { idleMinutes: 45, mode: "idle" },
                { idleMinutes: 45, mode: "idle", state: "explicit-idle" },
            ],
            [{ mode: "idle" }, { state: "partial-idle" }],
            [{ idleMinutes: 10_081, mode: "idle" }, { state: "partial-idle" }],
        ] as const;

        for (const [reset, expected] of cases) {
            const response = structuredClone(configGetFixture()) as {
                config: { session?: { reset?: unknown } };
                parsed: { session?: { reset?: unknown } };
                sourceConfig: { session?: { reset?: unknown } };
            };
            for (const configuration of [
                response.config,
                response.parsed,
                response.sourceConfig,
            ]) {
                if (reset === undefined) {
                    delete configuration.session;
                } else {
                    configuration.session = { reset: structuredClone(reset) };
                }
            }
            const result = await createPersistentGatewayOpenClawSettingsProvider(
                createFixtureTransport({ reads: [{ payload: response }] }).transport
            ).getConfiguration({});
            expect(result.sessionReset).toEqual(expected);
        }
    });

    test("projects include and model-normalization locks without exposing source data", async () => {
        const included = structuredClone(configGetFixture()) as {
            includedPaths: string[];
        };
        included.includedPaths = [`/home/fixture/${hiddenValue}/included.json5`];

        const pending = structuredClone(configGetFixture()) as {
            config: { agents: { entries: { main: Record<string, unknown> } } };
            parsed: unknown;
            sourceConfig: unknown;
        };
        pending.config.agents.entries.main.heartbeat = {
            model: "google/gemini-3-pro",
        };
        pending.parsed = structuredClone(pending.config);
        pending.sourceConfig = structuredClone(pending.config);

        const unknown = structuredClone(configGetFixture()) as {
            config: { agents: { entries: { main: Record<string, unknown> } } };
            parsed: { agents: { entries: { main: Record<string, unknown> } } };
            sourceConfig: unknown;
        };
        unknown.parsed = structuredClone(unknown.config);
        unknown.parsed.agents.entries.main.heartbeat = { model: "${MODEL}" };
        unknown.sourceConfig = structuredClone(unknown.config);

        for (const [response, expected] of [
            [included, { includesPresent: true, modelNormalizationState: "clean" }],
            [pending, { includesPresent: false, modelNormalizationState: "pending" }],
            [unknown, { includesPresent: false, modelNormalizationState: "unknown" }],
        ] as const) {
            const result = await createPersistentGatewayOpenClawSettingsProvider(
                createFixtureTransport({ reads: [{ payload: response }] }).transport
            ).getConfiguration({});
            expect(result).toMatchObject(expected);
            expect(JSON.stringify(result)).not.toContain(hiddenValue);
            expect(JSON.stringify(result)).not.toContain("${MODEL}");
        }
    });

    test("blocks unsafe config patches before authorization while preserving reads", async () => {
        const responses: unknown[] = [];
        const included = structuredClone(configGetFixture()) as {
            includedPaths: string[];
        };
        included.includedPaths = ["/home/fixture/include.json5"];
        responses.push(included);

        const pending = structuredClone(configGetFixture()) as {
            config: { agents: { entries: { main: Record<string, unknown> } } };
            parsed: unknown;
            sourceConfig: unknown;
        };
        pending.config.agents.entries.main.heartbeat = {
            model: "google/gemini-3-pro",
        };
        pending.parsed = structuredClone(pending.config);
        pending.sourceConfig = structuredClone(pending.config);
        responses.push(pending);

        for (const response of responses) {
            let authorizationCount = 0;
            const fixture = createFixtureTransport({
                reads: [{ payload: response }, { payload: response }],
            });
            const provider = createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            );
            const configuration = await provider.getConfiguration({});
            expect(configuration.valid).toBe(true);
            expect(
                await captureFailure(() =>
                    provider.updateConfiguration({
                        authorizeDispatch: () => {
                            authorizationCount += 1;
                            return Promise.resolve();
                        },
                        baseHash: currentHash,
                        baseRevisionHash: currentRevisionHash,
                        confirmation: "apply-reviewed-settings",
                        update: {
                            idleMinutes: 60,
                            mode: "idle",
                            section: "session-reset",
                        },
                    })
                )
            ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
            expect(authorizationCount).toBe(0);
            expect(fixture.dispatchedWrites).toHaveLength(0);
        }
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

        const mixedCase = structuredClone(configGetFixture()) as {
            config: {
                agents: {
                    entries: Record<string, Record<string, unknown>>;
                };
            };
        };
        const mainEntry = mixedCase.config.agents.entries.main;
        if (mainEntry === undefined) throw new Error("Expected main agent fixture");
        delete mixedCase.config.agents.entries.main;
        mixedCase.config.agents.entries.Main = mainEntry;
        mixedCase.config.agents.entries._ops = {
            default: false,
            name: "Operations",
        };
        const mixedCaseResult = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({ reads: [{ payload: mixedCase }] }).transport
        ).getConfiguration({});
        expect(mixedCaseResult.agentAccess.map(({ id }) => id).toSorted()).toEqual([
            "Main",
            "_ops",
        ]);
        expect(mixedCaseResult.agentAccessTruncated).toBe(false);
        expect(
            mixedCaseResult.agentAccess.every(({ tools }) =>
                tools.every(({ editable }) => editable)
            )
        ).toBe(true);

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
        expect(ambiguousResult.agentAccessTruncated).toBe(false);
        expect(ambiguousResult.agentAccess.map(({ id }) => id).toSorted()).toEqual([
            "Main",
            "main",
        ]);
        expect(
            ambiguousResult.agentAccess.every(({ tools }) =>
                tools.every(({ editable }) => !editable)
            )
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
                    baseRevisionHash: currentRevisionHash,
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

    test("omits invalid optional agent names without dropping configuration rows", async () => {
        for (const name of ["", "   ", "x".repeat(65)]) {
            const response = structuredClone(configGetFixture()) as {
                config: {
                    agents: {
                        entries: { main: { name?: string } };
                    };
                };
            };
            response.config.agents.entries.main.name = name;

            const result = await createPersistentGatewayOpenClawSettingsProvider(
                createFixtureTransport({ reads: [{ payload: response }] }).transport
            ).getConfiguration({});

            expect(result.agentAccess).toHaveLength(1);
            expect(result.agentAccess[0]).toMatchObject({ id: "main" });
            expect(result.agentAccess[0]).not.toHaveProperty("name");
            expect(result.agentAccessTruncated).toBe(false);
        }
    });

    test("keeps implicit-on channels enabled and patches only the changed provider", async () => {
        const current = structuredClone(configGetFixture()) as {
            config: {
                channels: Record<string, Record<string, unknown>>;
            };
        };
        current.config.channels = {
            constructor: {},
            defaults: { groupPolicy: "allowlist" },
            discord: {},
            modelByChannel: { discord: "openai/gpt-5.6" },
            prototype: {},
            telegram: {},
        };
        const acknowledged = structuredClone(current);
        acknowledged.config.channels.discord = { enabled: false };
        const fixture = createFixtureTransport({
            reads: [{ payload: current }, { payload: current }],
            writes: [
                {
                    payload: {
                        config: acknowledged.config,
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
        const provider = createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        );

        const projected = await provider.getConfiguration({});
        expect(projected.channels).toEqual([
            { enabled: true, id: "discord" },
            { enabled: true, id: "telegram" },
        ]);
        expect(projected.channelsTruncated).toBe(true);

        const result = await provider.updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                channels: [
                    { enabled: false, id: "discord" },
                    { enabled: true, id: "telegram" },
                ],
                section: "channels",
            },
        });

        expect(JSON.parse(String(fixture.calls[2]?.parameters.raw))).toEqual({
            channels: { discord: { enabled: false } },
        });
        expect(result.configuration.channels).toEqual([
            { enabled: false, id: "discord" },
            { enabled: true, id: "telegram" },
        ]);
        expect(result.restartRequired).toBe(false);
        expect(result.restartScheduled).toBe(false);
    });

    test("emits every valid heartbeat leaf delta including an explicit target clear", async () => {
        const cases = [
            {
                expectedHeartbeat: { everySeconds: 3600, target: "discord" },
                expectedRaw: {
                    agents: { defaults: { heartbeat: { every: "3600s" } } },
                },
                update: { everySeconds: 3600, target: "discord" },
            },
            {
                expectedHeartbeat: { everySeconds: 5400, target: "telegram" },
                expectedRaw: {
                    agents: { defaults: { heartbeat: { target: "telegram" } } },
                },
                update: { everySeconds: 5400, target: "telegram" },
            },
            {
                expectedHeartbeat: { everySeconds: 5400 },
                expectedRaw: {
                    agents: { defaults: { heartbeat: { target: null } } },
                },
                update: { everySeconds: 5400, target: null },
            },
            {
                expectedHeartbeat: { everySeconds: 3600, target: "telegram" },
                expectedRaw: {
                    agents: {
                        defaults: {
                            heartbeat: { every: "3600s", target: "telegram" },
                        },
                    },
                },
                update: { everySeconds: 3600, target: "telegram" },
            },
        ] as const;

        for (const testCase of cases) {
            const acknowledgedConfig = structuredClone(
                (configGetFixture() as { config: Record<string, unknown> }).config
            ) as {
                agents: {
                    defaults: {
                        heartbeat: { every: string; target?: string };
                    };
                };
            };
            acknowledgedConfig.agents.defaults.heartbeat.every = `${testCase.update.everySeconds}s`;
            if (testCase.update.target === null) {
                delete acknowledgedConfig.agents.defaults.heartbeat.target;
            } else {
                acknowledgedConfig.agents.defaults.heartbeat.target =
                    testCase.update.target;
            }
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

            const result = await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).updateConfiguration({
                authorizeDispatch,
                baseHash: currentHash,
                baseRevisionHash: currentRevisionHash,
                confirmation: "apply-reviewed-settings",
                update: { section: "heartbeat", ...testCase.update },
            });

            const write = fixture.calls.find(({ lane }) => lane === "write");
            expect(JSON.parse(String(write?.parameters.raw))).toEqual(
                testCase.expectedRaw
            );
            expect(write?.parameters).not.toHaveProperty("replacePaths");
            expect(result.configuration.heartbeat).toEqual(testCase.expectedHeartbeat);
        }
    });

    test("emits the complete explicit-idle session reset delta", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as { session: { reset: { idleMinutes: number; mode: string } } };
        acknowledgedConfig.session.reset = { idleMinutes: 60, mode: "idle" };
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: { idleMinutes: 60, mode: "idle", section: "session-reset" },
        });

        const write = fixture.calls.find(({ lane }) => lane === "write");
        expect(JSON.parse(String(write?.parameters.raw))).toEqual({
            session: { reset: { idleMinutes: 60, mode: "idle" } },
        });
        expect(write?.parameters).not.toHaveProperty("replacePaths");
        expect(result.configuration.sessionReset).toEqual({
            idleMinutes: 60,
            mode: "idle",
            state: "explicit-idle",
        });
    });

    test("rejects an unchanged explicit-idle session reset before dispatch", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        idleMinutes: 45,
                        mode: "idle",
                        section: "session-reset",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]?.lane).toBe("read");
    });

    test("retains only the ordered bounded channel prefix", async () => {
        const response = structuredClone(configGetFixture()) as {
            config: { channels: Record<string, { enabled?: boolean }> };
        };
        response.config.channels = Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
                `channel-${index.toString().padStart(2, "0")}`,
                { enabled: index % 2 === 0 },
            ])
        );

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({ reads: [{ payload: response }] }).transport
        ).getConfiguration({});

        expect(result.channels).toHaveLength(64);
        expect(result.channelsTruncated).toBe(true);
        expect(result.channels[0]?.id).toBe("channel-00");
        expect(result.channels.at(-1)?.id).toBe("channel-63");
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

    test("projects the audited skill-source taxonomy and quarantines future sources", async () => {
        const configuration = structuredClone(configGetFixture()) as {
            config: {
                skills: { entries: Record<string, { enabled: boolean }> };
            };
        };
        configuration.config.skills.entries["future-source"] = { enabled: false };
        configuration.config.skills.entries["constructor"] = { enabled: false };
        configuration.config.skills.entries.PROTOTYPE = { enabled: false };
        configuration.config.skills.entries["My Skill"] = { enabled: false };
        configuration.config.skills.entries["技能"] = { enabled: false };
        const sourceRows = [
            ["personal", "agents-skills-personal", false],
            ["project", "agents-skills-project", false],
            ["bundled", "openclaw-bundled", true],
            ["extra", "openclaw-extra", false],
            ["managed", "openclaw-managed", false],
            ["node", "openclaw-node", false],
            ["workspace", "openclaw-workspace", false],
            ["unknown-bundled", "unknown", true],
            ["unknown-other", "unknown", false],
            ["future-source", "future-provider-source", false],
            ["constructor", "openclaw-managed", false],
            ["PROTOTYPE", "openclaw-managed", false],
            ["My Skill", "openclaw-managed", false],
            ["技能", "openclaw-managed", false],
        ] as const;
        const result = await createPersistentGatewayOpenClawSettingsProvider(
            createFixtureTransport({
                reads: [
                    { payload: configuration },
                    {
                        payload: {
                            skills: sourceRows.map(([skillKey, source, bundled]) => ({
                                bundled,
                                disabled: false,
                                eligible: true,
                                name: skillKey,
                                skillKey,
                                source,
                            })),
                        },
                    },
                ],
            }).transport
        ).listSkills({});

        expect(
            Object.fromEntries(
                result.skills
                    .filter(({ key }) =>
                        sourceRows.some(([sourceKey]) => sourceKey === key)
                    )
                    .map(({ bundled, key, source }) => [key, { bundled, source }])
            )
        ).toEqual({
            bundled: { bundled: true, source: "openclaw-bundled" },
            extra: { bundled: false, source: "openclaw-extra" },
            managed: { bundled: false, source: "openclaw-managed" },
            node: { bundled: false, source: "openclaw-node" },
            personal: { bundled: false, source: "agents-skills-personal" },
            project: { bundled: false, source: "agents-skills-project" },
            "unknown-bundled": {
                bundled: true,
                source: "openclaw-unknown",
            },
            "unknown-other": {
                bundled: false,
                source: "openclaw-unknown",
            },
            workspace: { bundled: false, source: "openclaw-workspace" },
        });
        expect(result.skills.some(({ key }) => key === "future-source")).toBe(false);
        expect(result.skills.some(({ key }) => key === "constructor")).toBe(false);
        expect(result.skills.some(({ key }) => key === "PROTOTYPE")).toBe(false);
        expect(result.skills.some(({ key }) => key === "My Skill")).toBe(false);
        expect(result.skills.some(({ key }) => key === "技能")).toBe(false);
        expect(result.truncated).toBe(true);
    });

    test("fails closed on over-budget or control-bearing upstream skill keys", async () => {
        for (const skillKey of ["x".repeat(129), "control\u0007key"]) {
            const fixture = createFixtureTransport({
                reads: [
                    { payload: configGetFixture() },
                    {
                        payload: {
                            skills: [
                                {
                                    bundled: false,
                                    disabled: false,
                                    eligible: true,
                                    name: "Invalid upstream key",
                                    skillKey,
                                    source: "openclaw-managed",
                                },
                            ],
                        },
                    },
                ],
            });

            expect(
                await captureFailure(() =>
                    createPersistentGatewayOpenClawSettingsProvider(
                        fixture.transport
                    ).listSkills({})
                )
            ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        }
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
            baseRevisionHash: currentRevisionHash,
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

    test("canonicalizes pinned model aliases before patch and acknowledgement", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as {
            agents: { defaults: { model: Record<string, unknown> } };
        };
        acknowledgedConfig.agents.defaults.model = {
            fallbacks: ["together/moonshotai/Kimi-K2.6", "google/gemini-3-flash-preview"],
            primary: "google/gemini-3.1-pro-preview",
        };
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                fallbacks: ["together/moonshotai/Kimi-K2.5", "google/gemini-3.1-flash"],
                primary: "google/gemini-3-pro",
                section: "models",
            },
        });

        expect(JSON.parse(String(fixture.calls[1]?.parameters.raw))).toEqual({
            agents: {
                defaults: {
                    model: {
                        fallbacks: [
                            "together/moonshotai/Kimi-K2.6",
                            "google/gemini-3-flash-preview",
                        ],
                        primary: "google/gemini-3.1-pro-preview",
                    },
                },
            },
        });
        expect(result.configuration.models).toEqual({
            fallbacks: ["together/moonshotai/Kimi-K2.6", "google/gemini-3-flash-preview"],
            primary: "google/gemini-3.1-pro-preview",
        });
    });

    test("mirrors every pinned provider, nested, and case-sensitive model alias", async () => {
        const cases = [
            ["google/gemini-3-pro", "google/gemini-3.1-pro-preview"],
            [
                "google-gemini-cli/gemini-3-pro-preview",
                "google-gemini-cli/gemini-3.1-pro-preview",
            ],
            ["google-vertex/gemini-3.1-pro", "google-vertex/gemini-3.1-pro-preview"],
            ["google/gemini-3-flash", "google/gemini-3-flash-preview"],
            ["google/gemini-3.1-flash", "google/gemini-3-flash-preview"],
            ["google/gemini-3.1-flash-preview", "google/gemini-3-flash-preview"],
            ["google/gemini-3.1-flash-lite-preview", "google/gemini-3.1-flash-lite"],
            ["google/gemma-4-26b", "google/gemma-4-26b-a4b-it"],
            ["custom/google/gemini-3-pro", "custom/google/gemini-3.1-pro-preview"],
            ["together/moonshotai/Kimi-K2.5", "together/moonshotai/Kimi-K2.6"],
            ["together/moonshotai/kimi-K2.5", "together/moonshotai/kimi-K2.5"],
        ] as const;

        for (const [submitted, persisted] of cases) {
            const acknowledged = structuredClone(
                (configGetFixture() as { config: Record<string, unknown> }).config
            ) as { agents: { defaults: { model: Record<string, unknown> } } };
            acknowledged.agents.defaults.model.primary = persisted;
            const fixture = createFixtureTransport({
                reads: [{ payload: configGetFixture() }],
                writes: [
                    {
                        payload: {
                            config: acknowledged,
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

            await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).updateConfiguration({
                authorizeDispatch,
                baseHash: currentHash,
                baseRevisionHash: currentRevisionHash,
                confirmation: "apply-reviewed-settings",
                update: {
                    fallbacks: ["openai/gpt-5.6-terra"],
                    primary: submitted,
                    section: "models",
                },
            });

            expect(JSON.parse(String(fixture.calls[1]?.parameters.raw))).toEqual({
                agents: { defaults: { model: { primary: persisted } } },
            });
        }
    });

    test("preserves a scalar primary when adding the first fallback list", async () => {
        const current = structuredClone(configGetFixture()) as {
            config: { agents: { defaults: { model: unknown } } };
            parsed: { agents: { defaults: { model: unknown } } };
            sourceConfig: { agents: { defaults: { model: unknown } } };
        };
        for (const configuration of [
            current.config,
            current.parsed,
            current.sourceConfig,
        ]) {
            configuration.agents.defaults.model = "openai/gpt-5.6-sol";
        }
        const acknowledged = structuredClone(current.config);
        acknowledged.agents.defaults.model = {
            fallbacks: ["openai/gpt-5.6-terra"],
            primary: "openai/gpt-5.6-sol",
        };
        const fixture = createFixtureTransport({
            reads: [{ payload: current }],
            writes: [
                {
                    payload: {
                        config: acknowledged,
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                fallbacks: ["openai/gpt-5.6-terra"],
                primary: "openai/gpt-5.6-sol",
                section: "models",
            },
        });

        expect(JSON.parse(String(fixture.calls[1]?.parameters.raw))).toEqual({
            agents: {
                defaults: {
                    model: {
                        fallbacks: ["openai/gpt-5.6-terra"],
                        primary: "openai/gpt-5.6-sol",
                    },
                },
            },
        });
        expect(result.configuration.models).toEqual({
            fallbacks: ["openai/gpt-5.6-terra"],
            primary: "openai/gpt-5.6-sol",
        });
    });

    test("rejects model fallbacks that collide after pinned canonicalization", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        fallbacks: [
                            "google/gemini-3-pro",
                            "google/gemini-3.1-pro-preview",
                        ],
                        primary: "openai/gpt-5.6-sol",
                        section: "models",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls).toHaveLength(1);
    });

    test("rejects canonicalized model refs that expand beyond the contract budget", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });
        const expandingAlias = `x/${"google/".repeat(26)}gemini-3-pro`;
        expect(expandingAlias.length).toBeLessThanOrEqual(200);

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        fallbacks: ["openai/gpt-5.6-terra"],
                        primary: expandingAlias,
                        section: "models",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls.map(({ method }) => method)).toEqual(["config.get"]);
        expect(fixture.dispatchedWrites).toHaveLength(0);
    });

    test("patches only changed tool leaves and preserves legacy exec mode", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as {
            tools: { sessions: { visibility: string } };
        };
        acknowledgedConfig.tools.sessions.visibility = "tree";
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
            execPolicy: { mode: "ask" as const, state: "legacy-mode" as const },
            profile: "coding",
            sessionsVisibility: "tree" as const,
            webFetchEnabled: false,
            webSearchEnabled: true,
            webSearchProvider: "brave",
        };

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: { section: "tools", settings },
        });

        const rawPatch = JSON.parse(String(fixture.calls[1]?.parameters.raw)) as {
            readonly tools: { readonly sessions: unknown };
        };
        expect(rawPatch).toEqual({ tools: { sessions: { visibility: "tree" } } });
        expect(result.configuration.tools).toEqual(settings);
        expect(result.configuration.hash).toBe(nextHash);
    });

    test("preserves inherited elevated and legacy auto exec on unrelated writes", async () => {
        const current = structuredClone(configGetFixture()) as {
            config: {
                tools: {
                    elevated?: { enabled?: boolean };
                    exec: { mode: string };
                    web: { fetch: { enabled: boolean } };
                };
            };
        };
        delete current.config.tools.elevated;
        current.config.tools.exec = { mode: "auto" };
        const acknowledged = structuredClone(current);
        acknowledged.config.tools.web.fetch.enabled = true;
        const fixture = createFixtureTransport({
            reads: [{ payload: current }],
            writes: [
                {
                    payload: {
                        config: acknowledged.config,
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                section: "tools",
                settings: {
                    agentToAgentEnabled: true,
                    elevatedEnabled: true,
                    execPolicy: { mode: "auto", state: "legacy-mode" },
                    profile: "coding",
                    sessionsVisibility: "agent",
                    webFetchEnabled: true,
                    webSearchEnabled: true,
                    webSearchProvider: "brave",
                },
            },
        });

        expect(JSON.parse(String(fixture.calls[1]?.parameters.raw))).toEqual({
            tools: { web: { fetch: { enabled: true } } },
        });
        expect(result.configuration.tools).toMatchObject({
            elevatedEnabled: true,
            execPolicy: { mode: "auto", state: "legacy-mode" },
            webFetchEnabled: true,
        });
    });

    test("patches both leaves of a fresh explicit exec policy without a mode", async () => {
        const current = structuredClone(configGetFixture()) as {
            config: {
                tools: {
                    exec: {
                        ask?: "always" | "off" | "on-miss";
                        mode?: string;
                        security?: "allowlist" | "deny" | "full";
                    };
                };
            };
        };
        current.config.tools.exec = { ask: "always", security: "deny" };
        const acknowledged = structuredClone(current);
        acknowledged.config.tools.exec = { ask: "off", security: "full" };
        const fixture = createFixtureTransport({
            reads: [{ payload: current }],
            writes: [
                {
                    payload: {
                        config: acknowledged.config,
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                section: "tools",
                settings: {
                    agentToAgentEnabled: true,
                    elevatedEnabled: false,
                    execPolicy: {
                        ask: "off",
                        security: "full",
                        state: "explicit",
                    },
                    profile: "coding",
                    sessionsVisibility: "agent",
                    webFetchEnabled: false,
                    webSearchEnabled: true,
                    webSearchProvider: "brave",
                },
            },
        });

        expect(JSON.parse(String(fixture.calls[1]?.parameters.raw))).toEqual({
            tools: { exec: { ask: "off", security: "full" } },
        });
        expect(result.configuration.tools.execPolicy).toEqual({
            ask: "off",
            security: "full",
            state: "explicit",
        });
    });

    test("rejects attempts to replace a fresh inherited exec policy", async () => {
        const current = structuredClone(configGetFixture()) as {
            config: { tools: { exec?: unknown } };
        };
        delete current.config.tools.exec;
        const fixture = createFixtureTransport({ reads: [{ payload: current }] });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        section: "tools",
                        settings: {
                            agentToAgentEnabled: true,
                            elevatedEnabled: false,
                            execPolicy: {
                                ask: "always",
                                security: "deny",
                                state: "explicit",
                            },
                            profile: "coding",
                            sessionsVisibility: "agent",
                            webFetchEnabled: false,
                            webSearchEnabled: true,
                            webSearchProvider: "brave",
                        },
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls).toHaveLength(1);
    });

    test("normalizes absent tool optionals when confirming a write", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as {
            tools: {
                profile?: string;
                sessions?: { visibility?: string };
                web?: { search?: { provider?: string } };
            };
        };
        delete acknowledgedConfig.tools.profile;
        delete acknowledgedConfig.tools.sessions;
        if (acknowledgedConfig.tools.web?.search !== undefined) {
            delete acknowledgedConfig.tools.web.search.provider;
        }
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

        const result = await createPersistentGatewayOpenClawSettingsProvider(
            fixture.transport
        ).updateConfiguration({
            authorizeDispatch,
            baseHash: currentHash,
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings",
            update: {
                section: "tools",
                settings: {
                    agentToAgentEnabled: true,
                    elevatedEnabled: false,
                    execPolicy: { mode: "ask", state: "legacy-mode" },
                    profile: undefined,
                    sessionsVisibility: undefined,
                    webFetchEnabled: false,
                    webSearchEnabled: true,
                    webSearchProvider: undefined,
                },
            },
        });

        expect(result.configuration.tools).toEqual({
            agentToAgentEnabled: true,
            elevatedEnabled: false,
            execPolicy: { mode: "ask", state: "legacy-mode" },
            webFetchEnabled: false,
            webSearchEnabled: true,
        });
        expect(result.configuration.hash).toBe(nextHash);
    });

    test("keeps malformed mutation readback durations outcome-unknown", async () => {
        const acknowledgedConfig = structuredClone(
            (configGetFixture() as { config: Record<string, unknown> }).config
        ) as {
            agents: { defaults: { heartbeat: { every: string } } };
        };
        acknowledgedConfig.agents.defaults.heartbeat.every = "invalid-duration";
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

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, mode: "idle", section: "session-reset" },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
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
            baseRevisionHash: currentRevisionHash,
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

    test("rejects an oversized serialized agent-tool delta before opening a write lane", async () => {
        const response = structuredClone(configGetFixture()) as {
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
        const preserved = Array.from(
            { length: 511 },
            (_, index) => `custom-${index.toString().padStart(3, "0")}-${"x".repeat(220)}`
        );
        response.config.agents.entries.main.tools.alsoAllow = [...preserved, "web_fetch"];
        response.config.agents.entries.main.tools.deny = [];
        const anticipatedRaw = JSON.stringify({
            agents: {
                entries: {
                    main: {
                        tools: { alsoAllow: preserved, deny: ["web_fetch"] },
                    },
                },
            },
        });
        expect(Buffer.byteLength(anticipatedRaw, "utf8")).toBeGreaterThan(
            persistentGatewayOpenClawSettingsPatchMaximumBytes
        );
        let authorizationCount = 0;
        const fixture = createFixtureTransport({ reads: [{ payload: response }] });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch: () => {
                        authorizationCount += 1;
                        return Promise.resolve();
                    },
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        agentId: "main",
                        override: "deny",
                        section: "agent-tool-access",
                        toolId: "web_fetch",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls.map(({ method }) => method)).toEqual(["config.get"]);
        expect(fixture.dispatchedWrites).toHaveLength(0);
        expect(authorizationCount).toBe(0);
    });

    test("rejects agent tool policies that would exceed the upstream list budget", async () => {
        for (const [field, override] of [
            ["alsoAllow", "allow"],
            ["deny", "deny"],
        ] as const) {
            const response = structuredClone(configGetFixture()) as {
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
            response.config.agents.entries.main.tools[field] = Array.from(
                { length: 512 },
                (_, index) => `custom-${index}`
            );
            const fixture = createFixtureTransport({
                reads: [{ payload: response }],
            });
            expect(
                await captureFailure(() =>
                    createPersistentGatewayOpenClawSettingsProvider(
                        fixture.transport
                    ).updateConfiguration({
                        authorizeDispatch,
                        baseHash: currentHash,
                        baseRevisionHash: currentRevisionHash,
                        confirmation: "apply-reviewed-settings",
                        update: {
                            agentId: "main",
                            override,
                            section: "agent-tool-access",
                            toolId: "image",
                        },
                    })
                )
            ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
            expect(fixture.dispatchedWrites).toHaveLength(0);
        }
    });

    test("admits mixed-case and leading-underscore agent ids for exact tool patches", async () => {
        for (const agentId of ["Main", "_ops"] as const) {
            const current = structuredClone(configGetFixture()) as {
                config: {
                    agents: {
                        entries: Record<
                            string,
                            { tools: { alsoAllow: string[]; deny: string[] } }
                        >;
                    };
                };
            };
            const mainEntry = current.config.agents.entries.main;
            if (mainEntry === undefined) throw new Error("Expected main agent fixture");
            delete current.config.agents.entries.main;
            current.config.agents.entries[agentId] = mainEntry;

            const acknowledged = structuredClone(current);
            acknowledged.config.agents.entries[agentId]?.tools.alsoAllow.push(
                "web_fetch"
            );
            const fixture = createFixtureTransport({
                reads: [{ payload: current }],
                writes: [
                    {
                        payload: {
                            config: acknowledged.config,
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

            const result = await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).updateConfiguration({
                authorizeDispatch,
                baseHash: currentHash,
                baseRevisionHash: currentRevisionHash,
                confirmation: "apply-reviewed-settings",
                update: {
                    agentId,
                    override: "allow",
                    section: "agent-tool-access",
                    toolId: "web_fetch",
                },
            });

            expect(fixture.calls[1]?.parameters.replacePaths).toEqual([
                `agents.entries.${agentId}.tools.alsoAllow`,
                `agents.entries.${agentId}.tools.deny`,
            ]);
            expect(
                result.configuration.agentAccess
                    .find(({ id }) => id === agentId)
                    ?.tools.find(({ id }) => id === "web_fetch")
            ).toEqual({ editable: true, id: "web_fetch", override: "allow" });
        }
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
                    baseRevisionHash: currentRevisionHash,
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

    test("applies one freshly checked skill leaf and verifies exact readback", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
            writes: [
                {
                    payload: {
                        config: { enabled: false },
                        ok: true,
                        skillKey: "imagegen",
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
                baseRevisionHash: currentRevisionHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.calls.map(({ lane, method }) => `${lane}:${method}`)).toEqual([
            "read:config.get",
            "read:skills.status",
            "write:skills.update",
            "read:config.get",
            "read:config.get",
        ]);
        expect(fixture.calls[2]?.parameters).toEqual({
            enabled: false,
            skillKey: "imagegen",
        });
    });

    test("allows a bounded config-only skill toggle through the same leaf update", async () => {
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }, { payload: skillsFixture() }],
            writes: [
                {
                    payload: {
                        config: { enabled: true },
                        ok: true,
                        skillKey: "config-only",
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
                baseRevisionHash: currentRevisionHash,
                enabled: true,
                skillKey: "config-only",
            })
        ).toEqual({ enabled: true, skillKey: "config-only" });
        expect(fixture.calls[2]?.parameters).toEqual({
            enabled: true,
            skillKey: "config-only",
        });
    });

    test("accepts leaf-on-latest when a concurrent writer already set the skill", async () => {
        const fixture = createFixtureTransport({
            reads: [
                { payload: configGetFixture() },
                { payload: skillsFixture() },
                { payload: configGetFixtureWithSkill(false, currentHash) },
            ],
            writes: [
                {
                    payload: {
                        config: { enabled: false },
                        ok: true,
                        skillKey: "imagegen",
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
                baseRevisionHash: currentRevisionHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.dispatchedWrites).toHaveLength(1);
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
                baseRevisionHash: currentRevisionHash,
                enabled: true,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: true, skillKey: "imagegen" });
        expect(fixture.calls.map(({ lane }) => lane)).toEqual(["read", "read"]);
    });

    test("rejects a new configured skill beyond the upstream entry budget", async () => {
        const response = structuredClone(configGetFixture()) as {
            config: {
                skills: {
                    entries: Record<string, { enabled: boolean }>;
                };
            };
        };
        response.config.skills.entries = Object.fromEntries(
            Array.from({ length: 4096 }, (_, index) => [
                `configured-${index}`,
                { enabled: false },
            ])
        );
        const fixture = createFixtureTransport({
            reads: [{ payload: response }],
        });

        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).setSkillEnabled({
                    authorizeDispatch,
                    baseHash: currentHash,
                    baseRevisionHash: currentRevisionHash,
                    enabled: false,
                    skillKey: "imagegen",
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(fixture.calls.map(({ method }) => method)).toEqual(["config.get"]);
        expect(fixture.dispatchedWrites).toHaveLength(0);
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
                baseRevisionHash: currentRevisionHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.calls.filter(({ lane }) => lane === "write")).toHaveLength(1);
        expect(fixture.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "skills.status",
            "skills.update",
            "config.get",
            "config.get",
        ]);
    });

    test("reconciles a rejected post-dispatch skill response once without replay", async () => {
        const fixture = createFixtureTransport({
            reads: [
                { payload: configGetFixture() },
                { payload: skillsFixture() },
                { payload: configGetFixtureWithSkill(false, nextHash) },
            ],
            writes: [
                {
                    rejection: new PersistentGatewayRequestError({
                        code: "UNAVAILABLE",
                        retryable: true,
                    }),
                },
            ],
        });

        expect(
            await createPersistentGatewayOpenClawSettingsProvider(
                fixture.transport
            ).setSkillEnabled({
                authorizeDispatch,
                baseHash: currentHash,
                baseRevisionHash: currentRevisionHash,
                enabled: false,
                skillKey: "imagegen",
            })
        ).toEqual({ enabled: false, skillKey: "imagegen" });
        expect(fixture.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "skills.status",
            "skills.update",
            "config.get",
            "config.get",
        ]);
        expect(fixture.dispatchedWrites).toHaveLength(1);
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
                    baseRevisionHash: currentRevisionHash,
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
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        idleMinutes: 60,
                        mode: "idle",
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
                    baseRevisionHash: currentRevisionHash,
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
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, mode: "idle", section: "session-reset" },
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
                    baseRevisionHash: currentRevisionHash,
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

    test("rechecks revision and write safety after the admin handshake", async () => {
        const pending = structuredClone(configGetFixture()) as {
            config: { agents: { entries: { main: Record<string, unknown> } } };
            parsed: unknown;
            sourceConfig: unknown;
        };
        pending.config.agents.entries.main.heartbeat = {
            model: "google/gemini-3-pro",
        };
        pending.parsed = structuredClone(pending.config);
        pending.sourceConfig = structuredClone(pending.config);

        const changedRevision = structuredClone(configGetFixture()) as {
            configRevisionHash: string;
        };
        changedRevision.configRevisionHash = nextRevisionHash;

        for (const [secondRead, expectedReason] of [
            [pending, "data-invalid"],
            [changedRevision, "conflict"],
        ] as const) {
            let authorizationCount = 0;
            const fixture = createFixtureTransport({
                consumePredispatchRead: true,
                reads: [{ payload: configGetFixture() }, { payload: secondRead }],
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
                        authorizeDispatch: () => {
                            authorizationCount += 1;
                            return Promise.resolve();
                        },
                        baseHash: currentHash,
                        baseRevisionHash: currentRevisionHash,
                        confirmation: "apply-reviewed-settings",
                        update: {
                            idleMinutes: 60,
                            mode: "idle",
                            section: "session-reset",
                        },
                    })
                )
            ).toEqual(new OpenClawSettingsProviderError(expectedReason));
            expect(authorizationCount).toBe(0);
            expect(fixture.dispatchedWrites).toHaveLength(0);
        }
    });

    test("rejects a stale revision before opening the write lane", async () => {
        let authorizationCount = 0;
        const fixture = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    fixture.transport
                ).updateConfiguration({
                    authorizeDispatch: () => {
                        authorizationCount += 1;
                        return Promise.resolve();
                    },
                    baseHash: currentHash,
                    baseRevisionHash: nextRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: {
                        idleMinutes: 60,
                        mode: "idle",
                        section: "session-reset",
                    },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("conflict"));
        expect(authorizationCount).toBe(0);
        expect(fixture.dispatchedWrites).toHaveLength(0);
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
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, mode: "idle", section: "session-reset" },
                })
            )
        ).toBe(authorizationFailure);
        expect(fixture.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "config.patch",
            "config.get",
        ]);
    });

    test("maps conflicts and keeps config writes uncertain without a restart acknowledgement", async () => {
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
            baseRevisionHash: currentRevisionHash,
            confirmation: "apply-reviewed-settings" as const,
            update: {
                idleMinutes: 60,
                mode: "idle" as const,
                section: "session-reset" as const,
            },
        };
        expect(
            await captureFailure(() => conflictProvider.updateConfiguration(update))
        ).toEqual(new OpenClawSettingsProviderError("conflict"));
        expect(conflict.dispatchedWrites).toHaveLength(1);

        const invalid = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    rejection: new PersistentGatewayRequestError({
                        code: "INVALID_REQUEST",
                    }),
                },
            ],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    invalid.transport
                ).updateConfiguration(update)
            )
        ).toEqual(new OpenClawSettingsProviderError("data-invalid"));
        expect(invalid.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "config.patch",
            "config.get",
        ]);
        expect(invalid.dispatchedWrites).toHaveLength(1);

        const rejectedAfterDispatch = createFixtureTransport({
            reads: [{ payload: configGetFixture() }],
            writes: [
                {
                    rejection: new PersistentGatewayRequestError({
                        code: "UNAVAILABLE",
                        retryable: true,
                    }),
                },
            ],
        });
        expect(
            await captureFailure(() =>
                createPersistentGatewayOpenClawSettingsProvider(
                    rejectedAfterDispatch.transport
                ).updateConfiguration(update)
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
        expect(rejectedAfterDispatch.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "config.patch",
            "config.get",
        ]);
        expect(rejectedAfterDispatch.dispatchedWrites).toHaveLength(1);

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
        expect(uncertain.calls.map(({ method }) => method)).toEqual([
            "config.get",
            "config.patch",
            "config.get",
        ]);
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
                    baseRevisionHash: currentRevisionHash,
                    confirmation: "apply-reviewed-settings",
                    update: { idleMinutes: 60, mode: "idle", section: "session-reset" },
                })
            )
        ).toEqual(new OpenClawSettingsProviderError("unknown-outcome"));
    });
});
