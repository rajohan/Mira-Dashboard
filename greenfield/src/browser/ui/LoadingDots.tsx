interface LoadingDotsProps {
    readonly label: string;
}

const loadingStateDotsClassName = "loading-state-dots";
const loadingStateDotClassName = "loading-state-dot";

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
            <span
                className={`${loadingStateDotsClassName} inline-block min-w-[1.5em] text-left`}
            >
                <span className={`${loadingStateDotClassName} inline-block`}>.</span>
                <span
                    className={`${loadingStateDotClassName} inline-block animate-[loading-state-second-dot_1.2s_steps(1,end)_infinite] opacity-0 motion-reduce:animate-none motion-reduce:opacity-100`}
                >
                    .
                </span>
                <span
                    className={`${loadingStateDotClassName} inline-block animate-[loading-state-third-dot_1.2s_steps(1,end)_infinite] opacity-0 motion-reduce:animate-none motion-reduce:opacity-100`}
                >
                    .
                </span>
            </span>
        </span>
    );
}
