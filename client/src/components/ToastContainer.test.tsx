import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { ToastContainer } from './ToastContainer.js';
import { addToast, removeToast, toasts } from '../stores/toastStore.js';
import { setState } from '../stores/serverStore.js';

describe('ToastContainer', () => {
  beforeEach(() => {
    // Clear all toasts
    while (toasts.length > 0) {
      removeToast(toasts[0]!.id);
    }
  });

  it('renders nothing when no toasts', () => {
    render(() => <ToastContainer />);
    expect(document.querySelector('.toast-container')).toBeEmptyDOMElement();
  });

  it('renders a toast message', () => {
    addToast('Hello world', 'info');
    render(() => <ToastContainer />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders multiple toasts', () => {
    addToast('First', 'info');
    addToast('Second', 'error');
    render(() => <ToastContainer />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('applies type-specific class', () => {
    addToast('Error msg', 'error');
    render(() => <ToastContainer />);
    expect(screen.getByText('Error msg').closest('.toast')).toHaveClass('toast-error');
  });

  it('applies warning class for warning toasts', () => {
    addToast('Warning msg', 'warning');
    render(() => <ToastContainer />);
    expect(screen.getByText('Warning msg').closest('.toast')).toHaveClass('toast-warning');
  });

  it('clicking toast removes it', () => {
    addToast('Click me', 'info');
    render(() => <ToastContainer />);
    const toast = screen.getByText('Click me');
    toast.click();
    expect(toast).not.toBeInTheDocument();
  });

  it('clicking close button removes toast', () => {
    addToast('Close me', 'info');
    render(() => <ToastContainer />);
    const closeBtn = screen.getByLabelText('Dismiss');
    closeBtn.click();
    expect(screen.queryByText('Close me')).not.toBeInTheDocument();
  });

  it('applies default top-right position class', () => {
    render(() => <ToastContainer />);
    expect(document.querySelector('.toast-container')).toHaveClass('toast-position-top-right');
  });

  it('applies position class from settings', () => {
    setState('settings', { toastPosition: 'bottom-left' } as any);
    render(() => <ToastContainer />);
    expect(document.querySelector('.toast-container')).toHaveClass('toast-position-bottom-left');
  });

  it('applies top-center position class from settings', () => {
    setState('settings', { toastPosition: 'top-center' } as any);
    render(() => <ToastContainer />);
    expect(document.querySelector('.toast-container')).toHaveClass('toast-position-top-center');
  });

  it('applies bottom-center position class from settings', () => {
    setState('settings', { toastPosition: 'bottom-center' } as any);
    render(() => <ToastContainer />);
    expect(document.querySelector('.toast-container')).toHaveClass('toast-position-bottom-center');
  });
});
