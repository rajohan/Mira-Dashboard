import type { TaskDetail } from "../../contracts/taskModel.ts";
import { Modal } from "../ui/Modal.tsx";
import { TaskEditorForm } from "./TaskEditorForm.tsx";

interface NewTaskModalProps {
    readonly availableLabels?: readonly string[];
    readonly onClose: () => void;
    readonly onCreated: (task: TaskDetail) => void;
    readonly open: boolean;
}

/** @returns Task-creation dialog over the shared task editor. */
export function NewTaskModal({
    availableLabels = [],
    onClose,
    onCreated,
    open,
}: NewTaskModalProps) {
    return (
        <Modal
            onClose={onClose}
            open={open}
            scrollOwner="content"
            size="md"
            title="New task"
        >
            <TaskEditorForm
                availableLabels={availableLabels}
                onCancel={onClose}
                onSaved={onCreated}
            />
        </Modal>
    );
}
