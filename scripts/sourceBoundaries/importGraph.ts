import * as babel from "@babel/core";

import {
    runtimeAuthorityIdentifierNames,
    runtimeEnvironmentAccessFromNode,
    runtimeImportsFromNode,
    runtimeOwnerEscapeFromNode,
} from "./runtimeAuthorityAnalysis.ts";
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
import {
    ambientRuntimeDeclarationFromNode,
    referenceDirectives,
    typeScriptSuppressionDirectives,
} from "./sourceDirectives.ts";

/** Static module edge extracted from one JavaScript or TypeScript source file. */
export interface SourceImportBinding {
    readonly imported: string;
    readonly typeOnly: boolean;
}

/** Static module edge extracted from one JavaScript or TypeScript source file. */
export interface SourceImport {
    readonly kind:
        | "dynamic-code"
        | "dynamic-import"
        | "export"
        | "import"
        | "module-loader"
        | "process-execution"
        | "require"
        | "shell-execution";
    readonly importedBindings?: readonly SourceImportBinding[];
    readonly line: number;
    readonly specifier?: string;
}

/** Direct read of a runtime-owned process environment object. */
export interface SourceEnvironmentAccess {
    readonly line: number;
}

/** Escape of a runtime/global authority object that prevents local access review. */
export interface SourceRuntimeAuthorityEscape {
    readonly line: number;
}

/** Runtime-shaped ambient declaration that can reintroduce forbidden globals. */
export interface SourceAmbientRuntimeDeclaration {
    readonly line: number;
}

/** TypeScript triple-slash reference that can alter one file's ambient authority. */
export interface SourceReferenceDirective {
    readonly line: number;
}

/** TypeScript diagnostic suppression that can hide erased runtime references. */
export interface SourceTypeScriptSuppressionDirective {
    readonly line: number;
}

/** Security-relevant syntax extracted from one production source file. */
export interface SourceAnalysis {
    readonly ambientRuntimeDeclarations: readonly SourceAmbientRuntimeDeclaration[];
    readonly environmentAccesses: readonly SourceEnvironmentAccess[];
    readonly imports: readonly SourceImport[];
    readonly referenceDirectives: readonly SourceReferenceDirective[];
    readonly runtimeAuthorityEscapes: readonly SourceRuntimeAuthorityEscape[];
    readonly typeScriptSuppressionDirectives: readonly SourceTypeScriptSuppressionDirective[];
}

type BabelParserPlugins = NonNullable<
    NonNullable<babel.InputOptions["parserOpts"]>["plugins"]
>;

function importFromCall(
    node: AstRecord,
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
    const arguments_ = callArguments(node);
    if (calleeType === "Import") {
        const specifier = stringLiteralValue(arguments_[0]);
        return {
            kind: "dynamic-import",
            line: sourceLine(node),
            ...(specifier === undefined ? {} : { specifier }),
        };
    }
    if (calleeType === "Identifier" && node.callee.name === "require") {
        const specifier = stringLiteralValue(arguments_[0]);
        return {
            kind: "require",
            line: sourceLine(node),
            ...(specifier === undefined ? {} : { specifier }),
        };
    }
    if (
        (calleeType === "MemberExpression" ||
            calleeType === "OptionalMemberExpression") &&
        memberPropertyName(node.callee, staticStringValues) === "require"
    ) {
        const specifier = stringLiteralValue(arguments_[0]);
        return {
            kind: "require",
            line: sourceLine(node),
            ...(specifier === undefined ? {} : { specifier }),
        };
    }
    return undefined;
}

