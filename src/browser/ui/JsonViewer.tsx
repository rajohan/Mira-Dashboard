import JSON5 from "json5";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { CopyTextButton } from "./CopyTextButton.tsx";
import { Icon } from "./Icon.tsx";
import { SourceSurface, SourceViewer } from "./SourceViewer.tsx";
import { Switch } from "./Switch.tsx";
import { Text } from "./Text.tsx";

const jsonHighlightByteMaximum = 256 * 1024;
const jsonHighlightLineMaximum = 5000;
const jsonTreeDepthMaximum = 32;
const jsonTreeNodeMaximum = 2000;

type JsonFormat = "json" | "json5";
type JsonTreeValueKind = "boolean" | "null" | "number" | "string";
type JsonViewerMode = "source" | "tree";

interface JsonViewerProps {
    readonly ariaLabel: string;
    readonly content: string;
    readonly copyLabel: string;
    readonly format?: JsonFormat;
}

interface JsonTreeContainer {
    readonly children: readonly JsonTreeNode[];
    readonly depth: number;
    readonly kind: "array" | "object";
    readonly label?: string;
    readonly totalChildren: number;
    readonly truncated: boolean;
}

interface JsonTreeValue {
    readonly depth: number;
    readonly kind: "value";
    readonly label?: string;
    readonly value: string;
    readonly valueKind: JsonTreeValueKind;
}

type JsonTreeNode = JsonTreeContainer | JsonTreeValue;

interface JsonTreeBudget {
    remaining: number;
}

const jsonValueClassNames: Readonly<Record<JsonTreeValueKind, string>> = Object.freeze({
    boolean: "text-violet-300",
    null: "text-primary-400 italic",
    number: "text-sky-300",
    string: "text-emerald-300",
});

function parseJsonDocument(content: string, format: JsonFormat): unknown {
    return format === "json5" ? JSON5.parse(content) : JSON.parse(content);
}

function jsonDocumentSummary(value: unknown): string {
    if (Array.isArray(value)) {
        return `${value.length.toLocaleString("en-US")} ${value.length === 1 ? "item" : "items"}`;
    }
    if (value !== null && typeof value === "object") {
        const count = Object.keys(value).length;
        return `${count.toLocaleString("en-US")} ${count === 1 ? "key" : "keys"}`;
    }
    if (value === null) return "Null value";
    switch (typeof value) {
        case "boolean": {
            return "Boolean value";
        }
        case "number": {
            return "Number value";
        }
        case "string": {
            return "String value";
        }
        default: {
            return "JSON value";
        }
    }
}

function jsonTreeValue(
    value: boolean | null | number | string,
    label: string | undefined,
    depth: number
): JsonTreeValue {
    if (value === null) {
        return { depth, kind: "value", label, value: "null", valueKind: "null" };
    }
    if (typeof value === "string") {
        return {
            depth,
            kind: "value",
            label,
            value: JSON.stringify(value),
            valueKind: "string",
        };
    }
    return {
        depth,
        kind: "value",
        label,
        value: String(value),
        valueKind: typeof value === "boolean" ? "boolean" : "number",
    };
}

function jsonTreeNode(
    value: unknown,
    label: string | undefined,
    depth: number,
    budget: JsonTreeBudget
): JsonTreeNode {
    budget.remaining -= 1;
    if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
    ) {
        return jsonTreeValue(value, label, depth);
    }
    const array = Array.isArray(value);
    const objectValue = value as Readonly<Record<string, unknown>>;
    const keys = array ? value.map((_, index) => `${index}`) : Object.keys(objectValue);
    const children: JsonTreeNode[] = [];
    if (depth < jsonTreeDepthMaximum) {
        for (const key of keys) {
            if (budget.remaining <= 0) break;
            children.push(
                jsonTreeNode(
                    array ? value[Number(key)] : objectValue[key],
                    key,
                    depth + 1,
                    budget
                )
            );
        }
    }
    return {
        children,
        depth,
        kind: array ? "array" : "object",
        label,
        totalChildren: keys.length,
        truncated: children.length < keys.length,
    };
}

function JsonTreeLabel({ label }: Readonly<{ label?: string }>) {
    if (label === undefined) return <span className="text-primary-300">Root</span>;
    return <span className="text-accent-300">{JSON.stringify(label)}</span>;
}

