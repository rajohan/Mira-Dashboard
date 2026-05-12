/** Defines skill source. */
export type SkillSource = "workspace" | "builtin" | "extra";

/** Represents skill. */
export interface Skill {
    name: string;
    description?: string;
    enabled: boolean;
    location?: string;
    source?: SkillSource;
}

/** Represents config. */
export interface Config {
    gateway?: {
        port?: number;
        mode?: string;
        auth?: {
            type?: string;
            enabled?: boolean;
        };
    };
    agents?: {
        defaultModel?: string;
        fallbacks?: string[];
        contextSettings?: {
            maxTokens?: number;
            temperature?: number;
        };
    };
    channels?: {
        discord?: {
            enabled?: boolean;
            botId?: string;
        };
        [key: string]: unknown;
    };
    session?: {
        reset?: {
            mode?: string;
            idleMinutes?: number;
        };
    };
    tools?: {
        webSearch?: {
            enabled?: boolean;
            provider?: string;
        };
        exec?: {
            enabled?: boolean;
            mode?: string;
        };
    };
    heartbeat?: {
        enabled?: boolean;
        every?: number;
        target?: string;
    };
}

/** Represents settings form. */
export interface SettingsForm {
    idleMinutes: number;
    heartbeatEvery: number;
    heartbeatTarget: string;
}
