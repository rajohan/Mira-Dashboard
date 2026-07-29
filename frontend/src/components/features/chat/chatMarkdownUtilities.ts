import JSON5 from "json5";
import { isValidElement, type ReactNode } from "react";

const JSON_LANGUAGES = new Set(["json", "json5", "jsonc"]);

function isReactNodeArray(value: ReactNode): value is ReactNode[] {
    return Array.isArray(value);
}

/**
 * Flattens the textual content of nested React children.
 * @returns Children to text result.
 */
export function childrenToText(children: ReactNode): string {
    const childStack: ReactNode[] = [children];
    let text = "";

    while (childStack.length > 0) {
        const child = childStack.shift();

        if (typeof child === "string" || typeof child === "number") {
            text += String(child);
            continue;
        }

        if (isReactNodeArray(child)) {
            childStack.unshift(...child);
            continue;
        }

        if (isValidElement<{ children?: ReactNode }>(child)) {
            childStack.unshift(child.props.children);
        }
    }

    return text;
}

/**
 * Returns the normalized language name represented by a Markdown class.
 * @param className Class name value.
 * @returns the normalized language name represented by a Markdown class.
 */
export function codeLanguageFromClassName(className?: string): string {
    const language = className?.match(/language-(\S+)/)?.[1]?.toLowerCase();
    return language || "text";
}

/**
 * Normalizes common syntax-highlighter aliases.
 * @param language Language value.
 * @returns Normalized common syntax-highlighter aliases.
 */
export function normalizeSyntaxLanguage(language: string): string {
    const aliases: Record<string, string> = {
        fish: "bash",
        js: "javascript",
        json5: "json",
        jsonc: "json",
        jsx: "javascript",
        py: "python",
        rs: "rust",
        sh: "bash",
        ts: "typescript",
        tsx: "typescript",
        yml: "yaml",
        zsh: "bash",
    };

    return aliases[language] || language;
}

/**
 * Returns whether source text resembles a JSON object or array.
 * @param code Status or verification code.
 * @returns Whether source text resembles a JSON object or array.
 */
export function isJsonLike(code: string): boolean {
    const trimmed = code.trim();
    return (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
}

/**
 * Parses JSON5 source into the object shape required by the JSON viewer.
 * @param code Status or verification code.
 * @returns Parsed JSON5 source into the object shape required by the JSON viewer.
 */
export function parseJsonBlock(code: string): object | undefined {
    try {
        const parsed: unknown = JSON5.parse(code);
        return parsed !== null && typeof parsed === "object" ? parsed : { value: parsed };
    } catch {
        return undefined;
    }
}

/**
 * Returns the code and language represented by a Markdown pre child.
 * @returns the code and language represented by a Markdown pre child.
 */
export function getPreCodeBlock(
    children: ReactNode
): undefined | { code: string; language: string } {
    const child = isReactNodeArray(children) ? children[0] : children;
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        return undefined;
    }
    return {
        code: childrenToText(child.props.children).replace(/\n$/, ""),
        language: codeLanguageFromClassName(child.props.className),
    };
}

export { JSON_LANGUAGES };
