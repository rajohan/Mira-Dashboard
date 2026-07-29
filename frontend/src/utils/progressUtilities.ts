export type ProgressColor = "blue" | "green" | "orange" | "red" | "yellow";

/**
 * Returns the semantic progress color for a percentage.
 * @param percent Percent value.
 * @returns the semantic progress color for a percentage.
 */
export function getProgressColor(percent: number): ProgressColor {
    if (percent < 50) return "green";
    if (percent < 75) return "blue";
    if (percent < 90) return "orange";
    return "red";
}