function JsonTreeItem({ node }: Readonly<{ node: JsonTreeNode }>) {
    const [expanded, setExpanded] = useState(node.depth < 2);
    if (node.kind === "value") {
        return (
            <li
                aria-level={node.depth + 1}
                className="flex min-h-8 min-w-max items-center gap-2 px-2 font-mono text-sm"
                role="treeitem"
            >
                <span aria-hidden="true" className="inline-block w-5 shrink-0" />
                <JsonTreeLabel label={node.label} />
                {node.label !== undefined && <span className="text-primary-400">:</span>}
                <span className={jsonValueClassNames[node.valueKind]}>{node.value}</span>
            </li>
        );
    }
    const kindLabel = node.kind === "array" ? "Array" : "Object";
    const countLabel = `${node.totalChildren.toLocaleString("en-US")} ${node.totalChildren === 1 ? "value" : "values"}`;
    return (
        <li aria-level={node.depth + 1} role="treeitem">
            <Button
                aria-expanded={expanded}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label ?? "root"} ${kindLabel.toLowerCase()}`}
                className="max-w-full justify-start font-mono"
                onClick={() => setExpanded((current) => !current)}
                size="sm"
                variant="ghost"
            >
                <Icon
                    icon={expanded ? ChevronDown : ChevronRight}
                    size="sm"
                    tone="inherit"
                />
                <JsonTreeLabel label={node.label} />
                {node.label !== undefined && <span className="text-primary-400">:</span>}
                <span className="text-primary-300">{kindLabel}</span>
                <span className="text-primary-400">{countLabel}</span>
            </Button>
            {expanded && (
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Nested WAI-ARIA tree collections require role=group on their list.
                <ul className="border-primary-800 ml-4 border-l pl-2" role="group">
                    {node.children.map((child, index) => (
                        <JsonTreeItem
                            key={`${child.label ?? "root"}:${index}`}
                            node={child}
                        />
                    ))}
                    {node.truncated && (
                        <li
                            className="text-primary-300 px-3 py-2 text-sm"
                            role="treeitem"
                        >
                            More values are not shown.
                        </li>
                    )}
                </ul>
            )}
        </li>
    );
}

function JsonTree({ ariaLabel, value }: Readonly<{ ariaLabel: string; value: unknown }>) {
    const root = jsonTreeNode(value, undefined, 0, {
        remaining: jsonTreeNodeMaximum,
    });
    return (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
            <ul aria-label={ariaLabel} className="min-w-max" role="tree">
                <JsonTreeItem node={root} />
            </ul>
        </div>
    );
}

/**
 * Parses JSON/JSON5 without evaluating code and builds a bounded expandable tree.
 * @returns A reusable tree/source JSON surface with exact-source copying.
 */
export function JsonViewer({
    ariaLabel,
    content,
    copyLabel,
    format = "json",
}: JsonViewerProps) {
    const [mode, setMode] = useState<JsonViewerMode>("tree");
    const [wrapLongLines, setWrapLongLines] = useState(true);
    let parsed: unknown;
    try {
        parsed = parseJsonDocument(content, format);
    } catch {
        return (
            <SourceViewer
                ariaLabel={ariaLabel}
                content={content}
                copyLabel={copyLabel}
                language="json"
                languageLabel={`Invalid ${format.toUpperCase()}`}
            />
        );
    }
    const formatted = JSON.stringify(parsed, undefined, 2);
    const lines = formatted.split("\n");
    const richSource =
        formatted.length <= jsonHighlightByteMaximum &&
        lines.length <= jsonHighlightLineMaximum;

    return (
        <div className="flex min-h-full min-w-0 flex-col">
            <div className="border-primary-700 bg-primary-900/80 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="info">{format.toUpperCase()}</Badge>
                    <Text size="sm" tone="muted">
                        {jsonDocumentSummary(parsed)}
                    </Text>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                    <Button
                        aria-pressed={mode === "tree"}
                        onClick={() => setMode("tree")}
                        size="sm"
                        variant={mode === "tree" ? "secondary" : "ghost"}
                    >
                        Tree
                    </Button>
                    <Button
                        aria-pressed={mode === "source"}
                        onClick={() => setMode("source")}
                        size="sm"
                        variant={mode === "source" ? "secondary" : "ghost"}
                    >
                        Source
                    </Button>
                    {mode === "source" && (
                        <Switch
                            checked={wrapLongLines}
                            label="Wrap lines"
                            onChange={setWrapLongLines}
                        />
                    )}
                    <CopyTextButton label={copyLabel} text={content} />
                </div>
            </div>
            {mode === "tree" && (
                <JsonTree ariaLabel={`${ariaLabel} tree`} value={parsed} />
            )}
            {mode === "source" && (
                <SourceSurface
                    ariaLabel={ariaLabel}
                    content={formatted}
                    highlight={richSource}
                    language="json"
                    wrapLongLines={wrapLongLines}
                />
            )}
        </div>
    );
}
