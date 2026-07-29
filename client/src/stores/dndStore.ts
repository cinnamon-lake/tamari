import { createSignal } from 'solid-js';
import type { AttachmentRef } from '@tamari/types';

const [pendingAttachments, setPendingAttachments] = createSignal<AttachmentRef[]>([]);
const [pendingDropFiles, setPendingDropFiles] = createSignal<File[]>([]);

export function appendPendingAttachments(atts: AttachmentRef[]): void {
  setPendingAttachments((prev) => [...prev, ...atts]);
}

export function clearPendingAttachments(): void {
  setPendingAttachments([]);
}

export function appendPendingDropFiles(files: File[]): void {
  setPendingDropFiles((prev) => [...prev, ...files]);
}

export function clearPendingDropFiles(): void {
  setPendingDropFiles([]);
}

export { pendingAttachments, pendingDropFiles };
