/**
 * Parses one provider-authored Markdown link under the chat privacy policy.
 * @param href Untrusted Markdown link target.
 * @returns A safe normalized target and externality flag, or undefined when blocked.
 */
export type SafeChatMarkdownLink =
    | Readonly<{ external: boolean; href: string; kind: "url" }>
    | Readonly<{ kind: "workspace-file"; reference: string }>;

const absoluteLocalFileReferencePattern = /^\/(?:home|opt|srv|var\/lib)\/(?:[^/\0\p{Cc}\p{Cf}]+\/)*[^/\0\p{Cc}\p{Cf}]+(?::\d+(?::\d+)?)?$/u;

/** @returns A normalized absolute local file reference without line/column suffixes. */
export function chatLocalFileReference(value: string): string | undefined {
    const decoded = value.startsWith("file://")
        ? (() => {
              try {
                  return decodeURIComponent(new URL(value).pathname);
              } catch {
                  return undefined;
              }
          })()
        : value;
    if (decoded === undefined || !absoluteLocalFileReferencePattern.test(decoded)) {
        return undefined;
    }
    return decoded.replace(/:\d+(?::\d+)?$/u, "");
}

export function safeChatMarkdownLink(
    href: string | undefined
): SafeChatMarkdownLink | undefined {
    if (href === undefined || href === "") return undefined;
    const localReference = chatLocalFileReference(href);
    if (localReference !== undefined) {
        return { kind: "workspace-file", reference: localReference };
    }
    if (href.startsWith("#")) return { external: false, href, kind: "url" };
    try {
        const base = globalThis.location?.origin ?? "https://dashboard.invalid";
        const url = new URL(href, base);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
        return {
            external:
                (url.protocol === "http:" || url.protocol === "https:") &&
                url.origin !== new URL(base).origin,
            href: url.href,
            kind: "url",
        };
    } catch {
        return undefined;
    }
}
