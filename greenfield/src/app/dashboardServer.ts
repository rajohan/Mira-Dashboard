import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { Redacted } from "effect";

import { createAgentRepository } from "../server/domains/agents/repository.ts";
import { createAgentService } from "../server/domains/agents/service.ts";
import { createCacheRepository } from "../server/domains/cache/repository.ts";
import { createCacheService } from "../server/domains/cache/service.ts";
import { createChatRepository } from "../server/domains/chat/repository.ts";
import { createChatService, type ChatService } from "../server/domains/chat/service.ts";
import { chatSessionSubscriptionIdleMilliseconds } from "../server/domains/chat/subscriptionManager.ts";
import { createChatTranscriptLifecycleCoordinator } from "../server/domains/chat/transcriptLifecycle.ts";
import {
    createGatewayConnectionService,
    unavailableGatewayConnectionStateProvider,
} from "../server/domains/gatewayConnection/service.ts";
import { createGatewaySessionControlAudit } from "../server/domains/gatewaySessions/controlAudit.ts";
import { createSqliteGatewaySessionControlAuditStore } from "../server/domains/gatewaySessions/controlAuditStore.ts";
import {
    GatewaySessionProviderUnavailableError,
    type GatewaySessionsProvider,
} from "../server/domains/gatewaySessions/provider.ts";
import { createGatewaySessionsService } from "../server/domains/gatewaySessions/service.ts";
import { createJobRepository } from "../server/domains/jobs/repository.ts";
import {
    createJobService,
    reconcileJobSchedules,
} from "../server/domains/jobs/service.ts";
import { createMonitoringCatalogService } from "../server/domains/monitoring/catalogService.ts";
import { createMonitoringRepository } from "../server/domains/monitoring/repository.ts";
import { createMonitoringService } from "../server/domains/monitoring/service.ts";
import {
    createOpenClawCronExpiryReconciler,
    type OpenClawCronExpiryReconciler,
} from "../server/domains/openClawCron/expiryReconciler.ts";
import { createSqliteOpenClawCronOperationAuditWriter } from "../server/domains/openClawCron/operationAudit.ts";
import {
    OpenClawCronProviderError,
    type OpenClawCronProvider,
} from "../server/domains/openClawCron/provider.ts";
import { createOpenClawCronService } from "../server/domains/openClawCron/service.ts";
import { createSqliteOpenClawCronIntentStore } from "../server/domains/openClawCron/sqliteIntentStore.ts";
import { createOpenClawTasksRealtimePublisher } from "../server/domains/openClawTasks/realtime.ts";
import {
    createOpenClawTasksService,
    type OpenClawTasksService,
} from "../server/domains/openClawTasks/service.ts";
import { createAuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../server/domains/security/authenticationLifecycleRepository.ts";
import {
    authenticationWorkBudgetMaximumUnits,
    authenticationWorkBudgetWindowMs,
    totpWorkBudgetMaximumUnits,
    totpWorkBudgetWindowMs,
    webAuthnWorkBudgetMaximumUnits,
    webAuthnWorkBudgetWindowMs,
} from "../server/domains/security/authenticationRateLimit.ts";
import { createAuthenticationWorkBudget } from "../server/domains/security/authenticationWorkBudget.ts";
import { createAutomationSecurityLifecycleService } from "../server/domains/security/automation/lifecycle.ts";
import { createAutomationLifecycleRepository } from "../server/domains/security/automation/lifecycleRepository.ts";
import { createMfaAccountLifecycleService } from "../server/domains/security/mfa/accountLifecycle.ts";
import { createMfaLifecycleRepository } from "../server/domains/security/mfa/lifecycleRepository.ts";
import { createMfaLoginLifecycleService } from "../server/domains/security/mfa/loginLifecycle.ts";
import {
    createTotpSecretCipher,
    type TotpSecretCipher,
} from "../server/domains/security/mfa/totpSecretCipher.ts";
import { createWebAuthnAdapter } from "../server/domains/security/mfa/webauthn/adapter.ts";
import type { WebAuthnRelyingPartyConfiguration } from "../server/domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import { createRequestAuthenticator } from "../server/domains/security/requestAuthentication.ts";
import { createRequestAuthenticationRepository } from "../server/domains/security/requestAuthenticationRepository.ts";
import { createSecurityAuditLifecycleService } from "../server/domains/security/securityAuditLifecycle.ts";
import { createSecurityAuditLifecycleRepository } from "../server/domains/security/securityAuditLifecycleRepository.ts";
import { createTaskRepository } from "../server/domains/tasks/repository.ts";
import { createTaskService } from "../server/domains/tasks/service.ts";
import { createElevenLabsSpeechProvider } from "../server/platform/chat/elevenLabsSpeechProvider.ts";
import { createInMemoryChatAttachmentStore } from "../server/platform/chat/inMemoryChatAttachmentStore.ts";
import { createInMemoryChatMediaReferences } from "../server/platform/chat/inMemoryChatMediaReferences.ts";
import {
    type WebConfiguration,
    parseWebConfiguration,
} from "../server/platform/configuration/webConfiguration.ts";
import {
    type DashboardProjectLayout,
    resolveDashboardProjectLayout,
} from "../server/platform/filesystem/projectLayout.ts";
import {
    createChatTranscriptLifecycleSupervisor,
    type ChatTranscriptLifecycleSupervisor,
} from "../server/platform/gateway/chatTranscriptLifecycleSupervisor.ts";
import { createGatewayCredentialVerifier } from "../server/platform/gateway/gatewayCredentialVerifier.ts";
import { createOpenClawTasksSubscriptionSupervisor } from "../server/platform/gateway/openClawTasksSubscriptionSupervisor.ts";
import { createPersistentGatewayChatProvider } from "../server/platform/gateway/persistentGatewayChatProvider.ts";
import { createPersistentGatewayOpenClawTasksProvider } from "../server/platform/gateway/persistentGatewayOpenClawTasksProvider.ts";
import { createPersistentGatewaySessionsProvider } from "../server/platform/gateway/persistentGatewaySessionsProvider.ts";
import { createPersistentGatewayTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import {
    createPersistentOpenClawCronProvider,
    type PersistentOpenClawCronTransport,
} from "../server/platform/gateway/persistentOpenClawCronProvider.ts";
import {
    createProjectFileLogDestination,
    type ProjectFileLogDestination,
} from "../server/platform/observability/projectFileLogSink.ts";
import {
    createStructuredLogger,
    type StructuredLogger,
} from "../server/platform/observability/structuredLogger.ts";
import { createReadinessController } from "../server/platform/readiness/readinessState.ts";
import {
    loadRuntimeRelease,
    type RuntimeRelease,
} from "../server/platform/release/runtimeRelease.ts";
import {
    createDashboardApplicationRuntime,
    type DashboardApplicationRuntime,
} from "../server/platform/runtime/applicationRuntime.ts";
import {
    createProcessTerminationController,
    type ProcessTerminationController,
} from "../server/platform/runtime/processSignals.ts";
import {
    chatMessageAuthorizesMediaReference,
    createChatRawHttpHandler,
    createOpenClawOutgoingMediaFetcher,
    type ChatRawHttpHandler,
} from "../server/rawHttp/chatMedia.ts";
import { createChatSpeechRawHttpHandler } from "../server/rawHttp/chatSpeech.ts";
import {
    createFrontendAssetHandler,
    type FrontendAssetHandler,
} from "../server/rawHttp/frontendAssets.ts";
import { parseBrowserOrigin } from "../server/rawHttp/requestSecurity.ts";
import {
    startDashboardChatRuntimeMaintenance,
    type DashboardChatRuntimeMaintenance,
} from "./dashboardChatRuntimeMaintenance.ts";
import { environmentSource } from "./environmentSource.ts";
import { createServer, type ApplicationServer, type ServerOptions } from "./server.ts";

/** Production composition inputs above the generic Bun/tRPC server primitive. */
export interface DashboardServerOptions extends Omit<
    ServerOptions,
    | "agentService"
    | "authenticateCredential"
    | "applicationRuntime"
    | "authenticationLifecycle"
    | "automationSecurityLifecycle"
    | "browserOrigin"
    | "cacheService"
    | "chatRawHttpHandler"
    | "chatService"
    | "disposeBeforeRuntime"
    | "gatewayConnectionService"
    | "gatewaySessionsService"
    | "hostname"
    | "mfaAccountLifecycle"
    | "mfaLoginLifecycle"
    | "jobService"
    | "monitoringCatalogService"
    | "monitoringService"
    | "openClawCronService"
    | "openClawTasksService"
    | "securityAuditLifecycle"
    | "taskService"
> {
    readonly applicationRuntime: DashboardApplicationRuntime;
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    /** Optional server-only speech credential; absence keeps both voice controls hidden. */
    readonly elevenLabsApiKey?: Redacted.Redacted<string>;
    /** Direct-loopback endpoint shared by bootstrap verification and persistent Gateway traffic. */
    readonly gatewayUrl: string;
    /** Server-only Gateway credential used by the outgoing-media proxy. */
    readonly gatewayToken?: Redacted.Redacted<string>;
    readonly gatewayVerificationTimeoutMs?: number;
    /** Shared composition clock for deterministic lifecycle and request-auth behavior. */
    readonly now?: () => Date;
    readonly recentAuthenticationWindowMs?: number;
    readonly sessionIdleDurationMs?: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly trustedProxyAddresses?: readonly string[];
    /** Explicit WebAuthn trust configuration; request host headers are never used. */
    readonly webAuthnRelyingParty?: WebAuthnRelyingPartyConfiguration;
    readonly webAuthnVerificationTimeoutMs?: number;
}

/**
 * Ensures the HTTP and WebAuthn browser trust boundaries cannot diverge.
 * @param browserOrigin Explicit public Dashboard browser origin.
 * @param relyingParty Optional validated WebAuthn trust configuration.
 * @returns The canonical Dashboard browser origin.
 */
export function validateDashboardWebAuthnBrowserOrigin(
    browserOrigin: string,
    relyingParty?: WebAuthnRelyingPartyConfiguration
): string {
    const canonicalOrigin = parseBrowserOrigin(browserOrigin);
    if (
        relyingParty !== undefined &&
        !relyingParty.allowedOrigins.includes(canonicalOrigin)
    ) {
        throw new TypeError(
            "Dashboard browser origin is absent from the WebAuthn origin allowlist"
        );
    }
    return canonicalOrigin;
}

/**
 * Derives a stable non-secret scope isolating chat rows by canonical Gateway origin.
 * @param gatewayUrl Configured Gateway URL.
 * @returns Lowercase SHA-256 fingerprint of the canonical URL origin.
 */
export function resolveDashboardGatewayScope(gatewayUrl: string): string {
    const origin = new URL(gatewayUrl).origin;
    if (origin === "null") throw new TypeError("Gateway URL has no canonical origin");
    return createHash("sha256").update(origin).digest("hex");
}

const unavailableOpenClawCronProvider: OpenClawCronProvider = Object.freeze({
    currentProcessInstanceId: (): undefined => {},
    get: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    list: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    listRuns: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    remove: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    run: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    update: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
});

/**
 * Selects the real Gateway cron adapter whenever the runtime owns a transport.
 * The fail-closed provider remains only for explicitly transport-free test runtimes.
 * @param transport Optional process-owned Gateway transport.
 * @returns The production adapter or a narrow unavailable fallback.
 */
export function createDashboardOpenClawCronProvider(
    transport?: PersistentOpenClawCronTransport
): OpenClawCronProvider {
    return transport === undefined
        ? unavailableOpenClawCronProvider
        : createPersistentOpenClawCronProvider(transport);
}

/**
 * Starts expiry reconciliation and makes it part of the server shutdown boundary.
 * @param server Started HTTP server that owns the application runtime.
 * @param reconciler Process-owned cron disable-intent reconciler.
 * @returns The same public server surface with ordered, idempotent cleanup.
 */
export async function startDashboardOpenClawCronExpiryReconciliation(
    server: ApplicationServer,
    reconciler: OpenClawCronExpiryReconciler
): Promise<ApplicationServer> {
    try {
        reconciler.start();
    } catch (error) {
        try {
            await server.stop(true);
        } catch {
            // Preserve the initiating lifecycle failure.
        }
        throw error;
    }

    let forceRequested = false;
    let serverStopForced = false;
    let serverStopPromise: Promise<void> | undefined;
    let stopPromise: Promise<void> | undefined;

    function stopServer(force: boolean): Promise<void> {
        if (serverStopPromise === undefined) {
            serverStopForced = force;
            serverStopPromise = server.stop(force);
        } else if (force && !serverStopForced) {
            serverStopForced = true;
            void server.stop(true).catch(() => {});
        }
        return serverStopPromise;
    }

    return Object.freeze({
        port: server.port,
        stop(force = false) {
            if (force) forceRequested = true;
            if (stopPromise !== undefined) {
                if (force) {
                    void reconciler.stop(true).catch(() => {});
                    void stopServer(true).catch(() => {});
                }
                return stopPromise;
            }
            stopPromise = (async () => {
                let reconciliationFailure: unknown;
                try {
                    await reconciler.stop(forceRequested);
                } catch (error) {
                    reconciliationFailure = error;
                }
                try {
                    await stopServer(forceRequested);
                } catch (error) {
                    if (reconciliationFailure === undefined) throw error;
                }
                if (reconciliationFailure !== undefined) {
                    throw new Error("OpenClaw cron expiry reconciler shutdown failed", {
                        cause: reconciliationFailure,
                    });
                }
            })();
            return stopPromise;
        },
        url: server.url,
    });
}

/**
 * Wires the runtime-owned SQLite identity store into real request authentication.
 * @param options Server and bounded authentication policy options.
 * @returns A started Bun server using persisted session and automation identities.
 */
export async function createDashboardServer(
    options: DashboardServerOptions
): Promise<ApplicationServer> {
    let serverOwnsRuntimeCleanup = false;
    let compositionDisposed = false;
    let chatAttachmentStore:
        | ReturnType<typeof createInMemoryChatAttachmentStore>
        | undefined;
    let chatMediaReferences:
        | ReturnType<typeof createInMemoryChatMediaReferences>
        | undefined;
    let chatService: ChatService | undefined;
    let chatMaintenance: DashboardChatRuntimeMaintenance | undefined;
    let chatTranscriptLifecycleSupervisor: ChatTranscriptLifecycleSupervisor | undefined;
    let openClawTasksService: OpenClawTasksService | undefined;
    let openClawTasksSupervisor:
        | ReturnType<typeof createOpenClawTasksSubscriptionSupervisor>
        | undefined;
    const disposeComposition = async (): Promise<void> => {
        if (compositionDisposed) return;
        compositionDisposed = true;
        let failure: unknown;
        try {
            await chatMaintenance?.stop();
        } catch (error) {
            failure = error;
        }
        try {
            await chatTranscriptLifecycleSupervisor?.stop();
        } catch (error) {
            failure ??= error;
        }
        try {
            await openClawTasksSupervisor?.stop();
        } catch (error) {
            failure ??= error;
        }
        try {
            await chatService?.dispose();
        } catch (error) {
            failure ??= error;
        }
        chatAttachmentStore?.dispose();
        chatMediaReferences?.dispose();
        if (failure instanceof Error) throw failure;
        if (failure !== undefined) {
            throw new Error("Dashboard composition disposal failed", {
                cause: failure,
            });
        }
    };
    try {
        const browserOrigin = validateDashboardWebAuthnBrowserOrigin(
            options.browserOrigin,
            options.webAuthnRelyingParty
        );
        const verifyGatewayCredential = createGatewayCredentialVerifier({
            url: options.gatewayUrl,
        });
        const authenticationWork = options.applicationRuntime.services.authentication;
        const passwordWorkGate = authenticationWork.passwordWorkGate;
        const passwordWorkBudget = createAuthenticationWorkBudget(
            authenticationWorkBudgetMaximumUnits,
            authenticationWorkBudgetWindowMs
        );
        const totpWorkBudget = createAuthenticationWorkBudget(
            totpWorkBudgetMaximumUnits,
            totpWorkBudgetWindowMs
        );
        const webAuthnWorkBudget = createAuthenticationWorkBudget(
            webAuthnWorkBudgetMaximumUnits,
            webAuthnWorkBudgetWindowMs
        );
        const webAuthn =
            options.webAuthnRelyingParty === undefined
                ? undefined
                : Object.freeze({
                      adapter: createWebAuthnAdapter(options.webAuthnRelyingParty),
                      relyingParty: options.webAuthnRelyingParty,
                      ...(options.webAuthnVerificationTimeoutMs === undefined
                          ? {}
                          : {
                                verificationTimeoutMs:
                                    options.webAuthnVerificationTimeoutMs,
                            }),
                      workBudget: webAuthnWorkBudget,
                      workRuntime: authenticationWork,
                  });
        await options.applicationRuntime.initialize();
        const databaseRuntime = options.applicationRuntime.database;
        const database = await databaseRuntime.orm();
        const repository = createRequestAuthenticationRepository(database);
        const authenticator = createRequestAuthenticator({
            authenticationLeaseDurationMs: options.authenticationLeaseDurationMs,
            ...(options.now !== undefined && { now: options.now }),
            repository,
            sessionIdleDurationMs: options.sessionIdleDurationMs,
        });
        const mfaRepository = createMfaLifecycleRepository(database, databaseRuntime);
        const mfaLoginLifecycle = createMfaLoginLifecycleService({
            ...(options.now !== undefined && { now: options.now }),
            passwordWorkBudget,
            passwordWorkGate,
            repository: mfaRepository,
            sessionIdleDurationMs: options.sessionIdleDurationMs,
            totpSecretCipher: options.totpSecretCipher,
            totpWorkBudget,
            totpWorkGate: authenticationWork.totpWorkGate,
            ...(webAuthn === undefined ? {} : { webAuthn }),
        });
        const mfaAccountLifecycle = createMfaAccountLifecycleService({
            ...(options.now !== undefined && { now: options.now }),
            passwordWorkBudget,
            passwordWorkGate,
            recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
            repository: mfaRepository,
            sessionIdleDurationMs: options.sessionIdleDurationMs,
            totpSecretCipher: options.totpSecretCipher,
            totpWorkBudget,
            totpWorkGate: authenticationWork.totpWorkGate,
            ...(webAuthn === undefined
                ? {}
                : {
                      webAuthnAdapter: webAuthn.adapter,
                      webAuthnRelyingParty: webAuthn.relyingParty,
                      ...(webAuthn.verificationTimeoutMs === undefined
                          ? {}
                          : {
                                webAuthnVerificationTimeoutMs:
                                    webAuthn.verificationTimeoutMs,
                            }),
                      webAuthnWorkBudget,
                      webAuthnWorkRuntime: authenticationWork,
                  }),
        });
        const authenticationLifecycle = createAuthenticationLifecycleService({
            gatewayVerificationTimeoutMs: options.gatewayVerificationTimeoutMs,
            gatewayWorkRuntime: authenticationWork,
            mfaLoginLifecycle,
            ...(options.now !== undefined && { now: options.now }),
            passwordWorkBudget,
            passwordWorkGate,
            recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
            repository: createAuthenticationLifecycleRepository(
                database,
                databaseRuntime
            ),
            sessionIdleDurationMs: options.sessionIdleDurationMs,
            verifyGatewayCredential,
        });
        const automationSecurityLifecycle = createAutomationSecurityLifecycleService({
            ...(options.now !== undefined && { now: options.now }),
            recentAuthenticationWindowMs: options.recentAuthenticationWindowMs,
            repository: createAutomationLifecycleRepository(database, databaseRuntime),
            sessionIdleDurationMs: options.sessionIdleDurationMs,
        });
        const securityAuditLifecycle = createSecurityAuditLifecycleService({
            ...(options.now !== undefined && { now: options.now }),
            repository: createSecurityAuditLifecycleRepository(database),
            sessionIdleDurationMs: options.sessionIdleDurationMs,
        });
        const domainNow = options.now;
        const wakeEventPump = async (): Promise<void> => {
            try {
                await options.applicationRuntime.services.realtimeEvents.wake();
            } catch (error) {
                options.applicationRuntime.logger.warn({
                    component: "realtime-event-pump",
                    event: "realtime.wake.failed",
                    failure: error,
                    outcome: "server-error",
                });
                throw error;
            }
        };
        const taskRepository = createTaskRepository(database, databaseRuntime);
        const taskService = createTaskService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: taskRepository,
            wakeEventPump,
        });
        const jobRepository = createJobRepository(database, databaseRuntime);
        await reconcileJobSchedules({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: jobRepository,
            wakeEventPump,
        });
        const jobService = createJobService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: jobRepository,
            wakeEventPump,
        });
        const gatewayConnectionService = createGatewayConnectionService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            provider:
                options.applicationRuntime.persistentGatewayTransport ??
                unavailableGatewayConnectionStateProvider,
        });
        const unavailableGatewaySessionsProvider: GatewaySessionsProvider = Object.freeze(
            {
                compactSession: () =>
                    Promise.reject(new GatewaySessionProviderUnavailableError()),
                deleteSessionTranscript: () =>
                    Promise.reject(new GatewaySessionProviderUnavailableError()),
                listCurrentSessions: () =>
                    Promise.reject(new GatewaySessionProviderUnavailableError()),
                resetSession: () =>
                    Promise.reject(new GatewaySessionProviderUnavailableError()),
            }
        );
        const persistentGatewayTransport =
            options.applicationRuntime.persistentGatewayTransport;
        const chatRepository =
            persistentGatewayTransport === undefined
                ? undefined
                : createChatRepository(
                      database,
                      databaseRuntime,
                      resolveDashboardGatewayScope(options.gatewayUrl),
                      domainNow === undefined ? Date.now : () => domainNow().getTime(),
                      wakeEventPump
                  );
        const chatTranscriptLifecycle =
            chatRepository === undefined
                ? undefined
                : createChatTranscriptLifecycleCoordinator(chatRepository);
        const gatewaySessionsService = createGatewaySessionsService({
            controlAudit: createGatewaySessionControlAudit({
                ...(domainNow === undefined ? {} : { now: domainNow }),
                onSettlementFailure: ({
                    action,
                    cause,
                    outcome,
                    requestId,
                    targetFingerprint,
                }) =>
                    options.applicationRuntime.logger.error({
                        component: "gateway-session-audit",
                        event: "gateway.session.audit_settlement_failed",
                        failure: cause,
                        fields: {
                            action,
                            auditOutcome:
                                outcome === "succeeded" ? "succeeded" : "failed",
                            kind: "gateway-session-audit-settlement",
                            targetFingerprint,
                        },
                        outcome: "server-error",
                        requestId,
                    }),
                store: createSqliteGatewaySessionControlAuditStore(
                    database,
                    databaseRuntime
                ),
            }),
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            provider:
                persistentGatewayTransport === undefined
                    ? unavailableGatewaySessionsProvider
                    : createPersistentGatewaySessionsProvider(persistentGatewayTransport),
            ...(chatTranscriptLifecycle === undefined
                ? {}
                : { transcriptLifecycle: chatTranscriptLifecycle }),
        });
        const agentService = createAgentService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            gatewaySessionsService,
            repository: createAgentRepository(database, databaseRuntime),
            wakeEventPump,
        });
        let chatRawHttpHandler: ChatRawHttpHandler | undefined;
        if (persistentGatewayTransport !== undefined) {
            if (chatRepository === undefined || chatTranscriptLifecycle === undefined) {
                throw new Error("Chat transcript lifecycle composition is unavailable");
            }
            chatAttachmentStore = createInMemoryChatAttachmentStore();
            chatMediaReferences = createInMemoryChatMediaReferences(
                domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }
            );
            chatService = createChatService({
                attachmentConsumer: chatAttachmentStore,
                attachmentPreparer: chatAttachmentStore,
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                onAsyncFailure: () =>
                    options.applicationRuntime.logger.warn({
                        component: "chat-runtime",
                        event: "chat.runtime.async_failure",
                        failure: new Error("Chat background reconciliation failed"),
                        outcome: "server-error",
                    }),
                provider: createPersistentGatewayChatProvider(
                    persistentGatewayTransport,
                    chatMediaReferences
                ),
                repository: chatRepository,
                transcriptLifecycle: chatTranscriptLifecycle,
            });
            chatTranscriptLifecycleSupervisor = createChatTranscriptLifecycleSupervisor({
                lifecycle: chatTranscriptLifecycle,
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                onFailure: () =>
                    options.applicationRuntime.logger.warn({
                        component: "chat-transcript-lifecycle",
                        event: "chat.transcript.lifecycle_failed",
                        failure: new Error(
                            "Chat transcript lifecycle reconciliation failed"
                        ),
                        outcome: "server-error",
                    }),
                transport: persistentGatewayTransport,
            });
            await chatTranscriptLifecycleSupervisor.ready;
            chatMaintenance = await startDashboardChatRuntimeMaintenance({
                intervalMs: chatSessionSubscriptionIdleMilliseconds,
                onFailure: () =>
                    options.applicationRuntime.logger.warn({
                        component: "chat-runtime",
                        event: "chat.runtime.maintenance_failed",
                        failure: new Error("Chat maintenance sweep failed"),
                        outcome: "server-error",
                    }),
                service: chatService,
            });

            const activeChatService = chatService;
            openClawTasksService = createOpenClawTasksService(
                createPersistentGatewayOpenClawTasksProvider(persistentGatewayTransport),
                createOpenClawTasksRealtimePublisher(
                    database,
                    databaseRuntime,
                    domainNow === undefined ? Date.now : () => domainNow().getTime(),
                    wakeEventPump
                )
            );
            openClawTasksSupervisor = createOpenClawTasksSubscriptionSupervisor({
                onFailure: () =>
                    options.applicationRuntime.logger.error({
                        component: "openclaw-tasks-realtime",
                        event: "openclaw_tasks.subscription.failed",
                        failure: new Error(
                            "OpenClaw task invalidation subscription failed"
                        ),
                        outcome: "server-error",
                    }),
                service: openClawTasksService,
            });
            openClawTasksSupervisor.start();

            if (options.gatewayToken !== undefined) {
                const mediaHandler = createChatRawHttpHandler({
                    attachmentStore: chatAttachmentStore,
                    authenticateCredential: (credential) =>
                        authenticator.authenticate(credential),
                    authorizeMedia: async (reference, signal) => {
                        const result = await activeChatService.getMessage(
                            {
                                messageId: reference.messageId,
                                sessionKey: reference.sessionKey,
                            },
                            signal
                        );
                        return chatMessageAuthorizesMediaReference(result, reference);
                    },
                    browserOrigin,
                    mediaFetcher: createOpenClawOutgoingMediaFetcher({
                        gatewayUrl: options.gatewayUrl,
                        token: options.gatewayToken,
                    }),
                    mediaReferences: chatMediaReferences,
                });
                const speechHandler = createChatSpeechRawHttpHandler({
                    authenticateCredential: (credential) =>
                        authenticator.authenticate(credential),
                    browserOrigin,
                    ...(options.elevenLabsApiKey === undefined
                        ? {}
                        : {
                              provider: createElevenLabsSpeechProvider({
                                  apiKey: options.elevenLabsApiKey,
                              }),
                          }),
                });
                chatRawHttpHandler = async (request, requestUrl) =>
                    (await speechHandler(request, requestUrl)) ??
                    mediaHandler(request, requestUrl);
            }
        }
        const openClawCronIntentStore = createSqliteOpenClawCronIntentStore(
            database,
            databaseRuntime
        );
        const openClawCronService = createOpenClawCronService({
            ...(domainNow === undefined ? {} : { clock: () => domainNow().getTime() }),
            auditWriter: createSqliteOpenClawCronOperationAuditWriter({
                ...(domainNow === undefined ? {} : { clock: domainNow }),
                database,
                writeAdmission: databaseRuntime,
            }),
            intentStore: openClawCronIntentStore,
            linkedTaskReader: {
                listOpenLinkedTasks: (cronJobIds) =>
                    taskRepository
                        .listOpenTasksByCronJobIds(cronJobIds)
                        .flatMap(({ cronJobId, task }) =>
                            task.status === "done"
                                ? []
                                : [
                                      {
                                          cronJobId,
                                          task: {
                                              id: task.id,
                                              status: task.status,
                                              title: task.title,
                                          },
                                      },
                                  ]
                        ),
            },
            onAuditSettlementFailure: ({ operation, settlement, targetFingerprint }) => {
                options.applicationRuntime.logger.warn({
                    component: "openclaw-cron-audit",
                    event: "openclaw_cron.audit_settlement.failed",
                    failure: new Error("OpenClaw cron audit settlement append failed"),
                    fields: {
                        kind: "openclaw-cron-audit-settlement",
                        operation,
                        settlement,
                        targetFingerprint,
                    },
                    outcome: "server-error",
                });
            },
            provider: createDashboardOpenClawCronProvider(
                options.applicationRuntime.persistentGatewayTransport
            ),
        });
        const cacheService = createCacheService({
            cacheRepository: createCacheRepository(database, databaseRuntime),
            jobRepository,
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            readGatewayConnection: gatewayConnectionService.get,
            readGatewaySessionsProjection: gatewaySessionsService.readHeartbeatProjection,
            readOpenClawCronProjection: openClawCronService.readHeartbeatProjection,
            wakeEventPump,
        });
        const openClawCronExpiryReconciler = createOpenClawCronExpiryReconciler({
            ...(domainNow === undefined ? {} : { clock: () => domainNow().getTime() }),
            intentStore: openClawCronIntentStore,
            onFailure: (failure) => {
                options.applicationRuntime.logger.warn({
                    component: "openclaw-cron-expiry",
                    event: "openclaw_cron.expiry_reconciliation.failed",
                    failure: new Error(
                        `OpenClaw cron expiry reconciliation failed: ${failure.reason}`
                    ),
                    outcome: "server-error",
                });
            },
            service: openClawCronService,
        });
        const monitoringRepository = createMonitoringRepository(
            database,
            databaseRuntime
        );
        const monitoringService = createMonitoringService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: monitoringRepository,
            wakeEventPump,
        });
        const monitoringCatalogService = createMonitoringCatalogService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: monitoringRepository,
            wakeEventPump,
        });
        const serverOptions: ServerOptions = {
            agentService,
            applicationRuntime: options.applicationRuntime,
            authenticateCredential: (credential) =>
                authenticator.authenticate(credential),
            authenticationLifecycle,
            automationSecurityLifecycle,
            browserOrigin,
            cacheService,
            ...(chatRawHttpHandler === undefined ? {} : { chatRawHttpHandler }),
            ...(chatService === undefined ? {} : { chatService }),
            disposeBeforeRuntime: disposeComposition,
            gatewayConnectionService,
            gatewaySessionsService,
            frontendAssets: options.frontendAssets,
            gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
            hostname: "127.0.0.1",
            mfaAccountLifecycle,
            mfaLoginLifecycle,
            jobService,
            monitoringCatalogService,
            monitoringService,
            openClawCronService,
            ...(openClawTasksService === undefined ? {} : { openClawTasksService }),
            port: options.port,
            readiness: options.readiness,
            securityAuditLifecycle,
            taskService,
            trustedProxyAddresses: options.trustedProxyAddresses,
        };
        serverOwnsRuntimeCleanup = true;
        const server = await createServer(serverOptions);
        return await startDashboardOpenClawCronExpiryReconciliation(
            server,
            openClawCronExpiryReconciler
        );
    } catch (error) {
        if (!serverOwnsRuntimeCleanup) {
            try {
                await disposeComposition();
            } catch {
                // Preserve the initiating composition failure.
            }
            try {
                await options.applicationRuntime.dispose();
            } catch {
                // Preserve the initiating composition failure.
            }
            try {
                options.applicationRuntime.logger.flush();
            } catch {
                // Structured logger fallback handling owns sink failures.
            }
        }
        throw error;
    }
}

