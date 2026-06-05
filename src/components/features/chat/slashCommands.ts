import type { ChatModelOption } from "./chatUtils";

/** Represents slash command definition. */
export interface SlashCommandDefinition {
    name: string;
    aliases?: string[];
    description: string;
    args?: string;
    choices?: string[];
}

/** Represents slash command suggestion. */
export interface SlashCommandSuggestion {
    value: string;
    title: string;
    description: string;
}

/** Defines thinking choices. */
export const THINKING_CHOICES = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "adaptive",
];
/** Defines mode choices. */
export const MODE_CHOICES = ["status", "on", "off"];
/** Defines verbose choices. */
export const VERBOSE_CHOICES = ["off", "on", "full"];
/** Defines trace choices. */
export const TRACE_CHOICES = ["off", "on", "raw"];
/** Defines reasoning choices. */
export const REASONING_CHOICES = ["off", "on", "stream"];
/** Defines elevated choices. */
export const ELEVATED_CHOICES = ["off", "on", "ask", "full"];
/** Defines usage choices. */
export const USAGE_CHOICES = ["off", "tokens", "full", "cost"];
/** Defines activation choices. */
export const ACTIVATION_CHOICES = ["mention", "always"];
/** Defines send choices. */
export const SEND_CHOICES = ["on", "off", "inherit"];
/** Defines queue mode choices. */
export const QUEUE_MODE_CHOICES = ["steer", "followup", "collect", "interrupt"];

/** Defines slash commands. */
export const SLASH_COMMANDS: SlashCommandDefinition[] = [
    { name: "/help", description: "Show available commands" },
    { name: "/commands", description: "List available slash commands" },
    { name: "/status", description: "Show selected session status" },
    {
        name: "/usage",
        description: "Show or set usage display",
        args: "[off|tokens|full|cost]",
        choices: USAGE_CHOICES,
    },
    { name: "/reset", description: "Reset the selected session" },
    { name: "/new", description: "Start a fresh selected session" },
    { name: "/compact", description: "Compact the selected session context" },
    { name: "/stop", aliases: ["/abort"], description: "Stop the current run" },
    {
        name: "/session",
        description: "Manage thread-binding session expiry",
        args: "[idle|max-age] [duration|off]",
    },
    {
        name: "/export-session",
        aliases: ["/export"],
        description: "Export the current session to HTML",
        args: "[path]",
    },
    {
        name: "/export-trajectory",
        aliases: ["/trajectory"],
        description: "Export the current trajectory bundle",
        args: "[path]",
    },
    { name: "/model", description: "Show or set the model", args: "[model]" },
    { name: "/models", description: "List configured models" },
    {
        name: "/think",
        aliases: ["/thinking", "/t"],
        description: "Show or set thinking level",
        args: "[level]",
        choices: THINKING_CHOICES,
    },
    {
        name: "/verbose",
        aliases: ["/v"],
        description: "Show or set verbose mode",
        args: "[off|on|full]",
        choices: VERBOSE_CHOICES,
    },
    {
        name: "/trace",
        description: "Show or set plugin trace output",
        args: "[off|on|raw]",
        choices: TRACE_CHOICES,
    },
    {
        name: "/fast",
        description: "Show or set fast mode",
        args: "[status|on|off]",
        choices: MODE_CHOICES,
    },
    {
        name: "/reasoning",
        aliases: ["/reason"],
        description: "Show or set reasoning visibility",
        args: "[off|on|stream]",
        choices: REASONING_CHOICES,
    },
    {
        name: "/elevated",
        aliases: ["/elev"],
        description: "Show or set elevated mode",
        args: "[off|on|ask|full]",
        choices: ELEVATED_CHOICES,
    },
    {
        name: "/exec",
        description: "Set exec defaults",
        args: "[auto|sandbox|gateway|node] [deny|allowlist|full] [off|on-miss|always] [nodeId]",
    },
    {
        name: "/queue",
        description: "Manage active-run queue behavior",
        args: "[steer|followup|collect|interrupt]",
        choices: QUEUE_MODE_CHOICES,
    },
    {
        name: "/steer",
        aliases: ["/tell"],
        description: "Send guidance to the active run",
        args: "<message>",
    },
    { name: "/kill", description: "Kill a running subagent", args: "[target|all]" },
    { name: "/agents", description: "List thread-bound agents" },
    {
        name: "/subagents",
        description: "Manage subagent runs",
        args: "[list|kill|log|info|send|steer|spawn]",
    },
    { name: "/tools", description: "List runtime tools", args: "[compact|verbose]" },
    {
        name: "/goal",
        description: "Manage the current session goal",
        args: "[status|start|pause|resume|complete|block|clear]",
    },
    {
        name: "/diagnostics",
        description: "Create an owner support diagnostic report",
        args: "[note]",
    },
    {
        name: "/crestodian",
        description: "Run the Crestodian setup and repair helper",
        args: "<request>",
    },
    { name: "/tasks", description: "List active and recent background tasks" },
    {
        name: "/context",
        description: "Explain current context assembly",
        args: "[list|detail|map|json]",
    },
    {
        name: "/whoami",
        aliases: ["/id"],
        description: "Show the sender id for this surface",
    },
    { name: "/skill", description: "Run a user-invocable skill", args: "<name> [input]" },
    {
        name: "/allowlist",
        description: "Manage command allowlist entries",
        args: "[list|add|remove]",
    },
    {
        name: "/approve",
        description: "Resolve exec or plugin approval prompts",
        args: "<id> <decision>",
    },
    {
        name: "/btw",
        aliases: ["/side"],
        description: "Ask a side question without changing session context",
        args: "<question>",
    },
    {
        name: "/acp",
        description: "Manage ACP sessions and runtime options",
        args: "[spawn|cancel|steer|close|sessions|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|help]",
    },
    {
        name: "/focus",
        description: "Bind the current thread to a session target",
        args: "<target>",
    },
    { name: "/unfocus", description: "Remove the current thread binding" },
    {
        name: "/config",
        description: "Read or write OpenClaw config",
        args: "[show|get|set|unset]",
    },
    {
        name: "/mcp",
        description: "Read or write OpenClaw-managed MCP config",
        args: "[show|get|set|unset]",
    },
    {
        name: "/plugins",
        aliases: ["/plugin"],
        description: "Inspect or manage plugins",
        args: "[list|inspect|show|get|install|enable|disable]",
    },
    {
        name: "/debug",
        description: "Manage runtime-only config overrides",
        args: "[show|set|unset|reset]",
    },
    { name: "/restart", description: "Restart OpenClaw" },
    {
        name: "/send",
        description: "Set send policy",
        args: "[on|off|inherit]",
        choices: SEND_CHOICES,
    },
    {
        name: "/tts",
        description: "Control text-to-speech",
        args: "[on|off|status|chat|latest|provider|limit|summary|audio|help]",
    },
    {
        name: "/activation",
        description: "Set group activation mode",
        args: "[mention|always]",
        choices: ACTIVATION_CHOICES,
    },
    { name: "/bash", description: "Run a host shell command", args: "<command>" },
    {
        name: "/dock-discord",
        aliases: ["/dock_discord"],
        description: "Dock replies to Discord",
    },
    {
        name: "/dock-mattermost",
        aliases: ["/dock_mattermost"],
        description: "Dock replies to Mattermost",
    },
    {
        name: "/dock-slack",
        aliases: ["/dock_slack"],
        description: "Dock replies to Slack",
    },
    {
        name: "/dock-telegram",
        aliases: ["/dock_telegram"],
        description: "Dock replies to Telegram",
    },
    {
        name: "/dreaming",
        description: "Toggle or inspect memory dreaming",
        args: "[on|off|status|help]",
    },
    {
        name: "/pair",
        description: "Manage device pairing",
        args: "[qr|status|pending|approve|cleanup|notify]",
    },
    {
        name: "/phone",
        description: "Temporarily arm high-risk phone node commands",
        args: "[status|arm|disarm]",
    },
    {
        name: "/voice",
        description: "Manage Talk voice config",
        args: "[status|list|set]",
    },
    { name: "/card", description: "Send LINE rich card presets", args: "[preset]" },
    {
        name: "/codex",
        description: "Control the Codex app-server harness",
        args: "[status|models|threads|resume|compact|review|diagnostics|account|mcp|skills]",
    },
];

