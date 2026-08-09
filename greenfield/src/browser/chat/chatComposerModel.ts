export interface ChatSlashSuggestion {
    readonly description: string;
    readonly replacement: string;
    readonly title: string;
}

/**
 * Builds bounded context-aware slash choices for the composer combobox.
 * @param draft Current composer text.
 * @param modelOptions Allowed model identifiers.
 * @param thinkingOptions Allowed thinking levels.
 * @returns Matching bounded slash-command choices.
 */
export function chatSlashSuggestions(
    draft: string,
    modelOptions: readonly string[],
    thinkingOptions: readonly string[]
): readonly ChatSlashSuggestion[] {
    if (!draft.startsWith("/") || draft.includes("\n")) return [];
    const definitions: ChatSlashSuggestion[] = [
        {
            description: "Show the available chat controls",
            replacement: "/help",
            title: "/help",
        },
        {
            description: "Compact the selected session context",
            replacement: "/compact",
            title: "/compact",
        },
        {
            description: "Reset the selected provider transcript",
            replacement: "/reset",
            title: "/reset",
        },
        ...modelOptions.map((model) => ({
            description: `Use ${model} for subsequent sends`,
            replacement: `/model ${model}`,
            title: `/model ${model}`,
        })),
        ...thinkingOptions.map((thinking) => ({
            description: `Use ${thinking} thinking for subsequent sends`,
            replacement: `/thinking ${thinking}`,
            title: `/thinking ${thinking}`,
        })),
    ];
    const query = draft.toLocaleLowerCase("en-US");
    return definitions.filter((definition) =>
        definition.title.toLocaleLowerCase("en-US").startsWith(query)
    );
}

/**
 * Determines whether one composer key event submits.
 * @param event Minimal keyboard/IME state.
 * @param coarsePointer Whether the current pointer is touch-like.
 * @returns True only for desktop, unmodified, non-IME Enter.
 */
export function shouldSubmitChatComposer(
    event: Readonly<{ isComposing: boolean; key: string; shiftKey: boolean }>,
    coarsePointer: boolean
): boolean {
    return (
        event.key === "Enter" && !event.shiftKey && !event.isComposing && !coarsePointer
    );
}
