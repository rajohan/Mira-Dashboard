import { realpath } from "node:fs/promises";
import path from "node:path";

import { Redacted } from "effect";

import {
    chatHistoryPageMaximum,
    chatHistoryRetainedPageMaximum,
} from "../contracts/chatModel.ts";
import { gatewaySessionProjectionMaximum } from "../contracts/gatewaySessions.ts";
import { serviceActionIds } from "../contracts/serviceActions.ts";
import { createAgentRepository } from "../server/domains/agents/repository.ts";
import { createAgentService } from "../server/domains/agents/service.ts";
import { createBackupActivityRepository } from "../server/domains/backups/activityRepository.ts";
import { createSqliteBackupOperationAuditWriter } from "../server/domains/backups/operationAudit.ts";
import { createBackupOperationQueue } from "../server/domains/backups/operationQueue.ts";
import { createBackupService } from "../server/domains/backups/service.ts";
import { createBackupSnapshotRepository } from "../server/domains/backups/snapshotRepository.ts";
import {
    readCacheHeartbeatDashboardJobs,
    readCacheHeartbeatTasksWithCronRefresh,
} from "../server/domains/cache/heartbeatProjection.ts";
import {
    cacheHeartbeatBackupSignalFromStatus,
    createCacheHeartbeatOperationalSignalsReader,
    createCacheHeartbeatOverviewSignalReaders,
} from "../server/domains/cache/operationalSignals.ts";
import { createCacheRepository } from "../server/domains/cache/repository.ts";
import { createCacheService } from "../server/domains/cache/service.ts";
import { createChatRepository } from "../server/domains/chat/repository.ts";
import { createChatService, type ChatService } from "../server/domains/chat/service.ts";
import { chatSessionSubscriptionIdleMilliseconds } from "../server/domains/chat/subscriptionManager.ts";
import { createChatTranscriptLifecycleCoordinator } from "../server/domains/chat/transcriptLifecycle.ts";
import { createDatabaseObservabilityService } from "../server/domains/database/service.ts";
import { createDatabaseObservabilitySnapshotRepository } from "../server/domains/database/snapshotRepository.ts";
import { createSqliteLifecycleReader } from "../server/domains/database/sqliteLifecycle.ts";
import { createDeliveryDeploymentHistoryReader } from "../server/domains/delivery/deploymentHistory.ts";
import { createSqliteDeliveryOperationAuditWriter } from "../server/domains/delivery/operationAudit.ts";
import { createDeliveryOperationQueue } from "../server/domains/delivery/operationQueue.ts";
import { createDeliveryService } from "../server/domains/delivery/service.ts";
import { createDeliveryOverviewSnapshotRepository } from "../server/domains/delivery/snapshotRepository.ts";
import { createSqliteDockerOperationAuditWriter } from "../server/domains/docker/operationAudit.ts";
import { createDockerOperationQueue } from "../server/domains/docker/operationQueue.ts";
import { createDockerService } from "../server/domains/docker/service.ts";
import { createDockerOverviewSnapshotRepository } from "../server/domains/docker/snapshotRepository.ts";
import { createWorkspaceFileJobScheduler } from "../server/domains/files/jobScheduler.ts";
import type { WorkspaceFileRootConfiguration } from "../server/domains/files/ports.ts";
import {
    createWorkspaceFileRawHttpHandler,
    type WorkspaceFileRawHttpHandler,
} from "../server/domains/files/rawHttp.ts";
import {
    createWorkspaceFilesService,
    type WorkspaceFilesService,
} from "../server/domains/files/service.ts";
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
import {
    createGatewaySessionsService,
    type GatewaySessionsService,
} from "../server/domains/gatewaySessions/service.ts";
import {
    type JobActionDefinition,
    hostSystemCleanupJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    jobActionDefinitions,
    managedPreviewJobActionDefinitions,
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    openClawGatewayRestartJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    openClawSessionsCleanupJobActionDefinition,
} from "../server/domains/jobs/actionRegistry.ts";
import { createJobRepository } from "../server/domains/jobs/repository.ts";
import {
    createJobService,
    reconcileJobSchedules,
} from "../server/domains/jobs/service.ts";
import { createServiceActionQueue } from "../server/domains/jobs/serviceActionQueue.ts";
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
import {
    createOpenClawCronService,
    type OpenClawCronHeartbeatReader,
} from "../server/domains/openClawCron/service.ts";
import { createSqliteOpenClawCronIntentStore } from "../server/domains/openClawCron/sqliteIntentStore.ts";
import type { OpenClawConfigurationBackupTicketStore } from "../server/domains/openClawSettings/configurationBackup.ts";
import {
    createOpenClawConfigurationBackupRawHttpHandler,
    type OpenClawConfigurationBackupRawHttpHandler,
} from "../server/domains/openClawSettings/configurationBackupRawHttp.ts";
import { createWorkspaceFileOpenClawConfigurationBackupSource } from "../server/domains/openClawSettings/configurationBackupSource.ts";
import { createOpenClawConfigurationBackupTicketStore } from "../server/domains/openClawSettings/configurationBackupTickets.ts";
import { createSqliteOpenClawSettingsOperationAuditWriter } from "../server/domains/openClawSettings/operationAudit.ts";
import {
    OpenClawSettingsProviderError,
    type OpenClawSettingsProvider,
} from "../server/domains/openClawSettings/provider.ts";
import { createOpenClawGatewayRestartQueue } from "../server/domains/openClawSettings/restartQueue.ts";
import { createOpenClawSettingsService } from "../server/domains/openClawSettings/service.ts";
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
import {
    createServiceActionsService,
    createSqliteServiceActionAuditWriter,
} from "../server/domains/serviceActions/service.ts";
import { createSqliteServiceActionStatusReader } from "../server/domains/serviceActions/statusReader.ts";
import { createSystemApplicationMetricsReader } from "../server/domains/system/applicationMetricsCollector.ts";
import { createSystemHealthDiagnosticsService } from "../server/domains/system/healthDiagnosticsService.ts";
import { createTaskRepository } from "../server/domains/tasks/repository.ts";
import { createTaskService } from "../server/domains/tasks/service.ts";
import { createDescriptorOpenClawLocalHistoryMediaFetcher } from "../server/platform/chat/descriptorOpenClawLocalHistoryMediaFetcher.ts";
import { createElevenLabsSpeechProvider } from "../server/platform/chat/elevenLabsSpeechProvider.ts";
import { createInMemoryChatAttachmentStore } from "../server/platform/chat/inMemoryChatAttachmentStore.ts";
import {
    chatMediaAttachmentMatchesSession,
    createInMemoryChatMediaReferences,
} from "../server/platform/chat/inMemoryChatMediaReferences.ts";
import {
    type WebConfiguration,
    parseWebConfiguration,
} from "../server/platform/configuration/webConfiguration.ts";
import { createDockerBrokerClient } from "../server/platform/docker/dockerBrokerClient.ts";
import { createDescriptorWorkspaceFileReader } from "../server/platform/files/descriptorWorkspaceFileReader.ts";
import { createDescriptorWorkspaceFileUploadSpool } from "../server/platform/files/descriptorWorkspaceFileUploadSpool.ts";
import {
    assertReviewedOpenClawFileRoot,
    resolveReviewedOpenClawFileRoot,
} from "../server/platform/files/openClawFileRootConfiguration.ts";
import { resolveReviewedWorkspaceFileRoot } from "../server/platform/files/workspaceFileRootConfiguration.ts";
import {
    type DashboardProjectLayout,
    resolveDashboardProjectLayout,
} from "../server/platform/filesystem/projectLayout.ts";
import {
    createChatSessionActivitySupervisor,
    type ChatSessionActivitySupervisor,
} from "../server/platform/gateway/chatSessionActivitySupervisor.ts";
import {
    createChatTranscriptLifecycleSupervisor,
    type ChatTranscriptLifecycleSupervisor,
} from "../server/platform/gateway/chatTranscriptLifecycleSupervisor.ts";
import { createGatewayCredentialVerifier } from "../server/platform/gateway/gatewayCredentialVerifier.ts";
import { createOpenClawTasksSubscriptionSupervisor } from "../server/platform/gateway/openClawTasksSubscriptionSupervisor.ts";
import { createPersistentGatewayChatProvider } from "../server/platform/gateway/persistentGatewayChatProvider.ts";
import { createPersistentGatewayOpenClawSettingsProvider } from "../server/platform/gateway/persistentGatewayOpenClawSettingsProvider.ts";
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
import { productionCutoverRequiresValidationMode } from "../server/platform/release/deliveryCutoverValidation.ts";
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
    createChatMediaSourceFetcher,
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
import { createDashboardLogsService } from "./dashboardLogs.ts";
import {
    createDashboardTerminalComposition,
    type DashboardTerminalWorkspaceRoot,
} from "./dashboardTerminal.ts";
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
    | "backupService"
    | "chatRawHttpHandler"
    | "chatService"
    | "databaseObservabilityService"
    | "deliveryService"
    | "dockerService"
    | "workspaceFileRawHttpHandler"
    | "workspaceFilesService"
    | "disposeBeforeRuntime"
    | "gatewayConnectionService"
    | "gatewaySessionsService"
    | "hostname"
    | "mfaAccountLifecycle"
    | "mfaLoginLifecycle"
    | "jobService"
    | "logsService"
    | "monitoringCatalogService"
    | "monitoringService"
    | "openClawCronService"
    | "openClawConfigurationBackupRawHttpHandler"
    | "openClawSettingsService"
    | "openClawTasksService"
    | "securityAuditLifecycle"
    | "serviceActionsService"
    | "systemHealthDiagnosticsService"
    | "taskService"
    | "terminalService"
    | "terminalSocketBoundary"
