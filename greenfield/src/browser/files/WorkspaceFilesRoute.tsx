import { PageHeader } from "../ui/PageHeader.tsx";
import { WorkspaceFilesBrowser } from "./WorkspaceFilesBrowser.tsx";

/** @returns Reviewed workspace roots with ticketed reads and worker-queued writes. */
export function WorkspaceFilesRoute() {
    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                description="Browse and edit files in the approved Dashboard and Mira workspace folders. Preview, download, upload, and replace files without exposing server paths."
                eyebrow="Workspace"
                title="Files"
            />
            <div className="mt-8 min-h-0 flex-1 lg:overflow-hidden">
                <WorkspaceFilesBrowser />
            </div>
        </div>
    );
}
