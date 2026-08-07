import type { TaskDetail } from "../../contracts/taskModel.ts";
import { Modal } from "../ui/Modal.tsx";
import { TaskEditorForm } from "./TaskEditorForm.tsx";

interface NewTaskModalProps {
    readonly onClose: () => void;
    readonly onCreated: (task: TaskDetail) => void;
    readonly open: boolean;
}

/** @returns Task-creation dialog over the shared task editor. */
export function NewTaskModal({ onClose, onCreated, open }: NewTaskModalProps) {
    return (
        <Modal
            description="Create a versioned task with optional assignment and automation."
            onClose={onClose}
            open={open}
            size="lg"
            title="New task"
        >
            <TaskEditorForm onCancel={onClose} onSaved={onCreated} />
        </Modal>
    );
}
