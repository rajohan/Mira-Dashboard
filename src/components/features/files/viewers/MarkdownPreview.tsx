import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProperties {
    content: string;
    renderImages?: boolean;
}

/** Renders the markdown preview UI. */
export function MarkdownPreview({
    content,
    renderImages = true,
}: MarkdownPreviewProperties) {
    return (
        <div className="h-full min-w-0 overflow-y-auto">
            <div className="prose max-w-none p-3 wrap-break-word prose-invert sm:p-6 prose-headings:mt-5 prose-headings:mb-3 sm:prose-headings:mt-6 sm:prose-headings:mb-4 prose-p:my-3 sm:prose-p:my-4 prose-blockquote:my-3 sm:prose-blockquote:my-4 prose-pre:my-3 sm:prose-pre:my-4 prose-ol:my-3 sm:prose-ol:my-4 prose-ul:my-3 sm:prose-ul:my-4 prose-li:my-1 prose-table:my-3 sm:prose-table:my-4 prose-hr:my-5 sm:prose-hr:my-6">
                <ReactMarkdown
                    components={
                        renderImages
                            ? undefined
                            : {
                                  img: ({ alt }) => (
                                      <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>
                                  ),
                              }
                    }
                    remarkPlugins={[remarkGfm, remarkFrontmatter]}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
}
