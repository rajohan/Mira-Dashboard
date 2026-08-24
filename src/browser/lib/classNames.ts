import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines conditional class names and resolves conflicting Tailwind utilities.
 * @param values Conditional class-name inputs.
 * @returns One normalized class-name string.
 */
export function cn(...values: ClassValue[]): string {
    return twMerge(clsx(values));
}
