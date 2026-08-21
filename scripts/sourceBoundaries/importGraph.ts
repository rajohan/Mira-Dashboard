import { analyze } from "@typescript-eslint/scope-manager";
import { parseSync } from "oxc-parser";

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

function lineAtOffset(offset: number, lineStarts: readonly number[]): number {
    let lower = 0;
    let upper = lineStarts.length;
    while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if ((lineStarts[middle] ?? 0) <= offset) lower = middle + 1;
        else upper = middle;
    }
    return Math.max(1, lower);
}

function attachSourceLocations(ast: AstRecord, source: string): void {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") lineStarts.push(index + 1);
    }
    const seen = new Set<object>();
    function visit(value: unknown): void {
        if (!isRecord(value) || seen.has(value)) return;
        seen.add(value);
        if (typeof value.start === "number" && typeof value.end === "number") {
            value.loc = {
                start: { line: lineAtOffset(value.start, lineStarts) },
                end: { line: lineAtOffset(value.end, lineStarts) },
            };
        }
        for (const child of Object.values(value)) {
            if (Array.isArray(child)) {
                for (const item of child) visit(item);
            } else visit(child);
        }
    }
    visit(ast);
}

function isTypeOnlyImportDefinition(definition: {
    readonly node?: unknown;
    readonly parent?: unknown;
}): boolean {
    return (
        (isRecord(definition.node) && definition.node.importKind === "type") ||
        (isRecord(definition.parent) && definition.parent.importKind === "type")
    );
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
    await Promise.resolve();
    const result = parseSync(filename, source, {
        astType: "ts",
        preserveParens: true,
        range: true,
        showSemanticErrors: true,
        sourceType: "unambiguous",
    });
    if (result.errors.length > 0) {
        throw new SyntaxError(result.errors.map(({ message }) => message).join("\n"));
    }
    const ast = result.program as unknown as AstRecord;
    ast.comments = result.comments.map((comment) => ({
        ...comment,
        type: comment.type === "Line" ? "CommentLine" : "CommentBlock",
    }));
    attachSourceLocations(ast, source);

    const imports: SourceImport[] = [];
    const environmentAccesses: SourceEnvironmentAccess[] = [];
    const runtimeAuthorityEscapes: SourceRuntimeAuthorityEscape[] = [];
    const ambientRuntimeDeclarations: SourceAmbientRuntimeDeclaration[] = [];
    const runtimeIdentifierReferences = new Set<object>();
    const staticStringValues = new Map<object, string>();
    const scopeManager = analyze(
        result.program as unknown as Parameters<typeof analyze>[0],
        {
            jsxPragma: null,
            sourceType: result.program.sourceType,
        }
    );
    const references = scopeManager.scopes.flatMap((scope) => scope.references);
    for (const reference of references) {
        const name = reference.identifier.name;
        const typeOnlyBinding =
            reference.resolved !== null &&
            reference.resolved.defs.length > 0 &&
            reference.resolved.defs.every(isTypeOnlyImportDefinition);
        if (
            runtimeAuthorityIdentifierNames.has(name) &&
            reference.isRead() &&
            reference.isValueReference &&
            (reference.resolved === null ||
                reference.resolved.defs.length === 0 ||
                typeOnlyBinding)
        ) {
            runtimeIdentifierReferences.add(reference.identifier);
        }
    }
    for (let pass = 0; pass < references.length; pass += 1) {
        let changed = false;
        for (const reference of references) {
            const binding = reference.resolved;
            const definition = binding?.defs.length === 1 ? binding.defs[0] : undefined;
            if (
                !reference.isRead() ||
                definition === undefined ||
                String(definition.type) !== "Variable" ||
                !isRecord(definition.node) ||
                !isRecord(definition.parent) ||
                definition.parent.kind !== "const" ||
                binding?.references.some(
                    (candidate) => candidate.isWrite() && candidate.init !== true
                )
            ) {
                continue;
            }
            const value = staticStringValue(definition.node.init, staticStringValues);
            if (
                value !== undefined &&
                staticStringValues.get(reference.identifier) !== value
            ) {
                staticStringValues.set(reference.identifier, value);
                changed = true;
            }
        }
        if (!changed) break;
    }
    visitAst(
        ast,
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
        referenceDirectives: Object.freeze(referenceDirectives(ast)),
        runtimeAuthorityEscapes: Object.freeze(
            uniqueRuntimeAuthorityEscapes.toSorted(
                (left, right) => left.line - right.line
            )
        ),
        typeScriptSuppressionDirectives: Object.freeze(
            typeScriptSuppressionDirectives(ast)
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
