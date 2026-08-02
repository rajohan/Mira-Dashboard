import type { PullRequestPreviewLifecycle } from "../../../../contracts/delivery/previews.ts";

export const PREVIEW_RECORD_FORMAT_VERSION = 1 as const;

export interface PullRequestPreviewCandidate {
    authorLogins: Array<string | undefined>;
    commitSha: string;
    number: number;
    rootBaseRefName: string;
    title: string;
}

export interface PullRequestPreviewConfig {
    allowedAuthors: ReadonlySet<string>;
    backendPort: number;
    bunExecutable: string;
    dashboardRoot: string;
    databaseTemplate?: string;
    frontendPort: number;
    gatewayProxyEntrypoint: string;
    gatewayProxyIdentityFile: string;
    gatewayProxyPort: number;
    gatewayProxyUnitName: string;
    gatewayTokenFile: string;
    gatewayUpstreamTokenFile: string;
    gatewayUrl: string;
    gitCommonDirectory: string;
    managedWorktreePath: string;
    openClawConfigSource?: string;
    previewRoot: string;
    projectRoot: string;
    recentAuthMinutes?: string;
    releaseSource?: string;
    sessionIdleMinutes?: string;
    sourceWebAuthnRpId?: string;
    stateFile: string;
    unitName: string;
    workspaceSource?: string;
}

export interface PullRequestPreviewRecord {
    backendPort: number;
    commitSha: string;
    formatVersion: typeof PREVIEW_RECORD_FORMAT_VERSION;
    frontendPort: number;
    message?: string;
    number: number;
    ownsTailscaleServe: boolean;
    startedAt?: string;
    status: PullRequestPreviewLifecycle;
    title: string;
    updatedAt: string;
    url: string;
    worktreePath: string;
}
