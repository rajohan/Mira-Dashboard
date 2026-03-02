import { useEffect, useState } from "react";

export function useModalRoot(isOpen: boolean) {
    const [modalRoot, setModalRoot] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!isOpen) {
            // Remove root when modal closes
            if (modalRoot && modalRoot.childNodes.length === 0) {
                modalRoot.remove();
            }
            setModalRoot(null);
            return;
        }

        // Create or get root when modal opens
        let root = document.querySelector<HTMLElement>("#modal-root");
        if (!root) {
            root = document.createElement("div");
            root.id = "modal-root";
            document.body.append(root);
        }
        setModalRoot(root);

        return () => {
            // Cleanup on unmount while open
            if (root && root.childNodes.length === 0) {
                root.remove();
            }
        };
    }, [isOpen]);

    return modalRoot;
}
