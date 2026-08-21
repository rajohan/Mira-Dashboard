import { Download } from "lucide-react";

import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { CopyTextButton } from "../ui/CopyTextButton.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { downloadRecoveryCodes } from "./recoveryCodeDownload.ts";

interface RecoveryCodesModalProps {
    readonly codes: readonly string[];
    readonly onClose: () => void;
}

/**
 * Presents one server-issued recovery-code set without persisting its raw values.
 * @returns The one-time recovery-code dialog.
 */
export function RecoveryCodesModal({ codes, onClose }: RecoveryCodesModalProps) {
    return (
        <Modal onClose={onClose} open size="md" title="Save recovery codes now">
            <Alert
                focusOnError={false}
                message="These full codes are shown once. Store them offline. Do not put them in Dashboard notes or screenshots."
                variant="warning"
            />
            <ul className="my-4 grid min-w-0 grid-cols-1 gap-2">
                {codes.map((code) => (
                    <li key={code}>
                        <code className="bg-primary-900 text-primary-100 block min-w-0 rounded-lg p-2 text-center text-xs break-all whitespace-normal">
                            {code}
                        </code>
                    </li>
                ))}
            </ul>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <CopyTextButton label="Copy recovery codes" text={codes.join("\n")} />
                <Button onClick={() => downloadRecoveryCodes(codes)}>
                    <Icon icon={Download} size="sm" tone="inherit" />
                    Download
                </Button>
            </div>
        </Modal>
    );
}
