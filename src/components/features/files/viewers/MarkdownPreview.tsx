import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({ content }: { content: string }) {
    return (
        <div className="h-full min-w-0 overflow-y-auto">
            <div className="prose prose-invert max-w-none break-words p-3 prose-headings:mb-3 prose-headings:mt-5 prose-p:my-3 prose-blockquote:my-3 prose-pre:my-3 prose-ol:my-3 prose-ul:my-3 prose-li:my-1 prose-table:my-3 prose-hr:my-5 sm:p-6 sm:prose-headings:mb-4 sm:prose-headings:mt-6 sm:prose-p:my-4 sm:prose-blockquote:my-4 sm:prose-pre:my-4 sm:prose-ol:my-4 sm:prose-ul:my-4 sm:prose-table:my-4 sm:prose-hr:my-6">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
}
