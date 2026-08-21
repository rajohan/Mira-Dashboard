import { cn } from "../lib/classNames.ts";
import { Button, type ButtonProps } from "./Button.tsx";

interface StretchedActionProps extends Omit<
    ButtonProps,
    "aria-label" | "children" | "variant"
> {
    readonly label: string;
}

/**
 * Covers one positioned card with a keyboard-focusable primary action.
 * @returns A full-surface button intended to sit below sibling action controls.
 */
export function StretchedAction({
    className,
    label,
    ...properties
}: StretchedActionProps) {
    return (
        <Button
            {...properties}
            aria-label={label}
            className={cn(
                "absolute inset-0 rounded-lg focus-visible:ring-offset-0",
                className
            )}
            variant="unstyled"
        >
            <span className="sr-only">{label}</span>
        </Button>
    );
}