function importFromNode(
    node: AstRecord,
    staticStringValues: StaticStringValues
): SourceImport | undefined {
    const type = nodeType(node);
    if (type === "ImportDeclaration") {
        const specifier = stringLiteralValue(node.source);
        if (specifier === undefined) return undefined;
        const declarationTypeOnly = node.importKind === "type";
        const importedBindings = Array.isArray(node.specifiers)
            ? node.specifiers.flatMap((candidate): SourceImportBinding[] => {
                  if (!isRecord(candidate)) return [];
                  const candidateType = nodeType(candidate);
                  if (candidateType === "ImportDefaultSpecifier") {
                      return [{ imported: "default", typeOnly: declarationTypeOnly }];
                  }
                  if (candidateType === "ImportNamespaceSpecifier") {
                      return [{ imported: "*", typeOnly: declarationTypeOnly }];
                  }
                  if (candidateType !== "ImportSpecifier") return [];
                  const imported =
                      identifierName(candidate.imported) ??
                      stringLiteralValue(candidate.imported);
                  return imported === undefined
                      ? []
                      : [
                            {
                                imported,
                                typeOnly:
                                    declarationTypeOnly ||
                                    candidate.importKind === "type",
                            },
                        ];
              })
            : [];
        return {
            kind: "import",
            importedBindings,
            line: sourceLine(node),
            specifier,
        };
    }
    if (type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") {
        const specifier = stringLiteralValue(node.source);
        return specifier === undefined
            ? undefined
            : { kind: "export", line: sourceLine(node), specifier };
    }
    if (type === "ImportExpression") {
        const specifier = stringLiteralValue(node.source);
        return {
            kind: "dynamic-import",
            line: sourceLine(node),
            ...(specifier === undefined ? {} : { specifier }),
        };
    }
    if (type === "TSImportType") {
        const specifier = stringLiteralValue(node.source ?? node.argument);
        return specifier === undefined
            ? undefined
            : { kind: "import", line: sourceLine(node), specifier };
    }
    if (type === "TSExternalModuleReference") {
        const specifier = stringLiteralValue(node.expression);
        return specifier === undefined
            ? undefined
            : { kind: "require", line: sourceLine(node), specifier };
    }
    return importFromCall(node, staticStringValues);
}

function visitAst(
    value: unknown,
    seen: Set<object>,
    imports: SourceImport[],
    environmentAccesses: SourceEnvironmentAccess[],
    runtimeAuthorityEscapes: SourceRuntimeAuthorityEscape[],
    ambientRuntimeDeclarations: SourceAmbientRuntimeDeclaration[],
    runtimeIdentifierReferences: RuntimeIdentifierReferences,
    staticStringValues: StaticStringValues,
    parent?: AstRecord
): void {
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);

    const sourceImport = importFromNode(value, staticStringValues);
    if (sourceImport !== undefined) imports.push(sourceImport);
    const environmentAccess = runtimeEnvironmentAccessFromNode(
        value,
        runtimeIdentifierReferences,
        staticStringValues
    );
    if (environmentAccess !== undefined) environmentAccesses.push(environmentAccess);
    const runtimeOwnerEscape = runtimeOwnerEscapeFromNode(
        value,
        parent,
        runtimeIdentifierReferences,
        staticStringValues
    );
    if (runtimeOwnerEscape !== undefined) {
        runtimeAuthorityEscapes.push(runtimeOwnerEscape);
    }
    imports.push(
        ...runtimeImportsFromNode(
            value,
            parent,
            runtimeIdentifierReferences,
            staticStringValues
        )
    );
    const ambientRuntimeDeclaration = ambientRuntimeDeclarationFromNode(value);
    if (ambientRuntimeDeclaration !== undefined) {
        ambientRuntimeDeclarations.push(ambientRuntimeDeclaration);
    }

    for (const child of Object.values(value)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                visitAst(
                    item,
                    seen,
                    imports,
                    environmentAccesses,
                    runtimeAuthorityEscapes,
                    ambientRuntimeDeclarations,
                    runtimeIdentifierReferences,
                    staticStringValues,
                    value
                );
            }
        } else {
            visitAst(
                child,
                seen,
                imports,
                environmentAccesses,
                runtimeAuthorityEscapes,
                ambientRuntimeDeclarations,
                runtimeIdentifierReferences,
                staticStringValues,
                value
            );
        }
    }
}

function parserPlugins(filename: string): BabelParserPlugins {
    const plugins: BabelParserPlugins = [];
    if (/\.(?:cts|mts|ts|tsx)$/u.test(filename)) plugins.push("typescript");
    if (/\.(?:jsx|tsx)$/u.test(filename)) plugins.push("jsx");
    return plugins;
}

/**
 * Parses module edges and direct runtime-environment reads from supported source text.
 * @param source JavaScript or TypeScript source text.
 * @param filename Repository-relative filename used for grammar and diagnostics.
 * @returns Security-relevant syntax in source order.
 */
