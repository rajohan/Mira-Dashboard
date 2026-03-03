import { Server } from "lucide-react";

import { Card } from "../../ui/Card";
import { ReadOnlyField } from "../ui/ExpandableCard";

interface ServerInfoProps {
    version: string;
}

export function ServerInfo({ version }: ServerInfoProps) {
    return (
        <Card variant="bordered" className="mb-4">
            <button className="flex w-full items-center justify-between py-1">
                <div className="flex items-center gap-2">
                    <Server size={18} className="text-accent-400" />
                    <span className="font-semibold">Server</span>
                </div>
            </button>
            <div className="mt-4 border-t border-primary-700 pt-4">
                <div className="space-y-2">
                    <ReadOnlyField label="Version" value={version} />
                    <ReadOnlyField label="Platform" value={typeof window !== "undefined" ? window.navigator.platform : "Unknown"} />
                </div>
            </div>
        </Card>
    );
}