import type { FormHTMLAttributes, ReactNode } from "react";

interface FormProps extends Omit<
    FormHTMLAttributes<HTMLFormElement>,
    "children" | "onSubmit"
> {
    readonly children: ReactNode;
    readonly onSubmit: () => Promise<void> | void;
}

/**
 * Prevents native navigation and delegates submission without deprecated React event types.
 * @returns A client-managed HTML form boundary.
 */
export function Form({
    children,
    noValidate = true,
    onSubmit,
    ...properties
}: FormProps) {
    return (
        <form
            {...properties}
            noValidate={noValidate}
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onSubmit();
            }}
        >
            {children}
        </form>
    );
}
