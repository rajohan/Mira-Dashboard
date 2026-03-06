import ReactJsonView from "@microlink/react-json-view";
import JSON5 from "json5";

export function JsonPreview({ content }: { content: string }) {
    return (
        <div className="overflow-auto p-4">
            <ReactJsonView
                src={(() => {
                    try {
                        return JSON5.parse(content);
                    } catch {
                        try {
                            return JSON.parse(content);
                        } catch {
                            return {
                                error: "Failed to parse JSON",
                                raw: content,
                            };
                        }
                    }
                })()}
                theme="monokai"
                collapsed={false}
                enableClipboard={false}
                displayDataTypes={false}
                displayObjectSize={false}
                indentWidth={4}
                style={{
                    fontSize: "13px",
                    backgroundColor: "transparent",
                }}
            />
        </div>
    );
}
