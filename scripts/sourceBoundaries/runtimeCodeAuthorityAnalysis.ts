import type { SourceImport } from "./importGraph.ts";
import {
    isRuntimeEnvironmentOwner,
    isRuntimeGlobalRoot,
    isRuntimeNamedOwner,
    objectPatternReadsNamedProperty,
} from "./runtimeOwnerAnalysis.ts";
import {
    callArguments,
    identifierName,
    isRecord,
    memberPropertyName,
    nodeType,
    sourceLine,
    staticStringValue,
    stringLiteralValue,
    type AstRecord,
    type RuntimeIdentifierReferences,
    type StaticStringValues,
} from "./sourceAst.ts";

function isDirectCallee(node: AstRecord, parent: AstRecord | undefined): boolean {
    if (parent === undefined) return false;
    const parentType = nodeType(parent);
    return (
        (parentType === "CallExpression" ||
            parentType === "OptionalCallExpression" ||
            parentType === "NewExpression") &&
        parent.callee === node
    );
}

function isNonRuntimeIdentifierPosition(
    node: AstRecord,
    parent: AstRecord | undefined
): boolean {
    if (parent === undefined) return false;
    const parentType = nodeType(parent);
    if (
        (parentType === "VariableDeclarator" && parent.id === node) ||
        ((parentType === "FunctionDeclaration" ||
            parentType === "FunctionExpression" ||
            parentType === "ArrowFunctionExpression") &&
            (parent.id === node ||
                (Array.isArray(parent.params) && parent.params.includes(node)))) ||
        ((parentType === "ClassDeclaration" || parentType === "ClassExpression") &&
            parent.id === node) ||
        (parentType === "CatchClause" && parent.param === node) ||
        parentType === "ImportSpecifier" ||
        parentType === "ImportDefaultSpecifier" ||
        parentType === "ImportNamespaceSpecifier" ||
        parentType === "ExportSpecifier" ||
        parentType === "LabeledStatement" ||
        parentType === "BreakStatement" ||
        parentType === "ContinueStatement"
    ) {
        return true;
    }
    if (
        (parentType === "MemberExpression" ||
            parentType === "OptionalMemberExpression") &&
        parent.property === node &&
        parent.computed !== true
    ) {
        return true;
    }
    if (
        (parentType === "ObjectProperty" ||
            parentType === "Property" ||
            parentType === "ObjectMethod") &&
        parent.key === node &&
        parent.value !== node &&
        parent.computed !== true
    ) {
        return true;
    }
    return (
        parentType === "TSQualifiedName" ||
        parentType === "TSTypeQuery" ||
        parentType === "TSTypeReference" ||
        parentType === "TSExpressionWithTypeArguments"
    );
}

interface ReflectedPropertyAccess {
    readonly owner: unknown;
    readonly property?: string;
}

