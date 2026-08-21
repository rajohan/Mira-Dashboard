export const syntaxHighlightedSourceLanguageIds = Object.freeze([
    "css",
    "dockerfile",
    "html",
    "javascript",
    "json",
    "markdown",
    "python",
    "shell",
    "sql",
    "typescript",
    "xml",
    "yaml",
] as const);

export type SyntaxHighlightedSourceLanguage =
    (typeof syntaxHighlightedSourceLanguageIds)[number];

const syntaxHighlightedSourceLanguages = new Set<string>(
    syntaxHighlightedSourceLanguageIds
);

/**
 * @param language Stable source-viewer language identifier.
 * @returns Whether the bounded source highlighter owns this exact grammar.
 */
export function supportsSyntaxHighlightedSourceLanguage(
    language: string
): language is SyntaxHighlightedSourceLanguage {
    return syntaxHighlightedSourceLanguages.has(language);
}
