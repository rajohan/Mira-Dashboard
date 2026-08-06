import type {
    SourceEnvironmentAccess,
    SourceRuntimeAuthorityEscape,
} from "./importGraph.ts";
import {
    identifierName,
    isRecord,
    memberPropertyName,
    nodeType,
    sourceLine,
    staticStringValue,
    type AstRecord,
    type RuntimeIdentifierReferences,
    type StaticStringValues,
} from "./sourceAst.ts";

function isImportMeta(node: unknown): boolean {
    return (
        isRecord(node) &&
        nodeType(node) === "MetaProperty" &&
        identifierName(node.meta) === "import" &&
        identifierName(node.property) === "meta"
    );
}

const runtimeGlobalRootNames: ReadonlySet<string> = new Set([
    "global",
    "globalThis",
    "self",
    "window",
]);

/** Names whose unbound, runtime references carry process or loader authority. */
export const runtimeAuthorityIdentifierNames: ReadonlySet<string> = new Set([
    ...runtimeGlobalRootNames,
    "Bun",
    "Deno",
    "eval",
    "Function",
    "importScripts",
    "module",
    "process",
    "Reflect",
    "SharedWorker",
    "WebAssembly",
    "Worker",
    "navigator",
    "setInterval",
    "setTimeout",
]);

/**
 * Identifies a binding-aware runtime global-root expression.
 * @param node Candidate Babel AST node.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Whether the node denotes a runtime global root.
 */
export function isRuntimeGlobalRoot(
    node: unknown,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): boolean {
    if (!isRecord(node)) return false;
    if (
        runtimeGlobalRootNames.has(identifierName(node) ?? "") &&
        runtimeIdentifierReferences.has(node)
    ) {
        return true;
    }
    const type = nodeType(node);
    return (
        (type === "MemberExpression" || type === "OptionalMemberExpression") &&
        runtimeGlobalRootNames.has(memberPropertyName(node, staticStringValues) ?? "") &&
        isRuntimeGlobalRoot(node.object, runtimeIdentifierReferences, staticStringValues)
    );
}

/**
 * Identifies a runtime owner that can expose process environment state.
 * @param node Candidate Babel AST node.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Whether the node owns runtime environment state.
 */
export function isRuntimeEnvironmentOwner(
    node: unknown,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): boolean {
    if (!isRecord(node)) return false;
    if (
        ["Bun", "Deno", "process"].includes(identifierName(node) ?? "") &&
        runtimeIdentifierReferences.has(node)
    ) {
        return true;
    }
    if (isRuntimeGlobalRoot(node, runtimeIdentifierReferences, staticStringValues)) {
        return true;
    }
    if (isImportMeta(node)) return true;
    const type = nodeType(node);
    if (type !== "MemberExpression" && type !== "OptionalMemberExpression") {
        return false;
    }
    if (
        !["Bun", "Deno", "process"].includes(
            memberPropertyName(node, staticStringValues) ?? ""
        )
    ) {
        return false;
    }
    return isRuntimeGlobalRoot(
        node.object,
        runtimeIdentifierReferences,
        staticStringValues
    );
}

/**
 * Identifies one binding-aware named runtime owner, directly or via a global root.
 * @param node Candidate Babel AST node.
 * @param ownerName Reviewed runtime owner name.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Whether the node denotes the named runtime owner.
 */
export function isRuntimeNamedOwner(
    node: unknown,
    ownerName:
        | "Bun"
        | "Deno"
        | "Reflect"
        | "WebAssembly"
        | "module"
        | "navigator"
        | "process",
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): boolean {
    if (!isRecord(node)) return false;
    if (identifierName(node) === ownerName && runtimeIdentifierReferences.has(node)) {
        return true;
    }
    const type = nodeType(node);
    return (
        (type === "MemberExpression" || type === "OptionalMemberExpression") &&
        memberPropertyName(node, staticStringValues) === ownerName &&
        isRuntimeGlobalRoot(node.object, runtimeIdentifierReferences, staticStringValues)
    );
}

function isRuntimeAuthorityOwner(
    node: unknown,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): boolean {
    return (
        isRuntimeEnvironmentOwner(
            node,
            runtimeIdentifierReferences,
            staticStringValues
        ) ||
        isRuntimeNamedOwner(
            node,
            "module",
            runtimeIdentifierReferences,
            staticStringValues
        ) ||
        isRuntimeNamedOwner(
            node,
            "Reflect",
            runtimeIdentifierReferences,
            staticStringValues
        ) ||
        isRuntimeNamedOwner(
            node,
            "navigator",
            runtimeIdentifierReferences,
            staticStringValues
        )
    );
}

