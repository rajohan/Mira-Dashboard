import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges CSS class values with Tailwind conflict resolution.
 * @param classValues - Class values accepted by clsx.
 * @returns A merged class name string.
 */
export function cn(...classValues: ClassValue[]) {
    return twMerge(clsx(classValues));
}
