import ReactJsonView from "@microlink/react-json-view";
import JSON5 from "json5";

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
    return (
        <div
            className={`min-w-0 p-3 sm:p-4 ${scrollOwner === "self" ? "overflow-auto" : ""}`}
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
    );
}