/**
 * Identifies whether an object pattern reads one bounded property.
 * @param node Candidate object-pattern node.
 * @param propertyName Reviewed bounded property name.
 * @param staticStringValues Bounded computed-key values.
 * @returns Whether the pattern reads the property.
 */
export function objectPatternReadsNamedProperty(
    node: unknown,
    propertyName: string,
    staticStringValues: StaticStringValues
): boolean {
    if (!isRecord(node) || nodeType(node) !== "ObjectPattern") return false;
    if (!Array.isArray(node.properties)) return false;
    return node.properties.some(
        (property) =>
            isRecord(property) &&
            (nodeType(property) === "ObjectProperty" ||
                nodeType(property) === "ObjectMethod") &&
            (property.computed === true
                ? staticStringValue(property.key, staticStringValues)
                : identifierName(property.key)) === propertyName
    );
}

function objectPatternOnlyReadsEnvironment(
    node: unknown,
    staticStringValues: StaticStringValues
): boolean {
    if (!isRecord(node) || nodeType(node) !== "ObjectPattern") return false;
    if (!Array.isArray(node.properties) || node.properties.length === 0) return false;
    return node.properties.every(
        (property) =>
            isRecord(property) &&
            nodeType(property) === "ObjectProperty" &&
            (property.computed === true
                ? staticStringValue(property.key, staticStringValues)
                : identifierName(property.key)) === "env"
    );
}

/**
 * Finds one direct read of runtime-owned environment state.
 * @param node Babel AST record.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Environment access finding when present.
 */
export function runtimeEnvironmentAccessFromNode(
    node: AstRecord,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceEnvironmentAccess | undefined {
    const type = nodeType(node);
    if (
        (type === "MemberExpression" || type === "OptionalMemberExpression") &&
        memberPropertyName(node, staticStringValues) === "env" &&
        isRuntimeEnvironmentOwner(
            node.object,
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return { line: sourceLine(node) };
    }
    if (
        type === "VariableDeclarator" &&
        objectPatternReadsNamedProperty(node.id, "env", staticStringValues) &&
        isRuntimeEnvironmentOwner(
            node.init,
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return { line: sourceLine(node) };
    }
    if (
        type === "AssignmentExpression" &&
        objectPatternReadsNamedProperty(node.left, "env", staticStringValues) &&
        isRuntimeEnvironmentOwner(
            node.right,
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return { line: sourceLine(node) };
    }
    return undefined;
}

/**
 * Finds an alias, pass, return, or unresolved dynamic index of runtime authority.
 * @param node Babel AST record.
 * @param parent Parent AST record when present.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Runtime authority escape finding when present.
 */
export function runtimeOwnerEscapeFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceRuntimeAuthorityEscape | undefined {
    if (
        parent === undefined ||
        !isRuntimeAuthorityOwner(node, runtimeIdentifierReferences, staticStringValues)
    ) {
        return undefined;
    }
    const parentType = nodeType(parent);
    if (
        identifierName(node) !== undefined &&
        (parentType === "MemberExpression" ||
            parentType === "OptionalMemberExpression") &&
        parent.object !== node &&
        parent.computed !== true
    ) {
        return undefined;
    }
    if (
        parentType === "VariableDeclarator" &&
        parent.init === node &&
        objectPatternOnlyReadsEnvironment(parent.id, staticStringValues)
    ) {
        return undefined;
    }
    if (
        parentType === "AssignmentExpression" &&
        parent.right === node &&
        objectPatternOnlyReadsEnvironment(parent.left, staticStringValues)
    ) {
        return undefined;
    }
    if (
        identifierName(node) !== undefined &&
        (parentType === "ObjectProperty" || parentType === "ObjectMethod") &&
        parent.key === node &&
        parent.value !== node &&
        parent.computed !== true
    ) {
        return undefined;
    }
    if (
        (parentType === "MemberExpression" ||
            parentType === "OptionalMemberExpression") &&
        parent.object === node
    ) {
        return parent.computed === true &&
            memberPropertyName(parent, staticStringValues) === undefined
            ? { line: sourceLine(parent) }
            : undefined;
    }
    if (
        parentType === "TSQualifiedName" ||
        parentType === "TSTypeQuery" ||
        parentType === "TSTypeReference" ||
        parentType === "TSExpressionWithTypeArguments" ||
        (parentType === "UnaryExpression" && parent.operator === "typeof")
    ) {
        return undefined;
    }
    return { line: sourceLine(node) };
}
