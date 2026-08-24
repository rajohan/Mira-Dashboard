import { WorkspaceFilesBrowser } from "./WorkspaceFilesBrowser.tsx";

/** @returns Reviewed workspace roots with ticketed reads and worker-queued writes. */
export function WorkspaceFilesRoute() {
    return (
        <div className="flex flex-col lg:h-full lg:min-h-0">
            <div className="lg:min-h-0 lg:flex-1 lg:overflow-hidden">
                <WorkspaceFilesBrowser />
            </div>
        </div>
    );
}
