import type { Component } from 'solid-js';

export interface SkeletonProps {
  class?: string;
  width?: string;
  height?: string;
}

export const Skeleton: Component<SkeletonProps> = (props) => {
  return (
    <div
      class={`skeleton ${props.class ?? ''}`}
      style={{
        width: props.width,
        height: props.height,
      }}
    />
  );
};

export const SkeletonText: Component<{ lines?: number; class?: string }> = (props) => {
  const count = props.lines ?? 3;
  return (
    <div class={`skeleton-text ${props.class ?? ''}`}>
      {Array.from({ length: count }).map(() => (
        <Skeleton height="1em" class="skeleton-line" />
      ))}
    </div>
  );
};

export const SkeletonAvatar: Component<{ size?: string; class?: string }> = (props) => {
  return (
    <Skeleton
      class={`skeleton-avatar ${props.class ?? ''}`}
      width={props.size ?? '40px'}
      height={props.size ?? '40px'}
    />
  );
};

export const SkeletonCard: Component<{ class?: string }> = (props) => {
  return (
    <div class={`skeleton-card ${props.class ?? ''}`}>
      <SkeletonAvatar />
      <div class="skeleton-card-body">
        <Skeleton height="1.2em" width="60%" />
        <SkeletonText lines={2} />
      </div>
    </div>
  );
};
