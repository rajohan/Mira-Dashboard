import ReactJsonView from "@microlink/react-json-view";
import JSON5 from "json5";

import { CopyButton } from "../../../ui/CopyButton";

/**
 * Parses editable JSON5 into the object shape required by the tree viewer.
 * @param content - JSON5 source from the file editor.
 * @returns Parsed containers directly and scalar roots under a `value` property.
 */
function jsonPreviewSource(content: string): object {
    try {
        const parsed: unknown = JSON5.parse(content);
        return parsed !== null && typeof parsed === "object" ? parsed : { value: parsed };
    } catch {
        return {
            error: "Failed to parse JSON",
            raw: content,
        };
    }
}

/**
 * Renders the JSON preview UI.
 * @returns Rendered the JSON preview UI.
 */
export function JsonPreview({
    content,
    scrollOwner = "self",
}: {
    content: string;
    scrollOwner?: "parent" | "self";
}) {
    const ownsScroll = scrollOwner === "self";
    return (
        <div className={ownsScroll ? "flex h-full min-w-0 flex-col" : "min-w-0"}>
            <div className="flex shrink-0 justify-end border-b border-primary-700 px-2 py-1">
                <CopyButton content={content} label="Copy JSON" />
            </div>
            <div
                className={`min-w-0 p-3 sm:p-4 ${ownsScroll ? "min-h-0 flex-1 overflow-auto" : ""}`}
            >
                <ReactJsonView
                    src={jsonPreviewSource(content)}
                    theme="monokai"
                    collapsed={false}
                    enableClipboard={false}
                    displayDataTypes={false}
                    displayObjectSize={false}
                    indentWidth={4}
                    style={{
                        fontSize: "12px",
                        backgroundColor: "transparent",
                    }}
                />
            </div>
        </div>
    );
}
