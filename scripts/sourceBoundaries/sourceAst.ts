/** Minimal ESTree-compatible AST record used by the source-boundary analyzers. */
export type AstRecord = Record<string, unknown>;

/** Binding-aware references to runtime-owned global identifiers. */
export type RuntimeIdentifierReferences = ReadonlySet<object>;

/** Bounded, immutable string values attached to identifier reference nodes. */
export type StaticStringValues = ReadonlyMap<object, string>;

/**
 * Returns whether an unknown value can be inspected as an AST record.
 * @param value Unknown candidate value.
 * @returns Whether the value is a non-null record.
 */
export function isRecord(value: unknown): value is AstRecord {
    return typeof value === "object" && value !== null;
}

/**
 * Returns the ESTree node discriminator when present.
 * @param node ESTree-compatible AST record.
 * @returns Node type string when present.
 */
export function nodeType(node: AstRecord): string | undefined {
    return typeof node.type === "string" ? node.type : undefined;
}

/**
 * Returns only a syntactic string-literal value.
 * @param node Candidate ESTree-compatible node.
 * @returns Literal string value when the node is a string literal.
 */
export function stringLiteralValue(node: unknown): string | undefined {
    if (
        !isRecord(node) ||
        (nodeType(node) !== "StringLiteral" && nodeType(node) !== "Literal")
    ) {
        return undefined;
    }
    return typeof node.value === "string" ? node.value : undefined;
}

/**
 * Returns an identifier name without treating arbitrary AST nodes as identifiers.
 * @param node Candidate ESTree-compatible node.
 * @returns Identifier name when the node is an identifier.
 */
export function identifierName(node: unknown): string | undefined {
    if (!isRecord(node) || nodeType(node) !== "Identifier") return undefined;
    return typeof node.name === "string" ? node.name : undefined;
}

const transparentExpressionTypes: ReadonlySet<string> = new Set([
    "ParenthesizedExpression",
    "ChainExpression",
    "TSAsExpression",
    "TSInstantiationExpression",
    "TSNonNullExpression",
    "TSSatisfiesExpression",
    "TSTypeAssertion",
    "TypeCastExpression",
]);

/**
 * Folds only bounded string syntax used as a computed property key.
 * Calls, interpolation, coercion, mutation, and general constant evaluation remain unresolved.
 * @param node Candidate string expression.
 * @param staticStringValues Binding-aware values for referenced constant identifiers.
 * @returns Statically bounded string value when resolvable.
 */
export function staticStringValue(
    node: unknown,
    staticStringValues: StaticStringValues
): string | undefined {
    if (!isRecord(node)) return undefined;
    const literal = stringLiteralValue(node);
    if (literal !== undefined) return literal;
    const type = nodeType(node);
    if (type === "Identifier") return staticStringValues.get(node);
    if (transparentExpressionTypes.has(type ?? "")) {
        return staticStringValue(node.expression, staticStringValues);
    }
    if (type === "BinaryExpression" && node.operator === "+") {
        const left = staticStringValue(node.left, staticStringValues);
        const right = staticStringValue(node.right, staticStringValues);
        return left === undefined || right === undefined ? undefined : left + right;
    }
    if (
        type !== "TemplateLiteral" ||
        !Array.isArray(node.expressions) ||
        node.expressions.length > 0 ||
        !Array.isArray(node.quasis) ||
        node.quasis.length !== 1 ||
        !isRecord(node.quasis[0]) ||
        !isRecord(node.quasis[0].value)
    ) {
        return undefined;
    }
    const cooked = node.quasis[0].value.cooked;
    if (typeof cooked === "string") return cooked;
    const raw = node.quasis[0].value.raw;
    return typeof raw === "string" ? raw : undefined;
}

/**
 * Returns a stable one-based source line for a node.
 * @param node ESTree-compatible AST record.
 * @returns One-based source line, defaulting to one.
 */
export function sourceLine(node: AstRecord): number {
    const location = node.loc;
    if (!isRecord(location) || !isRecord(location.start)) return 1;
    const line = location.start.line;
    return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 1;
}

/**
 * Returns call arguments without trusting an unknown AST shape.
 * @param node ESTree-compatible AST record.
 * @returns Call arguments or an empty array.
 */
export function callArguments(node: AstRecord): readonly unknown[] {
    return Array.isArray(node.arguments) ? node.arguments : [];
}

/**
 * Resolves a direct or bounded-computed member property name.
 * @param node Member-expression AST record.
 * @param staticStringValues Binding-aware values for referenced constant identifiers.
 * @returns Resolved member property when bounded.
 */
export function memberPropertyName(
    node: AstRecord,
    staticStringValues: StaticStringValues
): string | undefined {
    return node.computed === true
        ? staticStringValue(node.property, staticStringValues)
        : identifierName(node.property);
}
