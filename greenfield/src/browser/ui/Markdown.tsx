import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/classNames.ts";

interface MarkdownProps extends Omit<ComponentProps<typeof ReactMarkdown>, "children"> {
    readonly className?: string;
    readonly source: string;
}

/**
 * Renders Markdown without enabling raw HTML. Resource-bearing elements remain
 * caller-controlled through ReactMarkdown component overrides.
 * @returns Sanitizer-independent Markdown presentation using safe React nodes.
 */
export function Markdown({ className, source, ...properties }: MarkdownProps) {
    return (
        <div
            className={cn(
                "prose prose-invert prose-sm prose-a:text-accent-300 prose-code:text-primary-100 prose-pre:bg-primary-950 max-w-none wrap-break-word",
                className
            )}
        >
            <ReactMarkdown {...properties} remarkPlugins={[remarkGfm]}>
                {source}
            </ReactMarkdown>
        </div>
    );
}
