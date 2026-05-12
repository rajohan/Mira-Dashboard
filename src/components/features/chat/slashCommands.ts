import type { ChatModelOption } from "./chatUtils";

export interface SlashCommandDefinition {
    name: string;
    aliases?: string[];
    description: string;
    args?: string;
    choices?: string[];
}

export interface SlashCommandSuggestion {
    value: string;
    title: string;
    description: string;
}

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
export const MODE_CHOICES = ["status", "on", "off"];
export const VERBOSE_CHOICES = ["off", "on", "full"];
export const REASONING_CHOICES = ["off", "on", "stream"];
export const ELEVATED_CHOICES = ["off", "on", "ask", "full"];
export const USAGE_CHOICES = ["off", "tokens", "on", "full"];

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
    { name: "/clear", description: "Clear only the local chat view" },
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
        args: "[sandbox|gateway|node] [deny|allowlist|full] [off|on-miss|always]",
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
        name: "/tts",
        description: "Control text-to-speech",
        args: "[on|off|status|provider|limit|summary|audio|help]",
    },
];

export function slashCommandCanonicalName(rawCommand: string): string {
    const command = rawCommand.toLowerCase();
    return (
        SLASH_COMMANDS.find((definition) => definition.aliases?.includes(command))
            ?.name || command
    );
}

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
