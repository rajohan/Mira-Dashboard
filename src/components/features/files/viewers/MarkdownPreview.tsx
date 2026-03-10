import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({ content }: { content: string }) {
    return (
        <div className="h-full overflow-y-auto">
            <div className="prose prose-invert max-w-none p-6 prose-headings:mb-4 prose-headings:mt-6 prose-p:my-4 prose-blockquote:my-4 prose-pre:my-4 prose-ol:my-4 prose-ul:my-4 prose-li:my-1 prose-table:my-4 prose-hr:my-6">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
}