/** Explicit inputs owned by the executable web composition root. */
export interface DashboardWebProcessOptions {
    readonly configurationSource: Readonly<Record<string, unknown>>;
    readonly releaseRoot: string;
}

/** Injectable web-process boundaries used by deterministic composition tests. */
export interface DashboardWebProcessDependencies {
    readonly createFrontendAssets: (
        release: RuntimeRelease
    ) => Promise<FrontendAssetHandler>;
    readonly createLogDestination: (
        logsDirectory: string,
        processRole: "web"
    ) => ProjectFileLogDestination;
    readonly createRuntime: (
        configuration: WebConfiguration,
        layout: DashboardProjectLayout,
        release: RuntimeRelease,
        logger: StructuredLogger
    ) => DashboardApplicationRuntime;
    readonly createServer: (
        options: DashboardServerOptions
    ) => Promise<ApplicationServer>;
    readonly createTerminationController: () => ProcessTerminationController;
    readonly createTotpCipher: (serializedKeyring: string) => Promise<TotpSecretCipher>;
    readonly loadRelease: (
        releasesDirectory: string,
        releaseRoot: string,
        processRole: "web"
    ) => Promise<RuntimeRelease>;
    readonly resolveProjectLayout: (
        projectRoot: string
    ) => Promise<DashboardProjectLayout>;
}