/** Performs slash command canonical name. */
export function slashCommandCanonicalName(rawCommand: string): string {
    const command = rawCommand.toLowerCase();
    return (
        SLASH_COMMANDS.find((definition) => definition.aliases?.includes(command))
            ?.name || command
    );
}

/** Returns whether a draft can be sent while a run is already active. */
export function isActiveRunSlashCommand(draft: string): boolean {
    const [rawCommand = ""] = draft.trim().split(/\s+/);
    return slashCommandCanonicalName(rawCommand) === "/steer";
}

/** Builds slash command suggestions. */
export function buildSlashCommandSuggestions(
    draft: string,
    chatModelOptions: ChatModelOption[]
): SlashCommandSuggestion[] {
    const input = draft.trimStart();
    if (!input.startsWith("/")) {
        return [];
    }

    const [commandPart = "", ...argumentParts] = input.split(/\s+/);
    const argumentPart = argumentParts.join(" ").trim().toLowerCase();
    const matchedCommand = SLASH_COMMANDS.find(
        (command) =>
            command.name === commandPart.toLowerCase() ||
            command.aliases?.includes(commandPart.toLowerCase())
    );

    if (matchedCommand && input.includes(" ")) {
        const commandChoices =
            matchedCommand.name === "/model"
                ? chatModelOptions
                      .map((model) => model.id || model.label || model.name || "")
                      .filter(Boolean)
                : matchedCommand.choices || [];

        return commandChoices
            .filter((choice) => choice.toLowerCase().includes(argumentPart))
            .slice(0, 8)
            .map((choice) => ({
                value: `${commandPart} ${choice}`,
                title: choice,
                description: matchedCommand.description,
            }));
    }

    const needle = commandPart.toLowerCase();
    return SLASH_COMMANDS.flatMap((command) =>
        [command.name, ...(command.aliases || [])]
            .filter((name) => name.startsWith(needle))
            .map((name) => ({
                value: `${name}${command.args ? " " : ""}`,
                title: `${name}${command.args ? ` ${command.args}` : ""}`,
                description: command.description,
            }))
    ).slice(0, 10);
}
