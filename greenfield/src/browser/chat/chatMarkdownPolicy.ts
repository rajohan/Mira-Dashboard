/**
 * Parses one provider-authored Markdown link under the chat privacy policy.
 * @param href Untrusted Markdown link target.
 * @returns A safe normalized target and externality flag, or undefined when blocked.
 */
export function safeChatMarkdownLink(
    href: string | undefined
): Readonly<{ external: boolean; href: string }> | undefined {
    if (href === undefined || href === "") return undefined;
    if (href.startsWith("#")) return { external: false, href };
    try {
        const base = globalThis.location?.origin ?? "https://dashboard.invalid";
        const url = new URL(href, base);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
        return {
            external:
                (url.protocol === "http:" || url.protocol === "https:") &&
                url.origin !== new URL(base).origin,
            href: url.href,
        };
    } catch {
        return undefined;
    }
}
