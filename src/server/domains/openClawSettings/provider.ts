import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationSnapshot,
    SetOpenClawSkillEnabledInput,
    SetOpenClawSkillEnabledResult,
    UpdateOpenClawConfigurationInput,
    UpdateOpenClawConfigurationResult,
} from "../../../contracts/openClawSettings.ts";

export interface OpenClawSettingsProviderRequest {
    readonly signal?: AbortSignal;
}

export interface OpenClawSettingsProviderMutationRequest extends OpenClawSettingsProviderRequest {
    /** Re-checks current-session and recent-MFA authority at mutation dispatch. */
    readonly authorizeDispatch: () => Promise<void>;
}

export type OpenClawSettingsProviderUpdateConfigurationRequest = Readonly<
    UpdateOpenClawConfigurationInput & OpenClawSettingsProviderMutationRequest
>;

export type OpenClawSettingsProviderSetSkillEnabledRequest = Readonly<
    SetOpenClawSkillEnabledInput & OpenClawSettingsProviderMutationRequest
>;

export type OpenClawSettingsProviderSetSkillEnabledResult = SetOpenClawSkillEnabledResult;

/** Narrow settings authority; arbitrary Gateway methods and raw config are impossible. */
export interface OpenClawSettingsProvider {
    readonly getConfiguration: (
        request: OpenClawSettingsProviderRequest
    ) => Promise<OpenClawConfigurationSnapshot>;
    readonly listSkills: (
        request: OpenClawSettingsProviderRequest
    ) => Promise<ListOpenClawSkillsResult>;
    readonly setSkillEnabled: (
        request: OpenClawSettingsProviderSetSkillEnabledRequest
    ) => Promise<OpenClawSettingsProviderSetSkillEnabledResult>;
    readonly updateConfiguration: (
        request: OpenClawSettingsProviderUpdateConfigurationRequest
    ) => Promise<UpdateOpenClawConfigurationResult>;
}

export type OpenClawSettingsProviderErrorReason =
    | "conflict"
    | "not-found"
    | "data-invalid"
    | "unavailable"
    | "unknown-outcome";

/** Safe provider failure that never includes upstream payloads, paths, or messages. */
export class OpenClawSettingsProviderError extends Error {
    public readonly reason: OpenClawSettingsProviderErrorReason;

    public constructor(reason: OpenClawSettingsProviderErrorReason) {
        super(`OpenClaw settings provider failed: ${reason}`);
        this.name = "OpenClawSettingsProviderError";
        this.reason = reason;
    }
}
