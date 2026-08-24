import type { CreateOpenClawConfigurationBackupResult } from "../../../contracts/openClawSettings.ts";

/** The only descriptor-rooted source accepted for an OpenClaw configuration export. */
export const openClawConfigurationBackupLocator = Object.freeze({
    rootId: "openclaw-config",
    segments: Object.freeze(["openclaw.json"]),
});

export const openClawConfigurationBackupFileName = "openclaw.json";
export const openClawConfigurationBackupMimeType = "application/json";

export type OpenClawConfigurationBackupErrorReason =
    | "capacity"
    | "expired"
    | "invalid-source"
    | "not-found"
    | "unavailable";

/** Sanitized export failure that never retains source bytes or filesystem diagnostics. */
export class OpenClawConfigurationBackupError extends Error {
    public readonly reason: OpenClawConfigurationBackupErrorReason;

    public constructor(reason: OpenClawConfigurationBackupErrorReason) {
        super("OpenClaw configuration export failed");
        this.name = "OpenClawConfigurationBackupError";
        this.reason = reason;
    }
}

export interface OpenClawConfigurationBackupActor {
    readonly authenticatorId: string;
    readonly id: string;
}

export interface OpenClawConfigurationBackupMetadata {
    readonly fileName: typeof openClawConfigurationBackupFileName;
    readonly mimeType: typeof openClawConfigurationBackupMimeType;
    readonly sizeBytes: number;
}

export interface OpenClawConfigurationBackupContent extends OpenClawConfigurationBackupMetadata {
    /** Exclusive consumed ticket buffer; the consumer must erase it on every settlement path. */
    readonly bytes: Uint8Array;
}

/** Secret-bearing descriptor source. The caller owns and must erase each returned exact copy. */
export interface OpenClawConfigurationBackupSource {
    readonly read: (signal?: AbortSignal) => Promise<Uint8Array>;
}

/** Process-local, actor/session-bound one-shot ticket lifecycle. */
export interface OpenClawConfigurationBackupTicketStore {
    /** Transfers exclusive ownership of the stored copy to the caller for prompt erasure. */
    readonly consume: (
        actor: OpenClawConfigurationBackupActor,
        ticketId: string
    ) => OpenClawConfigurationBackupContent;
    readonly dispose: () => void;
    readonly inspect: (
        actor: OpenClawConfigurationBackupActor,
        ticketId: string
    ) => OpenClawConfigurationBackupMetadata;
    /** Copies bytes synchronously; input ownership and erasure remain with the caller. */
    readonly issue: (
        actor: OpenClawConfigurationBackupActor,
        bytes: Uint8Array
    ) => CreateOpenClawConfigurationBackupResult;
}