export async function parseSourceAnalysis(
    source: string,
    filename: string
): Promise<SourceAnalysis> {
    const result = await babel.parseAsync(source, {
        babelrc: false,
        configFile: false,
        filename,
        parserOpts: {
            createImportExpressions: true,
            plugins: parserPlugins(filename),
        },
        sourceType: "unambiguous",
    });
    if (result === null) {
        throw new Error(`Babel did not return an AST for ${filename}`);
    }

    const imports: SourceImport[] = [];
    const environmentAccesses: SourceEnvironmentAccess[] = [];
    const runtimeAuthorityEscapes: SourceRuntimeAuthorityEscape[] = [];
    const ambientRuntimeDeclarations: SourceAmbientRuntimeDeclaration[] = [];
    const runtimeIdentifierReferences = new Set<object>();
    const staticStringValues = new Map<object, string>();
    babel.traverse(result, {
        Identifier(identifierPath) {
            const name = identifierPath.node.name;
            const binding = identifierPath.scope.getBinding(name);
            const bindingPath = binding?.path;
            const bindingNode = bindingPath?.node as
                | { readonly importKind?: unknown }
                | undefined;
            const bindingParentNode = bindingPath?.parentPath?.node as
                | { readonly importKind?: unknown }
                | undefined;
            const bindingIsTypeOnly =
                bindingNode?.importKind === "type" ||
                bindingParentNode?.importKind === "type";
            if (
                runtimeAuthorityIdentifierNames.has(name) &&
                identifierPath.isReferencedIdentifier() &&
                (bindingPath === undefined || bindingIsTypeOnly)
            ) {
                runtimeIdentifierReferences.add(identifierPath.node);
            }
            if (
                identifierPath.isReferencedIdentifier() &&
                binding?.constant === true &&
                isRecord(bindingPath?.node) &&
                nodeType(bindingPath.node) === "VariableDeclarator" &&
                isRecord(bindingPath.parentPath?.node) &&
                nodeType(bindingPath.parentPath.node) === "VariableDeclaration" &&
                bindingPath.parentPath.node.kind === "const"
            ) {
                const value = staticStringValue(
                    bindingPath.node.init,
                    staticStringValues
                );
                if (value !== undefined) {
                    staticStringValues.set(identifierPath.node, value);
                }
            }
        },
    });
    visitAst(
        result,
        new Set(),
        imports,
        environmentAccesses,
        runtimeAuthorityEscapes,
        ambientRuntimeDeclarations,
        runtimeIdentifierReferences,
        staticStringValues
    );
    const uniqueEnvironmentAccesses = [
        ...new Map(
            environmentAccesses.map((environmentAccess) => [
                environmentAccess.line,
                environmentAccess,
            ])
        ).values(),
    ];
    const uniqueRuntimeAuthorityEscapes = [
        ...new Map(
            runtimeAuthorityEscapes.map((escape) => [escape.line, escape])
        ).values(),
    ];
    const uniqueAmbientRuntimeDeclarations = [
        ...new Map(
            ambientRuntimeDeclarations.map((declaration) => [
                declaration.line,
                declaration,
            ])
        ).values(),
    ];
    return Object.freeze({
        ambientRuntimeDeclarations: Object.freeze(
            uniqueAmbientRuntimeDeclarations.toSorted(
                (left, right) => left.line - right.line
            )
        ),
        environmentAccesses: Object.freeze(
            uniqueEnvironmentAccesses.toSorted((left, right) => left.line - right.line)
        ),
        imports: Object.freeze(imports.toSorted((left, right) => left.line - right.line)),
        referenceDirectives: Object.freeze(referenceDirectives(result)),
        runtimeAuthorityEscapes: Object.freeze(
            uniqueRuntimeAuthorityEscapes.toSorted(
                (left, right) => left.line - right.line
            )
        ),
        typeScriptSuppressionDirectives: Object.freeze(
            typeScriptSuppressionDirectives(result)
        ),
    });
}

/**
 * Parses every static module edge, including type-only imports and re-exports.
 * @param source TypeScript or TSX source text.
 * @param filename Repository-relative filename used for parser diagnostics.
 * @returns Module edges in source order.
 */
export async function parseSourceImports(
    source: string,
    filename: string
): Promise<readonly SourceImport[]> {
    const analysis = await parseSourceAnalysis(source, filename);
    return analysis.imports;
}