> {
    readonly applicationRuntime: DashboardApplicationRuntime;
    readonly cutoverValidation?: boolean;
    readonly authenticationLeaseDurationMs?: number;
    /** Canonical public origin used by browser Origin checks behind the proxy. */
    readonly browserOrigin: string;
    /** Optional only for isolated composition tests; production always supplies it. */
    readonly dashboardLogMaintenanceRoot?: string;
    /** Optional only for isolated composition tests; production always supplies it. */
    readonly dashboardLogsRoot?: string;
    /** Private production state root used only by the fixed SQLite lifecycle reader. */
    readonly databaseStateDirectory?: string;
    /** Optional only for isolated composition tests; production supplies both. */
    readonly dockerBrokerDirectory?: string;
    readonly dockerBrokerSocket?: string;
    /** Optional server-only speech credential; absence keeps both voice controls hidden. */
    readonly elevenLabsApiKey?: Redacted.Redacted<string>;
    /** Direct-loopback endpoint shared by bootstrap verification and persistent Gateway traffic. */
    readonly gatewayUrl: string;
    /** Server-only Gateway credential used by the outgoing-media proxy. */
    readonly gatewayToken?: Redacted.Redacted<string>;
    readonly gatewayVerificationTimeoutMs?: number;
    /** Optional capability-scoped schedule registry; production uses the complete registry. */
    readonly jobActionDefinitions?: readonly JobActionDefinition[];
    /** Shared composition clock for deterministic lifecycle and request-auth behavior. */
    readonly now?: () => Date;
    /** Exact read-only OpenClaw configuration manifest; never passed to a writer. */
    readonly openClawFileRoot?: WorkspaceFileRootConfiguration;
    /** Optional separate read-only OpenClaw root used only for transcript-authorized media. */
    readonly openClawMediaFileRoot?: WorkspaceFileRootConfiguration;
    readonly recentAuthenticationWindowMs?: number;
    readonly sessionIdleDurationMs?: number;
    /** Verified immutable release used to require a matching fresh worker. */
    readonly verifiedReleaseId?: string;
    /** Optional only for isolated composition tests; production supplies both paths. */
    readonly terminalBrokerDirectory?: string;
    readonly terminalBrokerSocket?: string;
    readonly terminalRoots?: readonly DashboardTerminalWorkspaceRoot[];
    readonly totpSecretCipher: TotpSecretCipher;
    readonly trustedProxyAddresses?: readonly string[];
    /** Explicit WebAuthn trust configuration; request host headers are never used. */
    readonly webAuthnRelyingParty?: WebAuthnRelyingPartyConfiguration;
    readonly webAuthnVerificationTimeoutMs?: number;
    /** Optional only for isolated composition tests; production always supplies both. */
    readonly workspaceFileRoot?: WorkspaceFileRootConfiguration;
    readonly workspaceFileUploadSpoolRoot?: string;
}

