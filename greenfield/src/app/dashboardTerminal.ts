import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../server/database/immediateWriteAdmission.ts";
import type { AuthenticationLifecycleService } from "../server/domains/security/authenticationLifecycle.ts";
import { createSqliteTerminalOperationAuditWriter } from "../server/domains/terminal/operationAudit.ts";
import {
    createTerminalService,
    type TerminalService,
} from "../server/domains/terminal/service.ts";
import { createBunUnixTerminalBrokerTransport } from "../server/platform/terminal/bunUnixTerminalBrokerTransport.ts";
import { createTerminalRootRegistry } from "../server/platform/terminal/rootRegistry.ts";
import { createTerminalBrokerClient } from "../server/platform/terminal/terminalBrokerClient.ts";
import {
    createTerminalSocketBoundary,
    type TerminalSocketBoundary,
} from "../server/rawHttp/terminalSocket.ts";
import type { AuthenticateCredential } from "../server/trpc/context.ts";

export interface DashboardTerminalWorkspaceRoot {
    readonly id: string;
    readonly label: string;
    readonly path: string;
}

/** Web-process inputs for the worker-owned interactive terminal control plane. */
export interface DashboardTerminalOptions {
    readonly authenticateCredential: AuthenticateCredential;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly browserOrigin: string;
    readonly database: SQLiteBunDatabase;
    readonly now?: () => Date;
    readonly terminalBrokerDirectory: string;
    readonly terminalBrokerSocket: string;
    readonly workspaceRoot: DashboardTerminalWorkspaceRoot;
    readonly writeAdmission: ImmediateDatabaseWriteAdmission;
}

export interface DashboardTerminalComposition {
    readonly service: TerminalService;
    readonly socketBoundary: TerminalSocketBoundary;
}

/**
 * Composes the web control plane and WebSocket relay over the worker's private Unix socket.
 * The workspace root fences only the initial directory; the interactive shell is not a
 * filesystem sandbox.
 * @param options Authentication, audit, broker path, and reviewed starting-root inputs.
 * @returns The tRPC lifecycle service and raw WebSocket boundary.
 */
export async function createDashboardTerminalComposition(
    options: DashboardTerminalOptions
): Promise<DashboardTerminalComposition> {
    const clock = options.now ?? (() => new Date());
    const roots = await createTerminalRootRegistry([
        {
            absolutePath: options.workspaceRoot.path,
            defaultPath: "/",
            id: options.workspaceRoot.id,
            label: options.workspaceRoot.label,
        },
    ]);
    const broker = createTerminalBrokerClient({
        transport: createBunUnixTerminalBrokerTransport({
            projectLocalDirectory: options.terminalBrokerDirectory,
            socketPath: options.terminalBrokerSocket,
        }),
    });
    const service = createTerminalService({
        auditWriter: createSqliteTerminalOperationAuditWriter({
            clock,
            database: options.database,
            writeAdmission: options.writeAdmission,
        }),
        broker,
        nowMs: () => clock().getTime(),
        roots,
    });
    const socketBoundary = createTerminalSocketBoundary({
        authenticateCredential: options.authenticateCredential,
        authenticationLifecycle: options.authenticationLifecycle,
        broker,
        browserOrigin: options.browserOrigin,
        nowMs: () => clock().getTime(),
    });
    return Object.freeze({ service, socketBoundary });
}
