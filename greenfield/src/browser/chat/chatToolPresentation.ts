import type { ChatToolPart } from "./chatTypes.ts";

const toolSummaryMaximumCodePoints = 120;

function boundedToolSummaryText(value: string): string | undefined {
    const normalized = value
        .replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim();
    if (normalized === "") return undefined;
    // oxlint-disable-next-line unicorn/prefer-spread -- The 120-unit contract counts Unicode code points, not UTF-16 units or grapheme clusters.
    const codePoints = Array.from(normalized);
    if (codePoints.length <= toolSummaryMaximumCodePoints) return normalized;
    return `${codePoints.slice(0, toolSummaryMaximumCodePoints - 1).join("")}…`;
}

/**
 * Returns a provider-neutral display name for one tool.
 * @param name Provider tool name.
 * @returns Human-readable bounded label.
 */
export function toolDisplayName(name: string): string {
    const unqualified = name.startsWith("functions.")
        ? name.slice("functions.".length)
        : name;
    const normalized = ["bash", "exec", "exec_command"].includes(unqualified)
        ? "bash"
        : unqualified;
    const words = normalized.replaceAll(/[_-]/gu, " ").replaceAll(/\s+/gu, " ").trim();
    return words === "" ? "Tool" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * Returns a bounded summary from only allowlisted provider-visible input fields.
 * @param part Tool lifecycle part.
 * @returns Command/path summary, or undefined when no trusted summary exists.
 */
export function toolDescription(part: ChatToolPart): string | undefined {
    let candidate = part.input;
    if (typeof candidate === "string") {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return undefined;
        }
    }
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return undefined;
    }
    const input = candidate as Readonly<Record<string, unknown>>;
    let command: string | undefined;
    if (typeof input.command === "string") command = input.command;
    else if (typeof input.cmd === "string") command = input.cmd;
    if (command !== undefined) {
        let workingDirectory: string | undefined;
        if (typeof input.workdir === "string") workingDirectory = input.workdir;
        else if (typeof input.cwd === "string") workingDirectory = input.cwd;
        const directoryName = workingDirectory?.split(/[\\/]/u).findLast(Boolean);
        return boundedToolSummaryText(
            directoryName === undefined ? command : `${command} (${directoryName})`
        );
    }
    return typeof input.path === "string"
        ? boundedToolSummaryText(input.path)
        : undefined;
}

/**
 * Returns a bounded provider-visible activity label without inspecting output or errors.
 * @param part Tool lifecycle part.
 * @returns Safe tool activity text.
 */
export function chatToolActivityText(part: ChatToolPart): string {
    const label = toolDisplayName(part.name);
    const description = toolDescription(part);
    return (
        boundedToolSummaryText(
            description === undefined ? label : `${label}: ${description}`
        ) ?? label
    );
}
