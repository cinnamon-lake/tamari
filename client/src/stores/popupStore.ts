import { createStore, produce } from 'solid-js/store';

export type PopupType = 'confirm' | 'alert' | 'prompt' | 'input';
export type PopupInputType = 'text' | 'textarea' | 'number' | 'checkbox';

export interface PopupButton {
  label: string;
  value: unknown;
  class?: string;
}

export interface PopupConfig {
  type: PopupType;
  title?: string;
  message: string;
  inputType?: PopupInputType;
  defaultValue?: string | number | boolean;
  buttons?: PopupButton[];
  confirmLabel?: string;
  cancelLabel?: string;
  wide?: boolean;
  large?: boolean;
}

export interface PopupState {
  id: number;
  config: PopupConfig;
  resolve: (value: unknown) => void;
}

const [popups, setPopups] = createStore<PopupState[]>([]);
let popupIdCounter = 0;

export { popups };

export function showPopup<T>(config: PopupConfig): Promise<T | undefined> {
  return new Promise((resolve) => {
    const id = ++popupIdCounter;
    const popup: PopupState = { id, config, resolve: resolve as (value: unknown) => void };
    setPopups(produce((draft) => draft.push(popup)));
  });
}

export function resolvePopup(id: number, value: unknown) {
  const popup = popups.find((p) => p.id === id);
  if (popup) {
    popup.resolve(value);
    setPopups(
      produce((draft) => {
        const index = draft.findIndex((p) => p.id === id);
        if (index !== -1) draft.splice(index, 1);
      }),
    );
  }
}

export function dismissPopup(id: number) {
  resolvePopup(id, undefined);
}

// Convenience helpers

export function confirmPopup(message: string, title?: string): Promise<boolean> {
  return showPopup({ type: 'confirm', message, title }) as Promise<boolean>;
}

export function alertPopup(message: string, title?: string): Promise<void> {
  return showPopup({ type: 'alert', message, title });
}

export function promptPopup(message: string, defaultValue = '', title?: string): Promise<string | null> {
  return showPopup({
    type: 'prompt',
    message,
    title,
    defaultValue,
  }) as Promise<string | null>;
}

export function inputPopup(config: Omit<PopupConfig, 'type'> & { inputType: PopupInputType }): Promise<unknown> {
  return showPopup({ ...config, type: 'input' });
}
