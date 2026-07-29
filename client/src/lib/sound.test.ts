import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('sound', () => {
  let audioInstances: { src: string; currentTime: number; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[] = [];

  class MockAudio {
    src = '';
    currentTime = 0;
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    constructor(src: string) {
      this.src = src;
      audioInstances.push(this);
    }
  }

  beforeEach(() => {
    audioInstances = [];
    vi.stubGlobal('Audio', MockAudio);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an Audio element and plays it', async () => {
    const { playMessageSound } = await import('./sound.js');
    playMessageSound();
    expect(audioInstances.length).toBe(1);
    expect(audioInstances[0]!.src).toBe('/sounds/message.mp3');
    expect(audioInstances[0]!.currentTime).toBe(0);
    expect(audioInstances[0]!.play).toHaveBeenCalled();
  });

  it('reuses the same Audio element on subsequent plays', async () => {
    const { playMessageSound } = await import('./sound.js');
    playMessageSound();
    playMessageSound();
    expect(audioInstances.length).toBe(1);
    expect(audioInstances[0]!.play).toHaveBeenCalledTimes(2);
  });

  it('handles autoplay rejection gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inst = { src: '', currentTime: 0, play: vi.fn().mockRejectedValue(new Error('Autoplay blocked')), pause: vi.fn() };
    vi.stubGlobal('Audio', vi.fn().mockImplementation(function () { return inst; }));
    vi.resetModules();

    const { playMessageSound } = await import('./sound.js');
    expect(() => playMessageSound()).not.toThrow();
    consoleSpy.mockRestore();
  });
});
