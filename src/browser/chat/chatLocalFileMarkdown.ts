import { chatLocalFileReference } from "./chatMarkdownPolicy.ts";

type MarkdownNode = {
    children?: readonly MarkdownNode[];
    type: string;
    url?: string;
    value?: string;
};
type LinkNode = MarkdownNode & { type: "link"; url: string };
type TextNode = MarkdownNode & { type: "text"; value: string };

const localReferenceCandidatePattern = /\/(?:home|opt|srv|var\/lib)\/[^\s<>"'`]+/gu;
const trailingPunctuationPattern = /[),.;!?]+$/u;

function linkNode(value: string, children: readonly MarkdownNode[]): LinkNode {
    return { children: [...children], type: "link", url: value };
}

function transformText(node: TextNode): readonly MarkdownNode[] | undefined {
    const output: MarkdownNode[] = [];
    let offset = 0;
    for (const match of node.value.matchAll(localReferenceCandidatePattern)) {
        const start = match.index;
        const candidate = match[0];
        const punctuation = candidate.match(trailingPunctuationPattern)?.[0] ?? "";
        const value = candidate.slice(0, candidate.length - punctuation.length);
        if (chatLocalFileReference(value) === undefined) continue;
        if (start > offset) {
            output.push({ type: "text", value: node.value.slice(offset, start) });
        }
        output.push(linkNode(value, [{ type: "text", value }]));
        if (punctuation !== "") output.push({ type: "text", value: punctuation });
        offset = start + candidate.length;
    }
    if (output.length === 0) return undefined;
    if (offset < node.value.length) {
        output.push({ type: "text", value: node.value.slice(offset) });
    }
    return output;
}

function walk(node: MarkdownNode): void {
    if (node.children === undefined || node.type === "link") return;
    const children = [...node.children];
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        if (child.type === "text" && typeof child.value === "string") {
            const replacement = transformText(child as TextNode);
            if (replacement !== undefined) {
                children.splice(index, 1, ...(replacement as MarkdownNode[]));
                index += replacement.length - 1;
                continue;
            }
        } else if (
            child.type === "inlineCode" &&
            typeof child.value === "string" &&
            chatLocalFileReference(child.value) !== undefined
        ) {
            children.splice(index, 1, linkNode(child.value, [child]));
            continue;
        }
        walk(child);
    }
    (node as unknown as { children: MarkdownNode[] }).children = children;
}

/** @returns A remark transformer that linkifies reviewed-root candidates only. */
export function remarkChatLocalFileReferences() {
    return (tree: MarkdownNode): void => walk(tree);
}