const defaultWebProcessDependencies = Object.freeze({
    createFrontendAssets: (release) => createFrontendAssetHandler(release),
    createLogDestination: (logsDirectory, processRole) =>
        createProjectFileLogDestination(logsDirectory, processRole),
    createRuntime: (configuration, layout, release, logger) =>
        createDashboardApplicationRuntime({
            database: {
                migrationsDirectory: path.join(release.releaseRoot, "migrations"),
                releaseId: release.manifest.source.commitSha,
                startupMode: "validate-only",
                stateDirectory: layout.production.state.root,
            },
            logger,
            persistentGatewayTransport: createPersistentGatewayTransport({
                clientVersion: release.manifest.source.commitSha,
                token: configuration.gatewayToken,
                url: configuration.gatewayUrl,
            }),
        }),
    createServer: createDashboardServer,
    createTerminationController: createProcessTerminationController,
    createTotpCipher: (serializedKeyring) => createTotpSecretCipher(serializedKeyring),
    loadRelease: (releasesDirectory, releaseRoot, processRole) =>
        loadRuntimeRelease(releasesDirectory, releaseRoot, processRole),
    resolveProjectLayout: resolveDashboardProjectLayout,
} satisfies DashboardWebProcessDependencies);

function createWebLogger(
    configuration: WebConfiguration,
    release: RuntimeRelease,
    destination: ProjectFileLogDestination
): StructuredLogger {
    const runtime = release.manifest.runtime;
    return createStructuredLogger({
        fallbackWrite: destination.fallbackWrite,
        identity: {
            bun: `${runtime.version}+${runtime.revision.slice(0, 9)}`,
            pid: process.pid,
            processRole: "web",
            release: release.manifest.source.commitSha,
            service: "mira-dashboard",
        },
        minimumLevel: configuration.logLevel,
        sink: destination.sink,
    });
}

