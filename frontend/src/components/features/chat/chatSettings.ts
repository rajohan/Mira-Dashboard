import type { Session } from "../../../../../contracts/sessions";

/** Represents chat model option. */
export interface ChatModelOption {
    id?: string;
    label?: string;
    name?: string;
}

interface ChatSettingOption {
    value: string;
    label: string;
}

/**
 * Normalizes Gateway thinking labels to OpenClaw's canonical level ids.
 * @param level Level value.
 * @returns Normalized Gateway thinking labels to OpenClaw's canonical level ids.
 */
function normalizeThinkingLevel(level: string): string | undefined {
    const collapsed = level
        .trim()
        .toLowerCase()
        .replaceAll(/[\s_-]+/g, "");
    if (["adaptive", "auto"].includes(collapsed)) return "adaptive";
    if (["xhigh", "extrahigh"].includes(collapsed)) return "xhigh";
    if (["max", "off"].includes(collapsed)) return collapsed;
    if (["on", "enable", "enabled"].includes(collapsed)) return "low";
    if (["min", "minimal", "think"].includes(collapsed)) return "minimal";
    if (["low", "thinkhard"].includes(collapsed)) return "low";
    if (["mid", "med", "medium", "thinkharder", "harder"].includes(collapsed)) {
        return "medium";
    }
    if (["high", "ultra", "ultrathink", "thinkhardest", "highest"].includes(collapsed)) {
        return "high";
    }
    return undefined;
}

/**
 * Returns the model-supported thinking options exposed by OpenClaw.
 * @param session Session to process.
 * @returns the model-supported thinking options exposed by OpenClaw.
 */
export function chatThinkingOptions(session: Session | undefined): ChatSettingOption[] {
    const seenIds = new Set<string>();
    const levels = session?.thinkingLevels?.length
        ? session.thinkingLevels
        : (session?.thinkingOptions || []).flatMap((label) => {
              const id = normalizeThinkingLevel(label);
              if (!id || seenIds.has(id)) return [];
              seenIds.add(id);
              return [{ id, label }];
          });
    const options = levels.map((level) => ({
        label: level.label || level.id,
        value: level.id,
    }));
    const currentLevel = session?.thinkingLevel;
    if (currentLevel && options.every((option) => option.value !== currentLevel)) {
        options.push({ label: currentLevel, value: currentLevel });
    }
    const defaultLabel = session?.thinkingDefault
        ? `Default (${session.thinkingDefault})`
        : "Default";
    return [{ label: defaultLabel, value: "" }, ...options];
}

/**
 * Returns the label shown for the selected thinking setting.
 * @param session Session to process.
 * @returns the label shown for the selected thinking setting.
 */
export function selectedChatThinkingLabel(session: Session | undefined): string {
    const selectedValue = session?.thinkingLevel || "";
    return (
        chatThinkingOptions(session).find((option) => option.value === selectedValue)
            ?.label || "Unknown"
    );
}

/**
 * Returns the label for the effective OpenClaw fast-mode value.
 *
 * @param session - Session whose effective mode should be described.
 * @returns Human-readable mode label, or `undefined` when no mode is available.
 */
function effectiveChatSpeedLabel(session?: Session): string | undefined {
    switch (session?.effectiveFastMode) {
        case "auto": {
            return "Auto";
        }
        case true: {
            return "Fast";
        }
        case false: {
            return "Standard";
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Returns the OpenClaw fast-mode choices.
 * @returns the OpenClaw fast-mode choices.
 */
export function chatSpeedOptions(session?: Session): ChatSettingOption[] {
    const effectiveLabel = effectiveChatSpeedLabel(session);
    return [
        { label: effectiveLabel ? `Default (${effectiveLabel})` : "Default", value: "" },
        { label: "Fast", value: "on" },
        { label: "Standard", value: "off" },
        { label: "Auto", value: "auto" },
    ];
}

/**
 * Returns the selected fast-mode override value.
 * @param session Session to process.
 * @returns the selected fast-mode override value.
 */
export function selectedChatSpeed(session: Session | undefined): string {
    if (session?.fastMode === "auto") return "auto";
    if (session?.fastMode === true) return "on";
    if (session?.fastMode === false) return "off";
    return "";
}

/**
 * Returns the label shown for the selected speed setting.
 * @param session Session to process.
 * @returns the label shown for the selected speed setting.
 */
export function selectedChatSpeedLabel(session: Session | undefined): string {
    const selectedValue = selectedChatSpeed(session);
    if (selectedValue === "") {
        return effectiveChatSpeedLabel(session) || "Default";
    }

    return (
        chatSpeedOptions(session).find((option) => option.value === selectedValue)
            ?.label || "Unknown"
    );
}
