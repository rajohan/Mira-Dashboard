import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { CopyTextButton } from "../ui/CopyTextButton.tsx";
import { Modal } from "../ui/Modal.tsx";

interface AutomationTokenModalProps {
    readonly onClose: () => void;
    readonly token: string;
}

/**
 * Presents one server-issued automation token without persisting its raw value.
 * @returns The one-time automation-token dialog.
 */
export function AutomationTokenModal({ onClose, token }: AutomationTokenModalProps) {
    return (
        <Modal onClose={onClose} open size="md" title="Save access token now">
            <Alert
                focusOnError={false}
                message="This full access token is shown once. Store it in the service's protected credential store now."
                variant="warning"
            />
            <code className="bg-primary-900 text-primary-100 my-4 block min-w-0 rounded-lg p-3 text-sm break-all whitespace-normal">
                {token}
            </code>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button onClick={onClose} variant="secondary">
                    Dismiss
                </Button>
                <CopyTextButton label="Copy access token" text={token} />
            </div>
        </Modal>
    );
}
