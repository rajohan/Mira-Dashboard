import type { RequestAuthentication } from "../../contracts/security.ts";
import type { AgentService } from "../domains/agents/service.ts";
import type { CacheService } from "../domains/cache/service.ts";
import type { ChatService } from "../domains/chat/service.ts";
import type { WorkspaceFilesService } from "../domains/files/service.ts";
import type { GatewayConnectionService } from "../domains/gatewayConnection/service.ts";
import type { GatewaySessionsService } from "../domains/gatewaySessions/service.ts";
import type { JobService } from "../domains/jobs/service.ts";
import type { LogsService } from "../domains/logs/service.ts";
import type { MonitoringCatalogService } from "../domains/monitoring/catalogService.ts";
import type { MonitoringService } from "../domains/monitoring/service.ts";
import type { OpenClawCronService } from "../domains/openClawCron/service.ts";
import type { OpenClawSettingsService } from "../domains/openClawSettings/service.ts";
import type { OpenClawTasksService } from "../domains/openClawTasks/service.ts";
import type { AuthenticationLifecycleService } from "../domains/security/authenticationLifecycle.ts";
import {
    type AuthenticationLease,
    parseAuthenticationResolution,
} from "../domains/security/authenticationResolution.ts";
import type { AutomationSecurityLifecycleService } from "../domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../domains/security/securityAuditLifecycle.ts";
import type { ServiceActionsService } from "../domains/serviceActions/service.ts";
import type { SystemHealthDiagnosticsService } from "../domains/system/healthDiagnosticsService.ts";
import type { TaskService } from "../domains/tasks/service.ts";
import type { TerminalService } from "../domains/terminal/service.ts";
import type {
    ApplicationRuntime,
    ApplicationRuntimeServices,
} from "../platform/runtime/applicationRuntime.ts";
import {
    type PendingLoginCredential,
    type RawAuthenticationCredential,
} from "../rawHttp/authenticationCredentials.ts";

/** Parsed-credential authenticator supplied by the security composition root. */
export type AuthenticateCredential = (credential: RawAuthenticationCredential) => unknown;

/** Dependencies supplied while constructing one application request context. */
export interface RequestContextOptions {
    readonly agentService: AgentService["Service"];
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationCredential: RawAuthenticationCredential;
    readonly authenticationClientSourceId: string;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticateCredential: AuthenticateCredential;
    readonly cacheService: CacheService["Service"];
    readonly chatService?: ChatService;
    readonly workspaceFilesService?: WorkspaceFilesService;
    readonly gatewayConnectionService: GatewayConnectionService;
    readonly gatewaySessionsService: GatewaySessionsService;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly jobService: JobService["Service"];
    readonly logsService?: LogsService;
    readonly monitoringCatalogService: MonitoringCatalogService["Service"];
    readonly monitoringService: MonitoringService["Service"];
    readonly openClawCronService: OpenClawCronService;
    readonly openClawSettingsService: OpenClawSettingsService;
    readonly openClawTasksService?: OpenClawTasksService;
    readonly pendingLoginCredential: PendingLoginCredential;
    readonly request: Request;
    readonly requestId: string;
    readonly responseHeaders: Headers;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly serviceActionsService: ServiceActionsService;
    readonly systemHealthDiagnosticsService: SystemHealthDiagnosticsService;
    readonly taskService: TaskService["Service"];
    readonly terminalService?: TerminalService;
}

/** Dependencies supplied to every application tRPC procedure. */
export interface RequestContext {
    readonly agentService: AgentService["Service"];
    readonly authentication: RequestAuthentication;
    readonly authenticationClientSourceId: string;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticationLease?: AuthenticationLease;
    readonly cacheService: CacheService["Service"];
    readonly chatService?: ChatService;
    readonly workspaceFilesService?: WorkspaceFilesService;
    readonly gatewayConnectionService: GatewayConnectionService;
    readonly gatewaySessionsService: GatewaySessionsService;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly jobService: JobService["Service"];
    readonly logsService?: LogsService;
    readonly monitoringCatalogService: MonitoringCatalogService["Service"];
    readonly monitoringService: MonitoringService["Service"];
    readonly openClawCronService: OpenClawCronService;
    readonly openClawSettingsService: OpenClawSettingsService;
    readonly openClawTasksService?: OpenClawTasksService;
    readonly pendingLoginCredential: PendingLoginCredential;
    readonly requestId: string;
    readonly responseHeaders: Headers;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly serviceActionsService: ServiceActionsService;
    readonly systemHealthDiagnosticsService: SystemHealthDiagnosticsService;
    readonly taskService: TaskService["Service"];
    readonly terminalService?: TerminalService;
    readonly services: ApplicationRuntimeServices;
    readonly userAgent?: string;
}

/**
 * Builds request-scoped tRPC context from explicitly injected runtime and auth services.
 * @param options Request and process-owned dependencies.
 * @returns Validated immutable request context.
 */
export async function createRequestContext(
    options: RequestContextOptions
): Promise<RequestContext> {
    const resolution = parseAuthenticationResolution(
        await options.authenticateCredential(options.authenticationCredential)
    );
    const userAgent = options.request.headers.get("user-agent");
    return Object.freeze({
        agentService: options.agentService,
        authentication: resolution.authentication,
        authenticationClientSourceId: options.authenticationClientSourceId,
        authenticationLifecycle: options.authenticationLifecycle,
        automationSecurityLifecycle: options.automationSecurityLifecycle,
        cacheService: options.cacheService,
        ...(options.chatService === undefined
            ? {}
            : { chatService: options.chatService }),
        ...(options.workspaceFilesService === undefined
            ? {}
            : { workspaceFilesService: options.workspaceFilesService }),
        gatewayConnectionService: options.gatewayConnectionService,
        gatewaySessionsService: options.gatewaySessionsService,
        mfaAccountLifecycle: options.mfaAccountLifecycle,
        mfaLoginLifecycle: options.mfaLoginLifecycle,
        jobService: options.jobService,
        ...(options.logsService === undefined
            ? {}
            : { logsService: options.logsService }),
        monitoringCatalogService: options.monitoringCatalogService,
        monitoringService: options.monitoringService,
        openClawCronService: options.openClawCronService,
        openClawSettingsService: options.openClawSettingsService,
        ...(options.openClawTasksService === undefined
            ? {}
            : { openClawTasksService: options.openClawTasksService }),
        ...(resolution.lease && { authenticationLease: resolution.lease }),
        pendingLoginCredential: options.pendingLoginCredential,
        requestId: options.requestId,
        responseHeaders: options.responseHeaders,
        securityAuditLifecycle: options.securityAuditLifecycle,
        serviceActionsService: options.serviceActionsService,
        systemHealthDiagnosticsService: options.systemHealthDiagnosticsService,
        taskService: options.taskService,
        ...(options.terminalService === undefined
            ? {}
            : { terminalService: options.terminalService }),
        services: options.applicationRuntime.services,
        ...(userAgent !== null && { userAgent }),
    });
}
