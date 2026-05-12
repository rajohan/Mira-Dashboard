import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges CSS class values with Tailwind conflict resolution.
 * @param inputs - Class values accepted by clsx.
 * @returns A merged class name string.
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