function reflectGetProperty(
    node: AstRecord,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): ReflectedPropertyAccess | undefined {
    if (
        nodeType(node) !== "CallExpression" &&
        nodeType(node) !== "OptionalCallExpression"
    ) {
        return undefined;
    }
    if (!isRecord(node.callee)) return undefined;
    const calleeType = nodeType(node.callee);
    if (
        (calleeType !== "MemberExpression" &&
            calleeType !== "OptionalMemberExpression") ||
        memberPropertyName(node.callee, staticStringValues) !== "get" ||
        !isRuntimeNamedOwner(
            node.callee.object,
            "Reflect",
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return undefined;
    }
    const arguments_ = callArguments(node);
    const owner = arguments_[0];
    const property = staticStringValue(arguments_[1], staticStringValues);
    return property === undefined ? { owner } : { owner, property };
}

const moduleLoaderPropertyNames: ReadonlySet<string> = new Set([
    "createRequire",
    "getBuiltinModule",
    "require",
]);
const globalLoaderIdentifierNames: ReadonlySet<string> = new Set([
    "importScripts",
    "SharedWorker",
    "Worker",
]);
const processLoaderPropertyNames: ReadonlySet<string> = new Set([
    "_linkedBinding",
    "binding",
    "dlopen",
]);
const processExecutionPropertyNames: ReadonlySet<string> = new Set(["execve"]);
const bunLoaderPropertyNames: ReadonlySet<string> = new Set(["plugin"]);
const bunProcessExecutionPropertyNames: ReadonlySet<string> = new Set([
    "spawn",
    "spawnSync",
]);

function restrictedRuntimeLoaderKind(
    owner: unknown,
    property: string,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport["kind"] | undefined {
    if (
        globalLoaderIdentifierNames.has(property) &&
        isRuntimeGlobalRoot(owner, runtimeIdentifierReferences, staticStringValues)
    ) {
        return "module-loader";
    }
    if (
        processLoaderPropertyNames.has(property) &&
        isRuntimeNamedOwner(
            owner,
            "process",
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return "module-loader";
    }
    if (
        processExecutionPropertyNames.has(property) &&
        isRuntimeNamedOwner(
            owner,
            "process",
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return "process-execution";
    }
    if (
        bunLoaderPropertyNames.has(property) &&
        isRuntimeNamedOwner(owner, "Bun", runtimeIdentifierReferences, staticStringValues)
    ) {
        return "module-loader";
    }
    if (
        bunProcessExecutionPropertyNames.has(property) &&
        isRuntimeNamedOwner(owner, "Bun", runtimeIdentifierReferences, staticStringValues)
    ) {
        return "process-execution";
    }
    if (
        property === "$" &&
        isRuntimeNamedOwner(owner, "Bun", runtimeIdentifierReferences, staticStringValues)
    ) {
        return "shell-execution";
    }
    if (
        property === "FFI" &&
        isRuntimeNamedOwner(owner, "Bun", runtimeIdentifierReferences, staticStringValues)
    ) {
        return "module-loader";
    }
    if (
        property === "_compile" &&
        isRuntimeNamedOwner(
            owner,
            "module",
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return "dynamic-code";
    }
    return undefined;
}

function moduleLoaderCallFromNode(
    node: AstRecord,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    if (
        (nodeType(node) !== "CallExpression" &&
            nodeType(node) !== "OptionalCallExpression") ||
        !isRecord(node.callee)
    ) {
        return undefined;
    }
    const calleeType = nodeType(node.callee);
    if (
        (calleeType !== "MemberExpression" &&
            calleeType !== "OptionalMemberExpression") ||
        memberPropertyName(node.callee, staticStringValues) !== "getBuiltinModule" ||
        !isRuntimeEnvironmentOwner(
            node.callee.object,
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return undefined;
    }
    const specifier = stringLiteralValue(callArguments(node)[0]);
    return {
        kind: "module-loader",
        line: sourceLine(node),
        ...(specifier === undefined ? {} : { specifier }),
    };
}

function loaderPrimitiveFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    const type = nodeType(node);
    const name = identifierName(node);
    if (
        name !== undefined &&
        globalLoaderIdentifierNames.has(name) &&
        runtimeIdentifierReferences.has(node) &&
        !isNonRuntimeIdentifierPosition(node, parent)
    ) {
        return { kind: "module-loader", line: sourceLine(node) };
    }
    if (
        name !== undefined &&
        moduleLoaderPropertyNames.has(name) &&
        !isNonRuntimeIdentifierPosition(node, parent)
    ) {
        if (name === "require" && isDirectCallee(node, parent)) return undefined;
        return { kind: "module-loader", line: sourceLine(node) };
    }
    if (type === "MemberExpression" || type === "OptionalMemberExpression") {
        const property = memberPropertyName(node, staticStringValues);
        const restrictedKind =
            property === undefined
                ? undefined
                : restrictedRuntimeLoaderKind(
                      node.object,
                      property,
                      runtimeIdentifierReferences,
                      staticStringValues
                  );
        if (restrictedKind !== undefined) {
            return { kind: restrictedKind, line: sourceLine(node) };
        }
        if (
            property === "serviceWorker" &&
            isRuntimeNamedOwner(
                node.object,
                "navigator",
                runtimeIdentifierReferences,
                staticStringValues
            )
        ) {
            return { kind: "module-loader", line: sourceLine(node) };
        }
        if (property === "addModule") {
            return { kind: "module-loader", line: sourceLine(node) };
        }
        if (
            property !== undefined &&
            moduleLoaderPropertyNames.has(property) &&
            (property !== "getBuiltinModule" ||
                isRuntimeEnvironmentOwner(
                    node.object,
                    runtimeIdentifierReferences,
                    staticStringValues
                ))
        ) {
            return isDirectCallee(node, parent)
                ? undefined
                : { kind: "module-loader", line: sourceLine(node) };
        }
        if (
            property === "get" &&
            isRuntimeNamedOwner(
                node.object,
                "Reflect",
                runtimeIdentifierReferences,
                staticStringValues
            ) &&
            !isDirectCallee(node, parent)
        ) {
            return { kind: "module-loader", line: sourceLine(node) };
        }
    }
    if (
        (type === "ObjectProperty" || type === "Property") &&
        parent !== undefined &&
        nodeType(parent) === "ObjectPattern"
    ) {
        const property =
            node.computed === true
                ? staticStringValue(node.key, staticStringValues)
                : identifierName(node.key);
        if (property !== undefined && moduleLoaderPropertyNames.has(property)) {
            return { kind: "module-loader", line: sourceLine(node) };
        }
        if (property === "addModule") {
            return { kind: "module-loader", line: sourceLine(node) };
        }
    }
    const reflectedProperty = reflectGetProperty(
        node,
        runtimeIdentifierReferences,
        staticStringValues
    );
    if (reflectedProperty === undefined) return undefined;
    if (
        reflectedProperty.property !== undefined &&
        processExecutionPropertyNames.has(reflectedProperty.property) &&
        isRuntimeNamedOwner(
            reflectedProperty.owner,
            "process",
            runtimeIdentifierReferences,
            staticStringValues
        )
    ) {
        return { kind: "process-execution", line: sourceLine(node) };
    }
    if (
        reflectedProperty.property === undefined ||
        reflectedProperty.property === "addModule" ||
        moduleLoaderPropertyNames.has(reflectedProperty.property) ||
        (reflectedProperty.property === "serviceWorker" &&
            isRuntimeNamedOwner(
                reflectedProperty.owner,
                "navigator",
                runtimeIdentifierReferences,
                staticStringValues
            ))
    ) {
        return { kind: "module-loader", line: sourceLine(node) };
    }
    return undefined;
}

const dynamicCodePropertyNames: ReadonlySet<string> = new Set([
    "constructor",
    "eval",
    "Function",
]);
const timerIdentifierNames: ReadonlySet<string> = new Set(["setInterval", "setTimeout"]);

function webAssemblyDynamicCodeFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    if (
        isRuntimeNamedOwner(
            node,
            "WebAssembly",
            runtimeIdentifierReferences,
            staticStringValues
        ) &&
        !isNonRuntimeIdentifierPosition(node, parent)
    ) {
        return { kind: "dynamic-code", line: sourceLine(node) };
    }
    const type = nodeType(node);
    let pattern: unknown;
    let owner: unknown;
    if (type === "VariableDeclarator") {
        pattern = node.id;
        owner = node.init;
    } else if (type === "AssignmentExpression") {
        pattern = node.left;
        owner = node.right;
    }
    if (
        objectPatternReadsNamedProperty(pattern, "WebAssembly", staticStringValues) &&
        isRuntimeGlobalRoot(owner, runtimeIdentifierReferences, staticStringValues)
    ) {
        return { kind: "dynamic-code", line: sourceLine(node) };
    }
    const reflectedProperty = reflectGetProperty(
        node,
        runtimeIdentifierReferences,
        staticStringValues
    );
    return reflectedProperty?.property === "WebAssembly" &&
        isRuntimeGlobalRoot(
            reflectedProperty.owner,
            runtimeIdentifierReferences,
            staticStringValues
        )
        ? { kind: "dynamic-code", line: sourceLine(node) }
        : undefined;
}

function timerDynamicCodeFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    const name = identifierName(node);
    const type = nodeType(node);
    const isRuntimeTimer =
        (name !== undefined &&
            timerIdentifierNames.has(name) &&
            runtimeIdentifierReferences.has(node)) ||
        ((type === "MemberExpression" || type === "OptionalMemberExpression") &&
            timerIdentifierNames.has(
                memberPropertyName(node, staticStringValues) ?? ""
            ) &&
            isRuntimeGlobalRoot(
                node.object,
                runtimeIdentifierReferences,
                staticStringValues
            ));
    if (!isRuntimeTimer || isNonRuntimeIdentifierPosition(node, parent)) {
        return undefined;
    }
    if (!isDirectCallee(node, parent)) {
        return { kind: "dynamic-code", line: sourceLine(node) };
    }
    if (parent === undefined) return undefined;
    return staticStringValue(callArguments(parent)[0], staticStringValues) === undefined
        ? undefined
        : { kind: "dynamic-code", line: sourceLine(parent) };
}

function dynamicCodePrimitiveFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    const webAssemblyDynamicCode = webAssemblyDynamicCodeFromNode(
        node,
        parent,
        runtimeIdentifierReferences,
        staticStringValues
    );
    if (webAssemblyDynamicCode !== undefined) return webAssemblyDynamicCode;
    const timerDynamicCode = timerDynamicCodeFromNode(
        node,
        parent,
        runtimeIdentifierReferences,
        staticStringValues
    );
    if (timerDynamicCode !== undefined) return timerDynamicCode;
    const name = identifierName(node);
    if (
        (name === "eval" || name === "Function") &&
        runtimeIdentifierReferences.has(node) &&
        !isNonRuntimeIdentifierPosition(node, parent)
    ) {
        return { kind: "dynamic-code", line: sourceLine(node) };
    }
    const type = nodeType(node);
    if (type === "MemberExpression" || type === "OptionalMemberExpression") {
        const property = memberPropertyName(node, staticStringValues);
        if (property !== undefined && dynamicCodePropertyNames.has(property)) {
            return { kind: "dynamic-code", line: sourceLine(node) };
        }
    }
    if (
        (type === "ObjectProperty" || type === "Property") &&
        parent !== undefined &&
        nodeType(parent) === "ObjectPattern"
    ) {
        const property =
            node.computed === true
                ? staticStringValue(node.key, staticStringValues)
                : identifierName(node.key);
        if (property !== undefined && dynamicCodePropertyNames.has(property)) {
            return { kind: "dynamic-code", line: sourceLine(node) };
        }
    }
    const reflectedProperty = reflectGetProperty(
        node,
        runtimeIdentifierReferences,
        staticStringValues
    );
    return reflectedProperty?.property !== undefined &&
        dynamicCodePropertyNames.has(reflectedProperty.property)
        ? { kind: "dynamic-code", line: sourceLine(node) }
        : undefined;
}

/**
 * Finds loader and dynamic-code authority carried by one AST node.
 * @param node ESTree-compatible AST record.
 * @param parent Parent AST record when present.
 * @param runtimeIdentifierReferences Binding-aware global runtime references.
 * @param staticStringValues Bounded computed-key values.
 * @returns Loader and dynamic-code findings for the node.
 */
export function runtimeImportsFromNode(
    node: AstRecord,
    parent: AstRecord | undefined,
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues
): readonly SourceImport[] {
    const imports = [
        moduleLoaderCallFromNode(node, runtimeIdentifierReferences, staticStringValues),
        loaderPrimitiveFromNode(
            node,
            parent,
            runtimeIdentifierReferences,
            staticStringValues
        ),
        dynamicCodePrimitiveFromNode(
            node,
            parent,
            runtimeIdentifierReferences,
            staticStringValues
        ),
    ];
    return imports.filter((sourceImport): sourceImport is SourceImport => {
        return sourceImport !== undefined;
    });
}
