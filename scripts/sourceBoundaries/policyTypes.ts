/** One actionable source-boundary failure. */
export interface SourceBoundaryViolation {
    readonly importer: string;
    readonly line: number;
    readonly message: string;
    readonly specifier?: string;
}