function normalizeWebProcessFailure(error: unknown): Error {
    return error instanceof Error
        ? error
        : new Error("Dashboard web process failed", { cause: error });
}

/**
 * Starts the validated Dashboard web runtime, promotes readiness, and drains on signals.
 * @param options Typed environment source and exact immutable release root.
 * @param dependencies Injectable host/runtime boundaries.
 */
export async function runDashboardWebProcess(
    options: DashboardWebProcessOptions,
    dependencies: DashboardWebProcessDependencies = defaultWebProcessDependencies
): Promise<void> {
    const configuration = parseWebConfiguration(options.configurationSource);
    const layout = await dependencies.resolveProjectLayout(configuration.projectRoot);
    const release = await dependencies.loadRelease(
        layout.production.releases,
        options.releaseRoot,
        "web"
    );
    const destination = dependencies.createLogDestination(
        layout.production.state.logs,
        "web"
    );
    const logger = createWebLogger(configuration, release, destination);
    const termination = dependencies.createTerminationController();
    let applicationRuntime: DashboardApplicationRuntime | undefined;
    let server: ApplicationServer | undefined;
    let serverOwnsRuntime = false;
    let forceStopPromise: Promise<void> | undefined;
    let failure: Error | undefined;
    const forceStop = (): void => {
        if (!server) return;
        forceStopPromise ??= server.stop(true).catch(() => {});
    };
    termination.forceSignal.addEventListener("abort", forceStop, { once: true });
    try {
        const frontendAssets = await dependencies.createFrontendAssets(release);
        const totpSecretCipher = await dependencies.createTotpCipher(
            Redacted.value(configuration.totpKeyring)
        );
        const readiness = createReadinessController();
        applicationRuntime = dependencies.createRuntime(
            configuration,
            layout,
            release,
            logger
        );
        serverOwnsRuntime = true;
        server = await dependencies.createServer({
            applicationRuntime,
            browserOrigin: configuration.publicOrigin,
            ...(configuration.elevenLabsApiKey === undefined
                ? {}
                : { elevenLabsApiKey: configuration.elevenLabsApiKey }),
            frontendAssets,
            gatewayUrl: configuration.gatewayUrl,
            gatewayToken: configuration.gatewayToken,
            port: configuration.port,
            readiness,
            recentAuthenticationWindowMs: configuration.recentAuthenticationWindowMs,
            sessionIdleDurationMs: configuration.sessionIdleDurationMs,
            totpSecretCipher,
            trustedProxyAddresses: configuration.trustedProxyAddresses,
            webAuthnRelyingParty: configuration.webAuthnRelyingParty,
        });
        readiness.markReady();
        logger.info({
            component: "runtime",
            event: "runtime.started",
            outcome: "success",
        });
        await termination.termination;
        await server.stop(false);
        await forceStopPromise;
    } catch (error) {
        failure = normalizeWebProcessFailure(error);
        if (server) {
            try {
                await server.stop(true);
            } catch {
                // Preserve the initiating process failure.
            }
        } else if (!serverOwnsRuntime && applicationRuntime) {
            try {
                await applicationRuntime.dispose();
            } catch {
                // Preserve the initiating process failure.
            }
            logger.fatal({
                component: "runtime",
                event: "runtime.start_failed",
                failure,
                outcome: "server-error",
            });
            logger.flush();
        } else if (!serverOwnsRuntime) {
            logger.fatal({
                component: "runtime",
                event: "runtime.start_failed",
                failure,
                outcome: "server-error",
            });
            logger.flush();
        }
    } finally {
        termination.forceSignal.removeEventListener("abort", forceStop);
        termination.dispose();
    }
    if (failure !== undefined) throw failure;
}

if (import.meta.main) {
    try {
        const releaseRoot = await realpath(path.resolve(import.meta.dir, ".."));
        await runDashboardWebProcess({
            configurationSource: environmentSource("web"),
            releaseRoot,
        });
    } catch {
        process.stderr.write("Mira Dashboard web startup failed\n");
        process.exitCode = 1;
    }
}