interface DashboardChatMediaReferenceRefreshDependencies {
    readonly chatService: Pick<ChatService, "history">;
    readonly gatewaySessionsService: Pick<GatewaySessionsService, "list">;
}

interface DashboardChatMediaReferenceRouting {
    readonly refreshClass?: string;
    readonly sessions: readonly { readonly key: string }[];
}

export const dashboardChatMediaReferenceRefreshPageMaximum = 32;

async function resolveDashboardChatMediaReferenceRouting(
    gatewaySessionsService: Pick<GatewaySessionsService, "list">,
    attachmentId: string | undefined,
    signal: AbortSignal
): Promise<DashboardChatMediaReferenceRouting> {
    const snapshot = await gatewaySessionsService.list({ filter: "ALL" }, signal);
    if (attachmentId === undefined) return { sessions: snapshot.sessions };
    const sessions = snapshot.sessions.filter((session) =>
        chatMediaAttachmentMatchesSession(attachmentId, session.key)
    );
    return sessions.length === 1
        ? {
              refreshClass: attachmentId.replaceAll("-", "").slice(0, 12),
              sessions,
          }
        : { sessions: [] };
}

/**
 * Classifies one cache-miss id against the current bounded session inventory.
 * A unique routing-hint match gets its own class; legacy, random, ambiguous,
 * and unavailable inventories share the raw handler's single fallback class.
 * @param dependencies Bounded Gateway session read port.
 * @returns Abort-aware asynchronous refresh classifier.
 */
export function createDashboardChatMediaReferenceRefreshClass(
    dependencies: Pick<
        DashboardChatMediaReferenceRefreshDependencies,
        "gatewaySessionsService"
    >
): (attachmentId: string, signal: AbortSignal) => Promise<string | undefined> {
    return async (attachmentId, signal) => {
        const routing = await resolveDashboardChatMediaReferenceRouting(
            dependencies.gatewaySessionsService,
            attachmentId,
            signal
        );
        return routing.refreshClass;
    };
}

/**
 * Rehydrates the bounded visible media-reference window after process loss.
 * @param dependencies Bounded session and chat-history read ports.
 * @returns One shared raw-handler refresh callback.
 */
export function createDashboardChatMediaReferenceRefresh(
    dependencies: DashboardChatMediaReferenceRefreshDependencies
): (
    signal: AbortSignal,
    attachmentId?: string,
    mode?: "legacy" | "targeted"
) => Promise<void> {
    let legacyFallbackSessionOffset = 0;
    return async (signal, attachmentId, mode) => {
        const snapshot = await dependencies.gatewaySessionsService.list(
            { filter: "ALL" },
            signal
        );
        const candidateSessions =
            attachmentId === undefined
                ? snapshot.sessions
                : snapshot.sessions.filter((session) =>
                      chatMediaAttachmentMatchesSession(attachmentId, session.key)
                  );
        const routedSessions =
            attachmentId === undefined ||
            (mode !== "legacy" && candidateSessions.length === 1)
                ? candidateSessions
                : [];
        const fallbackSessionCount = snapshot.sessions.length;
        let sessions = routedSessions;
        if (
            attachmentId !== undefined &&
            routedSessions.length === 0 &&
            mode !== "targeted"
        ) {
            sessions = Array.from(
                { length: fallbackSessionCount },
                (_, offset) =>
                    snapshot.sessions[
                        (legacyFallbackSessionOffset + offset) % fallbackSessionCount
                    ]!
            );
        }
        let pagesRead = 0;
        let sessionsRead = 0;
        for (const session of sessions) {
            if (pagesRead >= dashboardChatMediaReferenceRefreshPageMaximum) break;
            sessionsRead += 1;
            try {
                let cursor = "0";
                const visitedCursors = new Set<string>();
                for (
                    let pageIndex = 0;
                    pageIndex < chatHistoryRetainedPageMaximum &&
                    pagesRead < dashboardChatMediaReferenceRefreshPageMaximum;
                    pageIndex += 1
                ) {
                    if (visitedCursors.has(cursor)) break;
                    visitedCursors.add(cursor);
                    pagesRead += 1;
                    const page = await dependencies.chatService.history(
                        {
                            cursor,
                            limit: chatHistoryPageMaximum,
                            sessionKey: session.key,
                        },
                        signal
                    );
                    if (page.nextCursor === undefined) break;
                    cursor = page.nextCursor;
                }
            } catch (error) {
                if (signal.aborted) throw error;
            }
        }
        if (
            attachmentId !== undefined &&
            routedSessions.length === 0 &&
            sessionsRead > 0 &&
            fallbackSessionCount > 0
        ) {
            legacyFallbackSessionOffset =
                (legacyFallbackSessionOffset + sessionsRead) % fallbackSessionCount;
        }
    };
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
    return new Bun.CryptoHasher("sha256").update(origin).digest("hex");
}

