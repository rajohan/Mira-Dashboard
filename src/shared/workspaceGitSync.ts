export interface WorkspaceGitSyncResult {
    readonly changedFileCount: number;
    readonly commit?: string;
    readonly pushed: boolean;
}

export class WorkspaceGitSyncOutcomeUnknownError extends Error {
    public constructor() {
        super("OpenClaw workspace Git synchronization outcome is unknown");
        this.name = "WorkspaceGitSyncOutcomeUnknownError";
    }
}
