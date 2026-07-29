import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { Skeleton, SkeletonText, SkeletonAvatar, SkeletonCard } from './Skeleton.js';

describe('Skeleton', () => {
  it('renders a plain skeleton with no extra class or size by default', () => {
    const { container } = render(() => <Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass('skeleton');
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  it('applies custom class, width and height', () => {
    const { container } = render(() => <Skeleton class="extra" width="50%" height="2em" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass('skeleton');
    expect(el).toHaveClass('extra');
    expect(el.style.width).toBe('50%');
    expect(el.style.height).toBe('2em');
  });
});

describe('SkeletonText', () => {
  it('renders three lines by default', () => {
    const { container } = render(() => <SkeletonText />);
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(3);
    expect(container.firstElementChild).toHaveClass('skeleton-text');
  });

  it('renders the requested number of lines with 1em height', () => {
    const { container } = render(() => <SkeletonText lines={5} class="wide" />);
    const lines = container.querySelectorAll<HTMLElement>('.skeleton-line');
    expect(lines).toHaveLength(5);
    expect(lines[0]!.style.height).toBe('1em');
    expect(container.firstElementChild).toHaveClass('wide');
  });
});

describe('SkeletonAvatar', () => {
  it('renders a 40px square by default', () => {
    const { container } = render(() => <SkeletonAvatar />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass('skeleton');
    expect(el).toHaveClass('skeleton-avatar');
    expect(el.style.width).toBe('40px');
    expect(el.style.height).toBe('40px');
  });

  it('applies a custom size and class', () => {
    const { container } = render(() => <SkeletonAvatar size="64px" class="big" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('64px');
    expect(el.style.height).toBe('64px');
    expect(el).toHaveClass('skeleton-avatar');
    expect(el).toHaveClass('big');
  });
});

describe('SkeletonCard', () => {
  it('renders without an extra class by default', () => {
    const { container } = render(() => <SkeletonCard />);
    expect(container.firstElementChild).toHaveClass('skeleton-card');
  });

  it('renders an avatar plus a two-line body', () => {
    const { container } = render(() => <SkeletonCard class="mine" />);
    expect(container.firstElementChild).toHaveClass('skeleton-card');
    expect(container.firstElementChild).toHaveClass('mine');
    expect(container.querySelector('.skeleton-avatar')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-card-body')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(2);
  });
});
