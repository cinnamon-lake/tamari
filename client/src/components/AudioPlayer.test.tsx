import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { AudioPlayer } from './AudioPlayer.js';

describe('AudioPlayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders play button and time displays', () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    expect(screen.getByLabelText('Play')).toBeInTheDocument();
    expect(screen.getAllByText('0:00')).toHaveLength(2);
  });

  it('toggles play/pause when button is clicked', async () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    const playSpy = vi.spyOn(audio, 'play').mockImplementation(() => Promise.resolve());
    const pauseSpy = vi.spyOn(audio, 'pause').mockImplementation(() => {});

    const btn = screen.getByLabelText('Play');
    btn.click();
    expect(playSpy).toHaveBeenCalled();

    audio.dispatchEvent(new Event('play'));
    expect(screen.getByLabelText('Pause')).toBeInTheDocument();

    btn.click();
    expect(pauseSpy).toHaveBeenCalled();

    audio.dispatchEvent(new Event('pause'));
    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('updates current time display on timeupdate', () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    audio.currentTime = 45;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(screen.getByText('0:45')).toBeInTheDocument();
  });

  it('updates duration display when metadata is loaded', () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { value: 185, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(screen.getByText('3:05')).toBeInTheDocument();
  });

  it('changes volume via slider', () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    const slider = screen.getByLabelText('Volume');
    fireEvent.input(slider, { target: { value: '0.5' } });

    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio.volume).toBe(0.5);
  });

  it('seeks when progress bar is clicked', () => {
    render(() => <AudioPlayer src="/audio/test.mp3" />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata'));

    const progress = document.querySelector('.audio-player-progress') as HTMLDivElement;
    const rect = { left: 0, width: 200 } as DOMRect;
    vi.spyOn(progress, 'getBoundingClientRect').mockReturnValue(rect);

    progress.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(audio.currentTime).toBe(50);
  });
});
