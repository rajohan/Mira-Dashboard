import type {
    SourceAmbientRuntimeDeclaration,
    SourceReferenceDirective,
    SourceTypeScriptSuppressionDirective,
} from "./importGraph.ts";
import { isRecord, nodeType, sourceLine, type AstRecord } from "./sourceAst.ts";

/**
 * Finds runtime-shaped ambient declarations that can restore forbidden globals.
 * @param node ESTree-compatible AST record.
 * @returns Ambient runtime declaration finding when present.
 */
export function ambientRuntimeDeclarationFromNode(
    node: AstRecord
): SourceAmbientRuntimeDeclaration | undefined {
    const type = nodeType(node);
    if (
        (type === "TSDeclareFunction" && node.declare === true) ||
        ((type === "VariableDeclaration" ||
            type === "ClassDeclaration" ||
            type === "TSEnumDeclaration" ||
            type === "TSModuleDeclaration") &&
            node.declare === true) ||
        (type === "TSModuleDeclaration" && node.global === true)
    ) {
        return { line: sourceLine(node) };
    }
    return undefined;
}

/**
 * Finds TypeScript triple-slash references that alter per-file ambient authority.
 * @param ast Parsed Oxc file AST.
 * @returns Triple-slash reference findings.
 */
export function referenceDirectives(ast: unknown): readonly SourceReferenceDirective[] {
    if (!isRecord(ast) || !Array.isArray(ast.comments)) return [];
    return ast.comments.flatMap((comment) => {
        if (
            !isRecord(comment) ||
            nodeType(comment) !== "CommentLine" ||
            typeof comment.value !== "string" ||
            !/^[\t ]*\/[\t ]*<reference(?:[\t />]|$)/iu.test(comment.value)
        ) {
            return [];
        }
        return [{ line: sourceLine(comment) }];
    });
}

/**
 * Finds TypeScript suppression comments that can hide erased runtime references.
 * @param ast Parsed Oxc file AST.
 * @returns TypeScript suppression findings.
 */
export function typeScriptSuppressionDirectives(
    ast: unknown
): readonly SourceTypeScriptSuppressionDirective[] {
    if (!isRecord(ast) || !Array.isArray(ast.comments)) return [];
    return ast.comments.flatMap((comment) => {
        if (
            !isRecord(comment) ||
            typeof comment.value !== "string" ||
            !/@ts-(?:expect-error|ignore|nocheck)\b/u.test(comment.value)
        ) {
            return [];
        }
        return [{ line: sourceLine(comment) }];
    });
}