const unavailableOpenClawCronProvider: OpenClawCronProvider = Object.freeze({
    currentProcessInstanceId: (): undefined => {},
    get: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    list: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    listRuns: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    remove: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    run: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
    setScratch: () => Promise.reject(new OpenClawCronProviderError("unavailable")),
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
    let openClawLocalHistoryMediaFetcher:
        | ReturnType<typeof createDescriptorOpenClawLocalHistoryMediaFetcher>
        | undefined;
    let chatService: ChatService | undefined;
    let chatMaintenance: DashboardChatRuntimeMaintenance | undefined;
    let chatSessionActivitySupervisor: ChatSessionActivitySupervisor | undefined;
    let chatTranscriptLifecycleSupervisor: ChatTranscriptLifecycleSupervisor | undefined;
    let openClawTasksService: OpenClawTasksService | undefined;
    let openClawCronHeartbeatReader: OpenClawCronHeartbeatReader | undefined;
    let openClawConfigurationBackupRawHttpHandler:
        | OpenClawConfigurationBackupRawHttpHandler
        | undefined;
    let openClawConfigurationBackupTickets:
        | OpenClawConfigurationBackupTicketStore
        | undefined;
    let workspaceFilesService: WorkspaceFilesService | undefined;
    let openClawTasksSupervisor:
        | ReturnType<typeof createOpenClawTasksSubscriptionSupervisor>
        | undefined;
    const disposeComposition = async (): Promise<void> => {
        if (compositionDisposed) return;
        compositionDisposed = true;
        let failure: unknown;
        const disposeIndependently = async (
            dispose: () => Promise<void> | void
        ): Promise<void> => {
            try {
                await dispose();
            } catch (error) {
                failure ??= error;
            }
        };
        await disposeIndependently(() => chatMaintenance?.stop());
        await disposeIndependently(() => chatSessionActivitySupervisor?.stop());
        await disposeIndependently(() => chatTranscriptLifecycleSupervisor?.stop());
        await disposeIndependently(() => openClawTasksSupervisor?.stop());
        await disposeIndependently(() => workspaceFilesService?.dispose());
        await disposeIndependently(() => openClawCronHeartbeatReader?.disposeHeartbeat());
        await disposeIndependently(() => chatService?.dispose());
        await disposeIndependently(() => openClawConfigurationBackupTickets?.dispose());
        await disposeIndependently(() => openClawLocalHistoryMediaFetcher?.dispose());
        await disposeIndependently(() => chatAttachmentStore?.dispose());
        await disposeIndependently(() => chatMediaReferences?.dispose());
        if (failure instanceof Error) throw failure;
        if (failure !== undefined) {
            throw new Error("Dashboard composition disposal failed", {
                cause: failure,
            });
        }
    };
    try {
        if (
            (options.dashboardLogsRoot === undefined) !==
            (options.dashboardLogMaintenanceRoot === undefined)
        ) {
            throw new TypeError(
                "Dashboard logs and log-maintenance roots must be configured together"
            );
        }
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
        const cacheRepository = createCacheRepository(database, databaseRuntime);
        const jobRepository = createJobRepository(database, databaseRuntime);
        const backupActivityRepository = createBackupActivityRepository(
            database,
            jobRepository
        );
        const backupService = createBackupService({
            activityRepository: backupActivityRepository,
            auditWriter: createSqliteBackupOperationAuditWriter({
                ...(options.now === undefined ? {} : { clock: options.now }),
                database,
                writeAdmission: databaseRuntime,
            }),
            ...(options.now === undefined
                ? {}
                : { nowMs: () => options.now!().getTime() }),
            operationQueue: createBackupOperationQueue({
                ...(options.now === undefined
                    ? {}
                    : { nowMs: () => options.now!().getTime() }),
                repository: jobRepository,
                ...(options.verifiedReleaseId === undefined
                    ? {}
                    : { requiredWorkerReleaseId: options.verifiedReleaseId }),
                wakeEventPump: () =>
                    options.applicationRuntime.services.realtimeEvents.wake(),
            }),
            snapshotRepository: createBackupSnapshotRepository(cacheRepository),
        });
        const scheduleActionDefinitions =
            options.jobActionDefinitions ?? jobActionDefinitions;
        const observabilityNow = options.now;
        const databaseObservabilityService = createDatabaseObservabilityService({
            ...(observabilityNow === undefined
                ? {}
                : { nowMs: () => observabilityNow().getTime() }),
            readDiagnostics: databaseRuntime.diagnostics,
            ...(options.databaseStateDirectory === undefined
                ? {}
                : {
                      lifecycleReader: createSqliteLifecycleReader({
                          ...(observabilityNow === undefined
                              ? {}
                              : { nowMs: () => observabilityNow().getTime() }),
                          repository: jobRepository,
                          stateDirectory: options.databaseStateDirectory,
                      }),
                  }),
            snapshotRepository:
                createDatabaseObservabilitySnapshotRepository(cacheRepository),
        });
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
        const dockerBrokerConfigured =
            options.dockerBrokerDirectory !== undefined ||
            options.dockerBrokerSocket !== undefined;
        if (
            dockerBrokerConfigured &&
            (options.dockerBrokerDirectory === undefined ||
                options.dockerBrokerSocket === undefined)
        ) {
            throw new TypeError("Docker broker paths must be configured together");
        }
        const dockerService =
            options.dockerBrokerDirectory === undefined ||
            options.dockerBrokerSocket === undefined
                ? undefined
                : createDockerService({
                      auditWriter: createSqliteDockerOperationAuditWriter({
                          ...(domainNow === undefined ? {} : { clock: domainNow }),
                          database,
                          writeAdmission: databaseRuntime,
                      }),
                      ...(domainNow === undefined
                          ? {}
                          : { nowMs: () => domainNow().getTime() }),
                      onAuditSettlementFailure: ({ operation, settlement }) =>
                          options.applicationRuntime.logger.error({
                              component: "docker-audit",
                              event: "docker.audit_settlement.failed",
                              failure: new Error(
                                  `Docker ${operation} audit ${settlement} settlement failed`
                              ),
                              outcome: "server-error",
                          }),
                      operationQueue: createDockerOperationQueue({
                          ...(domainNow === undefined
                              ? {}
                              : { nowMs: () => domainNow().getTime() }),
                          repository: jobRepository,
                          ...(options.verifiedReleaseId === undefined
                              ? {}
                              : {
                                    requiredWorkerReleaseId: options.verifiedReleaseId,
                                }),
                          wakeEventPump,
                      }),
                      snapshotRepository:
                          createDockerOverviewSnapshotRepository(cacheRepository),
                      workerReadPort: createDockerBrokerClient({
                          directory: options.dockerBrokerDirectory,
                          socketPath: options.dockerBrokerSocket,
                      }),
                  });
        const deliveryService = createDeliveryService({
            auditWriter: createSqliteDeliveryOperationAuditWriter({
                ...(domainNow === undefined ? {} : { clock: domainNow }),
                database,
                writeAdmission: databaseRuntime,
            }),
            deploymentHistory: createDeliveryDeploymentHistoryReader({
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                repository: {
                    listByActionKey(actionKey, limit) {
                        return jobRepository.listActionRuns({ actionKey, limit });
                    },
                },
            }),
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            onAuditSettlementFailure: ({ operation, settlement }) =>
                options.applicationRuntime.logger.error({
                    component: "delivery-audit",
                    event: "delivery.audit_settlement.failed",
                    failure: new Error(
                        `Delivery ${operation} audit ${settlement} settlement failed`
                    ),
                    outcome: "server-error",
                }),
            operationQueue: createDeliveryOperationQueue({
                actionDefinitions: {
                    "delivery.github": {
                        ...deliveryGitHubJobActionDefinition,
                        actionKey: "delivery.github",
                    },
                    "delivery.preview": {
                        ...deliveryPreviewJobActionDefinition,
                        actionKey: "delivery.preview",
                    },
                    "delivery.production.v1": {
                        ...deliveryProductionJobActionDefinition,
                        actionKey: "delivery.production.v1",
                    },
                },
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                repository: jobRepository,
                requiredWorkerReleaseId: (actionKey) =>
                    actionKey === deliveryProductionJobActionDefinition.actionKey
                        ? null
                        : options.verifiedReleaseId,
                wakeEventPump,
            }),
            snapshotRepository: createDeliveryOverviewSnapshotRepository(cacheRepository),
        });
        const taskRepository = createTaskRepository(database, databaseRuntime);
        const taskService = createTaskService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: taskRepository,
            wakeEventPump,
        });
        await reconcileJobSchedules({
            actionDefinitions: scheduleActionDefinitions,
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: jobRepository,
            wakeEventPump,
        });
        const jobService = createJobService({
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            repository: jobRepository,
            wakeEventPump,
        });
        const serviceActionDefinitions = Object.freeze({
            "openclaw-cleanup": openClawSessionsCleanupJobActionDefinition,
            "openclaw-restart": openClawGatewayRestartJobActionDefinition,
            "openclaw-update": openClawInstallationUpdateJobActionDefinition,
            "system-cleanup": hostSystemCleanupJobActionDefinition,
            "system-restart": hostSystemRestartJobActionDefinition,
            "system-update": hostSystemUpdateJobActionDefinition,
        });
        const serviceActionsService = createServiceActionsService({
            auditWriter: createSqliteServiceActionAuditWriter({
                ...(domainNow === undefined ? {} : { clock: domainNow }),
                database,
                writeAdmission: databaseRuntime,
            }),
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            onAuditSettlementFailure: ({ actionId, cause, settlement }) =>
                options.applicationRuntime.logger.error({
                    component: "service-actions-audit",
                    event: "service_actions.audit_settlement.failed",
                    failure: cause,
                    fields: {
                        actionId,
                        kind: "service-actions-audit-settlement",
                        settlement,
                    },
                    outcome: "server-error",
                }),
            queue: createServiceActionQueue({
                definitions: serviceActionDefinitions,
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                repository: jobRepository,
                ...(options.verifiedReleaseId === undefined
                    ? {}
                    : { requiredWorkerReleaseId: options.verifiedReleaseId }),
                wakeEventPump,
            }),
            statusReader:
                options.verifiedReleaseId === undefined
                    ? Object.freeze({
                          read(signal?: AbortSignal) {
                              signal?.throwIfAborted();
                              return Promise.resolve(
                                  serviceActionIds.map((id) =>
                                      Object.freeze({
                                          availability: "unavailable" as const,
                                          id,
                                      })
                                  )
                              );
                          },
                      })
                    : createSqliteServiceActionStatusReader({
                          expectedReleaseId: options.verifiedReleaseId,
                          ...(domainNow === undefined
                              ? {}
                              : { nowMs: () => domainNow().getTime() }),
                          repository: jobRepository,
                      }),
        });
        const logsService =
            options.dashboardLogsRoot === undefined ||
            options.dashboardLogMaintenanceRoot === undefined
                ? undefined
                : createDashboardLogsService({
                      dashboardLogsRoot: options.dashboardLogsRoot,
                      database,
                      jobRepository,
                      logMaintenanceRoot: options.dashboardLogMaintenanceRoot,
                      ...(domainNow === undefined ? {} : { now: domainNow }),
                      onAuditSettlementFailure: ({ dryRun, policyId, settlement }) =>
                          options.applicationRuntime.logger.error({
                              component: "logs-maintenance-audit",
                              event: "logs.maintenance.audit_settlement_failed",
                              fields: {
                                  kind: "logs-maintenance-audit-settlement",
                                  dryRun,
                                  policyId,
                                  settlement,
                              },
                              outcome: "server-error",
                          }),
                      wakeEventPump,
                      writeAdmission: databaseRuntime,
                  });
        if (
            (options.workspaceFileRoot === undefined) !==
            (options.workspaceFileUploadSpoolRoot === undefined)
        ) {
            throw new TypeError(
                "Workspace Files root and upload spool must be configured together"
            );
        }
        if (
            options.openClawFileRoot !== undefined &&
            options.workspaceFileRoot === undefined
        ) {
            throw new TypeError(
                "OpenClaw Files root requires the workspace Files composition"
            );
        }
        if (options.openClawFileRoot !== undefined) {
            assertReviewedOpenClawFileRoot(options.openClawFileRoot);
        }
        const terminalBrokerConfigured =
            options.terminalBrokerDirectory !== undefined ||
            options.terminalBrokerSocket !== undefined;
        if (
            terminalBrokerConfigured &&
            (options.workspaceFileRoot === undefined ||
                options.terminalBrokerDirectory === undefined ||
                options.terminalBrokerSocket === undefined)
        ) {
            throw new TypeError(
                "Terminal broker paths and workspace starting root must be configured together"
            );
        }
        const terminalComposition =
            options.workspaceFileRoot === undefined ||
            options.terminalBrokerDirectory === undefined ||
            options.terminalBrokerSocket === undefined
                ? undefined
                : await createDashboardTerminalComposition({
                      authenticateCredential: (credential) =>
                          authenticator.authenticate(credential),
                      authenticationLifecycle,
                      browserOrigin,
                      database,
                      ...(domainNow === undefined ? {} : { now: domainNow }),
                      terminalBrokerDirectory: options.terminalBrokerDirectory,
                      terminalBrokerSocket: options.terminalBrokerSocket,
                      roots: options.terminalRoots ?? [options.workspaceFileRoot],
                      writeAdmission: databaseRuntime,
                  });
        let workspaceFileRawHttpHandler: WorkspaceFileRawHttpHandler | undefined;
        let openClawConfigurationBackupSource:
            | ReturnType<typeof createWorkspaceFileOpenClawConfigurationBackupSource>
            | undefined;
        if (
            options.workspaceFileRoot !== undefined &&
            options.workspaceFileUploadSpoolRoot !== undefined
        ) {
            const workspaceFileReader = createDescriptorWorkspaceFileReader({
                roots: [
                    options.workspaceFileRoot,
                    ...(options.openClawFileRoot === undefined
                        ? []
                        : [options.openClawFileRoot]),
                ],
            });
            workspaceFilesService = createWorkspaceFilesService({
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                reader: workspaceFileReader,
                scheduler: createWorkspaceFileJobScheduler({
                    ...(domainNow === undefined
                        ? {}
                        : { nowMs: () => domainNow().getTime() }),
                    repository: jobRepository,
                    wakeEventPump,
                }),
                spool: createDescriptorWorkspaceFileUploadSpool(
                    options.workspaceFileUploadSpoolRoot,
                    domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }
                ),
            });
            await workspaceFilesService.cleanupUploadOrphans();
            workspaceFileRawHttpHandler = createWorkspaceFileRawHttpHandler({
                authenticateCredential: (credential) =>
                    authenticator.authenticate(credential),
                authorizeWrite: (identity) =>
                    authenticationLifecycle.authorizeRecentMfa(identity),
                browserOrigin,
                service: workspaceFilesService,
            });
            if (options.openClawFileRoot !== undefined) {
                openClawConfigurationBackupSource =
                    createWorkspaceFileOpenClawConfigurationBackupSource(
                        workspaceFileReader
                    );
                openClawConfigurationBackupTickets =
                    createOpenClawConfigurationBackupTicketStore(
                        domainNow === undefined
                            ? {}
                            : { nowMs: () => domainNow().getTime() }
                    );
                openClawConfigurationBackupRawHttpHandler =
                    createOpenClawConfigurationBackupRawHttpHandler({
                        authenticateCredential: (credential) =>
                            authenticator.authenticate(credential),
                        authorizeAccess: (identity) =>
                            authenticationLifecycle.authorizeRecentMfa(identity),
                        browserOrigin,
                        tickets: openClawConfigurationBackupTickets,
                    });
            }
        }
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
        const unavailableOpenClawSettingsProvider: OpenClawSettingsProvider =
            Object.freeze({
                getConfiguration: () =>
                    Promise.reject(new OpenClawSettingsProviderError("unavailable")),
                listSkills: () =>
                    Promise.reject(new OpenClawSettingsProviderError("unavailable")),
                setSkillEnabled: () =>
                    Promise.reject(new OpenClawSettingsProviderError("unavailable")),
                updateConfiguration: () =>
                    Promise.reject(new OpenClawSettingsProviderError("unavailable")),
            });
        const openClawSettingsService = createOpenClawSettingsService({
            auditWriter: createSqliteOpenClawSettingsOperationAuditWriter({
                ...(domainNow === undefined ? {} : { clock: domainNow }),
                database,
                writeAdmission: databaseRuntime,
            }),
            onAuditSettlementFailure: ({
                cause,
                operation,
                settlement,
                targetFingerprint,
            }) =>
                options.applicationRuntime.logger.warn({
                    component: "openclaw-settings-audit",
                    event: "openclaw_settings.audit_settlement.failed",
                    failure: cause,
                    fields: {
                        kind: "openclaw-settings-audit-settlement",
                        operation,
                        settlement,
                        targetFingerprint,
                    },
                    outcome: "server-error",
                }),
            ...(openClawConfigurationBackupSource === undefined ||
            openClawConfigurationBackupTickets === undefined
                ? {}
                : {
                      backupSource: openClawConfigurationBackupSource,
                      backupTickets: openClawConfigurationBackupTickets,
                  }),
            onMutationQueueWait: ({ queueDepth, waitMs }) =>
                options.applicationRuntime.logger.info({
                    component: "openclaw-settings",
                    durationMs: waitMs,
                    event: "openclaw_settings.mutation_queue.waited",
                    fields: {
                        kind: "openclaw-settings-mutation-queue",
                        queueDepth,
                    },
                    outcome: "success",
                }),
            provider:
                persistentGatewayTransport === undefined
                    ? unavailableOpenClawSettingsProvider
                    : createPersistentGatewayOpenClawSettingsProvider(
                          persistentGatewayTransport
                      ),
            restartQueue: createOpenClawGatewayRestartQueue({
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                repository: jobRepository,
                wakeEventPump,
            }),
        });
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
        options.applicationRuntime.services.systemMetrics.configureApplicationReader?.(
            createSystemApplicationMetricsReader({
                cacheRepository,
                ...(chatRepository === undefined ? {} : { chatReader: chatRepository }),
                databaseDiagnostics: databaseRuntime.diagnostics,
                gatewayConnectionService,
                jobReader: jobRepository,
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                realtimeMetrics: () =>
                    options.applicationRuntime.services.realtimeEvents.metrics(),
            })
        );
        const chatTranscriptLifecycle =
            chatRepository === undefined
                ? undefined
                : createChatTranscriptLifecycleCoordinator(chatRepository);
        const gatewaySessionsProvider =
            persistentGatewayTransport === undefined
                ? unavailableGatewaySessionsProvider
                : createPersistentGatewaySessionsProvider(persistentGatewayTransport);
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
            provider: gatewaySessionsProvider,
            ...(chatTranscriptLifecycle === undefined
                ? {}
                : { transcriptLifecycle: chatTranscriptLifecycle }),
        });
        const systemHealthDiagnosticsService = createSystemHealthDiagnosticsService({
            ...(options.verifiedReleaseId === undefined
                ? {}
                : { expectedWorkerReleaseId: options.verifiedReleaseId }),
            frontendReady: options.frontendAssets !== undefined,
            gatewayConnectionService,
            gatewaySessionsReader: gatewaySessionsService,
            jobHealthReader: jobRepository,
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            readiness: options.readiness,
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
            const openClawMediaFileRoot =
                options.openClawMediaFileRoot ?? options.openClawFileRoot;
            chatMediaReferences = createInMemoryChatMediaReferences({
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                ...(openClawMediaFileRoot === undefined
                    ? {}
                    : {
                          localMediaRoot: path.join(openClawMediaFileRoot.path, "media"),
                      }),
            });
            chatService = createChatService({
                activeProviderRunIds: async (sessionKey, signal) => {
                    const snapshot = await gatewaySessionsProvider.listCurrentSessions({
                        limit: gatewaySessionProjectionMaximum,
                        ...(signal === undefined ? {} : { signal }),
                    });
                    if (snapshot.truncated) return;
                    const session = snapshot.sessions.find(
                        ({ key }) => key === sessionKey
                    );
                    if (session === undefined) return;
                    if (session.activeRunIds !== undefined) {
                        return session.activeRunIds;
                    }
                    return session.hasActiveRun ? undefined : [];
                },
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
            chatSessionActivitySupervisor = createChatSessionActivitySupervisor({
                chat: chatService,
                mediaReferences: chatMediaReferences,
                onFailure: () =>
                    options.applicationRuntime.logger.warn({
                        component: "chat-session-activity",
                        event: "chat.session_activity.reconciliation_failed",
                        failure: new Error("Chat session activity reconciliation failed"),
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

            if (openClawMediaFileRoot !== undefined) {
                openClawLocalHistoryMediaFetcher =
                    createDescriptorOpenClawLocalHistoryMediaFetcher({
                        openClawRoot: openClawMediaFileRoot,
                    });
            }
            if (
                options.gatewayToken !== undefined ||
                openClawLocalHistoryMediaFetcher !== undefined
            ) {
                const gatewayManagedMediaFetcher =
                    options.gatewayToken === undefined
                        ? undefined
                        : createOpenClawOutgoingMediaFetcher({
                              gatewayUrl: options.gatewayUrl,
                              token: options.gatewayToken,
                          });
                const localHistoryMediaFetcher = openClawLocalHistoryMediaFetcher;
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
                    mediaFetcher: createChatMediaSourceFetcher({
                        ...(gatewayManagedMediaFetcher === undefined
                            ? {}
                            : { gatewayManaged: gatewayManagedMediaFetcher }),
                        ...(localHistoryMediaFetcher === undefined
                            ? {}
                            : {
                                  localHistory: {
                                      fetch: (request) =>
                                          request.source.kind === "openclaw-local-history"
                                              ? localHistoryMediaFetcher.fetch({
                                                    method: request.method,
                                                    ...(request.range === undefined
                                                        ? {}
                                                        : { range: request.range }),
                                                    segments: request.source.segments,
                                                    signal: request.signal,
                                                })
                                              : Promise.resolve(
                                                    new Response(null, {
                                                        status: 404,
                                                    })
                                                ),
                                  },
                              }),
                    }),
                    mediaReferences: chatMediaReferences,
                    refreshMediaReferences: createDashboardChatMediaReferenceRefresh({
                        chatService: activeChatService,
                        gatewaySessionsService,
                    }),
                    mediaReferenceRefreshClass:
                        createDashboardChatMediaReferenceRefreshClass({
                            gatewaySessionsService,
                        }),
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
        openClawCronHeartbeatReader = openClawCronService;
        const cacheService = createCacheService({
            cacheRepository,
            jobRepository,
            ...(domainNow === undefined ? {} : { nowMs: () => domainNow().getTime() }),
            readGatewayConnection: gatewayConnectionService.get,
            readGatewaySessionsProjection: gatewaySessionsService.readHeartbeatProjection,
            readHeartbeatDashboardJobs: (generatedAtMs) =>
                readCacheHeartbeatDashboardJobs(
                    jobRepository,
                    generatedAtMs,
                    scheduleActionDefinitions
                ),
            readHeartbeatTasks: () =>
                readCacheHeartbeatTasksWithCronRefresh(
                    () =>
                        taskRepository.withReadTransaction((reader) =>
                            reader.readHeartbeatCandidates()
                        ),
                    openClawCronService.refreshHeartbeatProjection,
                    openClawCronService.readHeartbeatJobProjection
                ),
            readOpenClawCronProjection: openClawCronService.readHeartbeatProjection,
            readOperationalSignals: createCacheHeartbeatOperationalSignalsReader({
                ...createCacheHeartbeatOverviewSignalReaders(
                    cacheRepository,
                    domainNow === undefined ? Date.now : () => domainNow().getTime()
                ),
                databaseService: databaseObservabilityService,
                readKopiaBackup: () =>
                    cacheHeartbeatBackupSignalFromStatus(backupService.getKopiaStatus()),
                readWalgBackup: () =>
                    cacheHeartbeatBackupSignalFromStatus(backupService.getWalgStatus()),
                ...(dockerService === undefined ? {} : { dockerService }),
                ...(logsService === undefined ? {} : { logsService }),
                ...(domainNow === undefined
                    ? {}
                    : { nowMs: () => domainNow().getTime() }),
                systemMetricsService: options.applicationRuntime.services.systemMetrics,
            }),
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
            backupService,
            applicationRuntime: options.applicationRuntime,
            authenticateCredential: (credential) =>
                authenticator.authenticate(credential),
            authenticationLifecycle,
            automationSecurityLifecycle,
            browserOrigin,
            cacheService,
            ...(options.cutoverValidation === undefined
                ? {}
                : { cutoverValidation: options.cutoverValidation }),
            ...(chatRawHttpHandler === undefined ? {} : { chatRawHttpHandler }),
            ...(chatService === undefined ? {} : { chatService }),
            databaseObservabilityService,
            deliveryService,
            ...(dockerService === undefined ? {} : { dockerService }),
            ...(workspaceFileRawHttpHandler === undefined
                ? {}
                : { workspaceFileRawHttpHandler }),
            ...(workspaceFilesService === undefined ? {} : { workspaceFilesService }),
            disposeBeforeRuntime: disposeComposition,
            gatewayConnectionService,
            gatewaySessionsService,
            frontendAssets: options.frontendAssets,
            gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
            hostname: "127.0.0.1",
            mfaAccountLifecycle,
            mfaLoginLifecycle,
            jobService,
            ...(logsService === undefined ? {} : { logsService }),
            monitoringCatalogService,
            monitoringService,
            openClawCronService,
            ...(openClawConfigurationBackupRawHttpHandler === undefined
                ? {}
                : { openClawConfigurationBackupRawHttpHandler }),
            openClawSettingsService,
            ...(openClawTasksService === undefined ? {} : { openClawTasksService }),
            port: options.port,
            readiness: options.readiness,
            securityAuditLifecycle,
            serviceActionsService,
            systemHealthDiagnosticsService,
            taskService,
            ...(terminalComposition === undefined
                ? {}
                : {
                      terminalService: terminalComposition.service,
                      terminalSocketBoundary: terminalComposition.socketBoundary,
                  }),
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
    readonly detectCutoverValidation?: (stateDirectory: string) => Promise<boolean>;
    readonly createTotpCipher: (serializedKeyring: string) => Promise<TotpSecretCipher>;
    readonly loadRelease: (
        releasesDirectory: string,
        releaseRoot: string,
        processRole: "web"
    ) => Promise<RuntimeRelease>;
    readonly resolveProjectLayout: (
        projectRoot: string
    ) => Promise<DashboardProjectLayout>;
    readonly resolveTerminalRoots: (
        openClawRoot: string,
        dashboardRoot: string
    ) => Promise<readonly DashboardTerminalWorkspaceRoot[]>;
    readonly resolveOpenClawFileRoot: typeof resolveReviewedOpenClawFileRoot;
    readonly resolveWorkspaceFileRoot: typeof resolveReviewedWorkspaceFileRoot;
}

async function resolveTerminalWorkspaceRoots(
    openClawRoot: string,
    dashboardRoot: string
): Promise<readonly DashboardTerminalWorkspaceRoot[]> {
    const roots: DashboardTerminalWorkspaceRoot[] = [
        { id: "openclaw", label: "OpenClaw", path: openClawRoot },
    ];
    try {
        if ((await realpath("/opt/docker")) === "/opt/docker") {
            roots.push({ id: "docker", label: "Docker", path: "/opt/docker" });
        }
    } catch {
        // An unavailable optional Docker root must not prevent Dashboard startup.
    }
    roots.push({ id: "dashboard", label: "Mira Dashboard", path: dashboardRoot });
    return Object.freeze(roots.map((root) => Object.freeze(root)));
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
    detectCutoverValidation: productionCutoverRequiresValidationMode,
    createTotpCipher: (serializedKeyring) => createTotpSecretCipher(serializedKeyring),
    loadRelease: (releasesDirectory, releaseRoot, processRole) =>
        loadRuntimeRelease(releasesDirectory, releaseRoot, processRole),
    resolveProjectLayout: resolveDashboardProjectLayout,
    resolveTerminalRoots: resolveTerminalWorkspaceRoots,
    resolveOpenClawFileRoot: resolveReviewedOpenClawFileRoot,
    resolveWorkspaceFileRoot: resolveReviewedWorkspaceFileRoot,
} satisfies DashboardWebProcessDependencies);

/**
 * Returns the reviewed production web-process dependency set for narrow composition overrides.
 * Development replaces only release loading, frontend assets, and database startup; production
 * callers continue to use this exact frozen object unchanged.
 * @returns The frozen default web-process dependencies.
 */
export function createDefaultDashboardWebProcessDependencies(): DashboardWebProcessDependencies {
    return defaultWebProcessDependencies;
}

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
    const workspaceFileRoot = await dependencies.resolveWorkspaceFileRoot(
        configuration.workspaceRoot,
        layout
    );
    const openClawFileRoot = await dependencies.resolveOpenClawFileRoot(
        configuration.openClawRoot,
        layout.production.root
    );
    const terminalRoots = await dependencies.resolveTerminalRoots(
        openClawFileRoot.path,
        layout.root
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
        const readiness = createReadinessController();
        const cutoverValidation = await (
            dependencies.detectCutoverValidation ??
            productionCutoverRequiresValidationMode
        )(layout.production.state.root);
        const frontendAssets = await dependencies.createFrontendAssets(release);
        const totpSecretCipher = await dependencies.createTotpCipher(
            Redacted.value(configuration.totpKeyring)
        );
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
            ...(cutoverValidation
                ? {
                      cutoverValidation: true,
                      jobActionDefinitions: managedPreviewJobActionDefinitions,
                  }
                : {}),
            dashboardLogMaintenanceRoot: layout.production.state.logMaintenance,
            dashboardLogsRoot: layout.production.state.logs,
            databaseStateDirectory: layout.production.state.root,
            dockerBrokerDirectory: layout.production.state.terminalBroker,
            dockerBrokerSocket: layout.production.state.dockerBrokerSocket,
            ...(configuration.elevenLabsApiKey === undefined
                ? {}
                : { elevenLabsApiKey: configuration.elevenLabsApiKey }),
            frontendAssets,
            gatewayUrl: configuration.gatewayUrl,
            gatewayToken: configuration.gatewayToken,
            openClawFileRoot,
            port: configuration.port,
            readiness,
            recentAuthenticationWindowMs: configuration.recentAuthenticationWindowMs,
            sessionIdleDurationMs: configuration.sessionIdleDurationMs,
            terminalBrokerDirectory: layout.production.state.terminalBroker,
            terminalBrokerSocket: layout.production.state.terminalBrokerSocket,
            terminalRoots,
            totpSecretCipher,
            trustedProxyAddresses: configuration.trustedProxyAddresses,
            verifiedReleaseId: release.manifest.source.commitSha,
            webAuthnRelyingParty: configuration.webAuthnRelyingParty,
            workspaceFileRoot,
            workspaceFileUploadSpoolRoot: layout.production.state.workspaceFileUploads,
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
