import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Handles cn. */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
