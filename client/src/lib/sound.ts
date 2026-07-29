let audio: HTMLAudioElement | null = null;

export function playMessageSound(): void {
  if (!audio) {
    audio = new Audio('/sounds/message.mp3');
  }
  audio.currentTime = 0;
  audio.play().catch(() => {
    // Autoplay policy may block; ignore
  });
}
