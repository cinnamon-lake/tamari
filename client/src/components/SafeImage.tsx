import { createSignal, Show } from 'solid-js';
import { authenticatedUrl } from '../lib/apiFetch.js';

export interface SafeImageProps {
  src: string | undefined;
  alt?: string;
  class?: string;
  loading?: 'lazy' | 'eager';
  width?: number;
  height?: number;
}

export function SafeImage(props: SafeImageProps) {
  const [error, setError] = createSignal(false);

  const src = () => {
    const url = props.src;
    if (!url) return undefined;
    return url.startsWith('/api/') || url.startsWith('/files/') ? authenticatedUrl(url) : url;
  };

  return (
    <Show when={src() && !error()}>
      <img
        src={src()}
        alt={props.alt ?? ''}
        class={props.class}
        loading={props.loading}
        width={props.width}
        height={props.height}
        style={props.width && props.height ? { 'aspect-ratio': `${props.width} / ${props.height}` } : undefined}
        onError={() => setError(true)}
      />
    </Show>
  );
}
