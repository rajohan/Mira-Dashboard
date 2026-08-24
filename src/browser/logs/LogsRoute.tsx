import { LogsBrowser } from "./LogsBrowser.tsx";

/** @returns Path-free redacted logs and audited fixed-policy maintenance. */
export function LogsRoute() {
    return (
        <div>
            <h1 className="sr-only">Logs</h1>
            <LogsBrowser />
        </div>
    );
}
