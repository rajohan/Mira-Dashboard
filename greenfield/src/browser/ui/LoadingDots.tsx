interface LoadingDotsProps {
    readonly label: string;
}

function visibleLoadingLabel(label: string): string {
    return label.replace(/(?:…|\.{1,3})$/u, "").trimEnd();
}

/**
 * Renders a visually animated loading label hidden from assistive technology.
 * @returns A stable-width one-to-three-dot loading sequence.
 */
export function LoadingDots({ label }: LoadingDotsProps) {
    return (
        <span aria-hidden="true">
            {visibleLoadingLabel(label)}
            <span className="loading-state-dots">
                <span className="loading-state-dot">.</span>
                <span className="loading-state-dot">.</span>
                <span className="loading-state-dot">.</span>
            </span>
        </span>
    );
}
