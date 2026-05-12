import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Performs cn. */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
