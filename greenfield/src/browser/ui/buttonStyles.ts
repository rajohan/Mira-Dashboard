import { cn } from "../lib/classNames.ts";

export type ButtonVariant = "danger" | "ghost" | "primary" | "secondary";
export type ButtonSize = "lg" | "md" | "sm";

const variantClasses: Readonly<Record<ButtonVariant, string>> = Object.freeze({
    danger: "bg-red-600 text-white data-hover:bg-red-500 data-active:bg-red-700 hover:bg-red-500 active:bg-red-700",
    ghost: "bg-transparent text-primary-300 data-hover:bg-primary-800 data-hover:text-primary-50 data-active:bg-primary-700 hover:bg-primary-800 hover:text-primary-50 active:bg-primary-700",
    primary:
        "bg-accent-500 text-white data-hover:bg-accent-400 data-active:bg-accent-600 hover:bg-accent-400 active:bg-accent-600",
    secondary:
        "bg-primary-700 text-primary-100 data-hover:bg-primary-600 data-active:bg-primary-500 hover:bg-primary-600 active:bg-primary-500",
});

const sizeClasses: Readonly<Record<ButtonSize, string>> = Object.freeze({
    lg: "min-h-12 px-5 py-3 text-base",
    md: "min-h-10 px-4 py-2 text-sm",
    sm: "min-h-8 px-2.5 py-1.5 text-sm",
});

interface ButtonStyleOptions {
    readonly className?: string;
    readonly fullWidth?: boolean;
    readonly size?: ButtonSize;
    readonly variant?: ButtonVariant;
}

/**
 * Produces the shared visual contract for buttons and action links.
 * @param options Variant, size, and layout options.
 * @returns Merged Dashboard action classes.
 */
export function buttonClassNames({
    className,
    fullWidth = false,
    size = "md",
    variant = "primary",
}: ButtonStyleOptions = {}): string {
    return cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors",
        "focus-visible:ring-accent-300 focus-visible:ring-offset-primary-900 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-55 data-disabled:cursor-not-allowed data-disabled:opacity-55",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className
    );
}
