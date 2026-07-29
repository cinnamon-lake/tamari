import { createStore, produce } from 'solid-js/store';

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'success' | 'warning' | 'info';
  createdAt: number;
}

const [toasts, setToasts] = createStore<Toast[]>([]);

let toastIdCounter = 0;

export function addToast(message: string, type: Toast['type'] = 'info') {
  const id = `toast-${++toastIdCounter}`;
  const toast: Toast = { id, message, type, createdAt: Date.now() };
  setToasts(produce((draft) => draft.push(toast)));

  // Errors stay until dismissed — an error that vanishes on its own is an error nobody read.
  // (warnings after 6s, the rest after 5s)
  if (type === 'error') return;
  const duration = type === 'warning' ? 6000 : 5000;
  setTimeout(() => {
    removeToast(id);
  }, duration);
}

export function removeToast(id: string) {
  setToasts(
    produce((draft) => {
      const index = draft.findIndex((t) => t.id === id);
      if (index !== -1) draft.splice(index, 1);
    }),
  );
}

export { toasts };
