import { createSignal, createEffect, createMemo, onCleanup, type Component } from 'solid-js';
import { useI18n } from '../i18n/index.js';
import './AudioPlayer.css';

export interface AudioPlayerProps {
  src: string;
  title?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const AudioPlayer: Component<AudioPlayerProps> = (props) => {
  const { t } = useI18n();
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [volume, setVolume] = createSignal(1);
  const [isDragging, setIsDragging] = createSignal(false);
  let audioRef: HTMLAudioElement | undefined;
  let progressRef: HTMLDivElement | undefined;

  createEffect(() => {
    const audio = audioRef;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      if (!isDragging()) setCurrentTime(audio.currentTime);
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onVolumeChange = () => setVolume(audio.volume);
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('volumechange', onVolumeChange);
    audio.addEventListener('ended', onEnded);

    onCleanup(() => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('volumechange', onVolumeChange);
      audio.removeEventListener('ended', onEnded);
    });
  });

  const togglePlay = () => {
    const audio = audioRef;
    if (!audio) return;
    if (isPlaying()) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  const seekToRatio = (ratio: number) => {
    const audio = audioRef;
    if (!audio || !Number.isFinite(duration())) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    const newTime = clamped * duration();
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleProgressClick = (e: MouseEvent) => {
    if (!progressRef) return;
    const rect = progressRef.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
  };

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    handleProgressClick(e);

    const onMouseMove = (ev: MouseEvent) => {
      if (!progressRef) return;
      const rect = progressRef.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      seekToRatio(ratio);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Keyboard-operate the custom slider (role="slider"). Arrow keys nudge by
  // 5% of the duration, PageUp/PageDown by 20%, Home/End jump to the ends.
  const handleSliderKeyDown = (e: KeyboardEvent) => {
    const dur = duration();
    if (!Number.isFinite(dur) || dur <= 0) return;
    const step = dur * 0.05;
    const bigStep = dur * 0.2;
    let target: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = currentTime() - step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        target = currentTime() + step;
        break;
      case 'PageDown':
        target = currentTime() - bigStep;
        break;
      case 'PageUp':
        target = currentTime() + bigStep;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = dur;
        break;
      default:
        return;
    }
    e.preventDefault();
    const clamped = Math.max(0, Math.min(dur, target));
    seekToRatio(clamped / dur);
  };

  const handleVolumeChange = (e: Event) => {
    const audio = audioRef;
    if (!audio) return;
    const input = e.currentTarget as HTMLInputElement;
    audio.volume = Number(input.value);
  };

  const progress = createMemo(() => {
    const dur = duration();
    if (!dur) return 0;
    return (currentTime() / dur) * 100;
  });

  return (
    <div class="audio-player" aria-label={props.title || t('audio.audioPlayer')}>
      <audio class="audio-player-media" ref={audioRef} src={props.src} preload="metadata" />
      <button
        type="button"
        class="audio-player-play-btn"
        onClick={togglePlay}
        aria-label={isPlaying() ? t('audio.pause') : t('audio.play')}
      >
        <i class={`bi bi-${isPlaying() ? 'pause-fill' : 'play-fill'}`} />
      </button>
      <div class="audio-player-time">{formatTime(currentTime())}</div>
      <div
        class="audio-player-progress"
        ref={progressRef}
        onMouseDown={handleMouseDown}
        onKeyDown={handleSliderKeyDown}
        role="slider"
        aria-label={t('audio.seek')}
        aria-valuemin={0}
        aria-valuemax={duration()}
        aria-valuenow={currentTime()}
        tabindex={0}
      >
        <div class="audio-player-progress-track">
          <div class="audio-player-progress-fill" style={{ width: `${progress()}%` }} />
        </div>
      </div>
      <div class="audio-player-time">{formatTime(duration())}</div>
      <div class="audio-player-volume">
        <i class={`bi bi-volume-${volume() === 0 ? 'mute-fill' : volume() < 0.5 ? 'down-fill' : 'up-fill'}`} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume()}
          onInput={handleVolumeChange}
          aria-label={t('audio.volume')}
          class="audio-player-volume-slider"
        />
      </div>
    </div>
  );
};
