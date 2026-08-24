import { PageHeader } from "../ui/PageHeader.tsx";
import { LogsBrowser } from "./LogsBrowser.tsx";

/** @returns Path-free redacted logs and audited fixed-policy maintenance. */
export function LogsRoute() {
    return (
        <div>
            <PageHeader
                description="View recent lines from configured sources. Sensitive values are removed before display, and queued maintenance jobs require recent multi-factor authentication."
                eyebrow="Operations"
                title="Logs"
            />
            <div className="mt-8">
                <LogsBrowser />
            </div>
        </div>
    );
}
