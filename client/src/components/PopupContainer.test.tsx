import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { PopupContainer } from './PopupContainer.js';
import { popups, showPopup, dismissPopup, confirmPopup, alertPopup, promptPopup } from '../stores/popupStore.js';

describe('PopupContainer', () => {
  beforeEach(() => {
    while (popups.length > 0) {
      dismissPopup(popups[0]!.id);
    }
  });

  it('renders nothing when no popups', () => {
    render(() => <PopupContainer />);
    expect(document.querySelector('.popup-overlay')).not.toBeInTheDocument();
  });

  it('renders alert popup', () => {
    alertPopup('Something happened');
    render(() => <PopupContainer />);
    expect(screen.getByText('Something happened')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders confirm popup with buttons', () => {
    confirmPopup('Are you sure?');
    render(() => <PopupContainer />);
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });

  it('clicking OK resolves confirm popup', async () => {
    const promise = confirmPopup('Sure?');
    render(() => <PopupContainer />);
    screen.getByText('Confirm').click();
    await expect(promise).resolves.toBe(true);
    expect(screen.queryByText('Sure?')).not.toBeInTheDocument();
  });

  it('clicking Cancel dismisses confirm popup', async () => {
    const promise = confirmPopup('Sure?');
    render(() => <PopupContainer />);
    screen.getByText('Cancel').click();
    await expect(promise).resolves.toBeUndefined();
  });

  it('renders prompt popup with input', () => {
    promptPopup('Your name?', 'Alice');
    render(() => <PopupContainer />);
    const input = screen.getByRole<HTMLInputElement>('textbox');
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('Alice');
  });

  it('prompt returns entered value on OK', async () => {
    const promise = promptPopup('Name?', '');
    render(() => <PopupContainer />);
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.input(input, { target: { value: 'Bob' } });
    screen.getByText('OK').click();
    await expect(promise).resolves.toBe('Bob');
  });

  it('renders popup with custom title', () => {
    showPopup({ type: 'alert', message: 'Hello', title: 'Greeting' });
    render(() => <PopupContainer />);
    expect(screen.getByText('Greeting')).toBeInTheDocument();
  });

  it('renders input popup with number type', () => {
    showPopup({ type: 'input', message: 'Age?', inputType: 'number', defaultValue: 25 });
    render(() => <PopupContainer />);
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it('renders input popup with checkbox type', () => {
    showPopup({ type: 'input', message: 'Enable?', inputType: 'checkbox', defaultValue: true });
    render(() => <PopupContainer />);
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.checked).toBe(true);
  });

  it('renders input popup with textarea type', () => {
    showPopup({ type: 'input', message: 'Details?', inputType: 'textarea' });
    render(() => <PopupContainer />);
    expect(document.querySelector('textarea')).toBeInTheDocument();
  });

  it('clicking backdrop dismisses popup', async () => {
    const promise = alertPopup('Hi');
    render(() => <PopupContainer />);
    const backdrop = document.querySelector('.popup-backdrop');
    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(promise).resolves.toBeUndefined();
  });

  it('stacked popups render in order', () => {
    showPopup({ type: 'alert', message: 'First' });
    showPopup({ type: 'alert', message: 'Second' });
    render(() => <PopupContainer />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it(' Escape key dismisses popup', async () => {
    const promise = confirmPopup('Sure?');
    render(() => <PopupContainer />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await expect(promise).resolves.toBeUndefined();
  });
});
