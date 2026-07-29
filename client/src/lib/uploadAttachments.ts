import type { AttachmentRef } from '@tamari/types';
import { apiFetch } from './apiFetch.js';
import { fileToBase64 } from './fileToBase64.js';
import { addToast } from '../stores/toastStore.js';

export async function uploadAttachments(files: File[]): Promise<AttachmentRef[]> {
  const newAttachments: AttachmentRef[] = [];

  for (const file of files) {
    try {
      const base64 = await fileToBase64(file);

      const res = await apiFetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: file.type,
          data: base64,
          meta: { name: file.name, size: file.size },
        }),
      });

      if (!res.ok) throw new Error('Upload failed');
      const attachment = (await res.json()) as AttachmentRef;
      newAttachments.push(attachment);
    } catch (err) {
      console.error('Failed to upload attachment:', err);
      addToast('Failed to upload attachment', 'error');
    }
  }

  return newAttachments;
}
