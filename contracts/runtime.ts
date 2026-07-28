export interface ContractValidationIssue {
    message: string;
    path: string;
}

/** Represents a dependency-free runtime contract failure at a trust boundary. */
export class ContractValidationError extends Error {
    readonly issues: ContractValidationIssue[];

    constructor(issues: ContractValidationIssue[]) {
        super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
        this.name = "ContractValidationError";
        this.issues = issues;
    }
}

export type ContractParser<T> = (value: unknown) => T;

/** Fails one contract field with a stable path suitable for API error details. */
export function invalidContract(path: string, message: string): never {
    throw new ContractValidationError([{ message, path }]);
}

/** Parses a JSON array while leaving item validation to the caller. */
export function contractArray(value: unknown, path: string): unknown[] {
    return Array.isArray(value) ? value : invalidContract(path, "must be an array");
}

/** Parses a non-array JSON object. */
export function contractRecord(value: unknown, path = "body"): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return invalidContract(path, "must be an object");
    }
    return value as Record<string, unknown>;
}

/** Rejects unexpected object fields instead of silently accepting misspellings. */
export function assertContractKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    path = "body"
): void {
    const allowed = new Set(keys);
    const unexpected = Object.keys(value).find((key) => !allowed.has(key));
    if (unexpected) {
        invalidContract(`${path}.${unexpected}`, "is not allowed");
    }
}

export function contractString(
    value: unknown,
    path: string,
    options: {
        allowEmpty?: boolean;
        maximumLength?: number;
        trim?: boolean;
    } = {}
): string {
    if (typeof value !== "string") {
        return invalidContract(path, "must be a string");
    }
    const normalized = options.trim === false ? value : value.trim();
    if (!options.allowEmpty && !value.trim()) {
        return invalidContract(path, "is required");
    }
    if (
        options.maximumLength !== undefined &&
        normalized.length > options.maximumLength
    ) {
        return invalidContract(
            path,
            `must be at most ${options.maximumLength} characters`
        );
    }
    return normalized;
}

export function optionalContractString(
    value: unknown,
    path: string,
    options: {
        allowEmpty?: boolean;
        maximumLength?: number;
        trim?: boolean;
    } = {}
): string | undefined {
    return value === undefined ? undefined : contractString(value, path, options);
}

/** Requires a boolean contract field and returns its validated value. */
export function requiresContractBoolean(value: unknown, path: string): boolean {
    return typeof value === "boolean"
        ? value
        : invalidContract(path, "must be a boolean");
}

export function optionalContractBoolean(
    value: unknown,
    path: string
): boolean | undefined {
    return value === undefined ? undefined : requiresContractBoolean(value, path);
}

export function contractFiniteNumber(value: unknown, path: string): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : invalidContract(path, "must be a finite number");
}

export function contractPositiveInteger(value: unknown, path: string): number {
    const number = contractFiniteNumber(value, path);
    return Number.isSafeInteger(number) && number > 0
        ? number
        : invalidContract(path, "must be a positive integer");
}

export function optionalContractStringArray(
    value: unknown,
    path: string
): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        return invalidContract(path, "must be an array of strings");
    }
    return value.map((item, index) =>
        contractString(item, `${path}[${index}]`, { allowEmpty: true, trim: false })
    );
}

export function contractEnum<const T extends string>(
    value: unknown,
    values: readonly T[],
    path: string
): T {
    return typeof value === "string" && values.includes(value as T)
        ? (value as T)
        : invalidContract(path, `must be one of: ${values.join(", ")}`);
}

export function optionalContractEnum<const T extends string>(
    value: unknown,
    values: readonly T[],
    path: string
): T | undefined {
    return value === undefined ? undefined : contractEnum(value, values, path);
}
