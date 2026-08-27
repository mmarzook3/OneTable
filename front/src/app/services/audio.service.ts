import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  private audioContext: AudioContext | null = null;
  private enabled = true;

  constructor() {
    // Initialize AudioContext (required for Web Audio API)
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported, audio notifications disabled');
    }
  }

  /** Prime/resume Web Audio. Safe to call repeatedly, including from WebView. */
  prepare(): void {
    const context = this.getOrCreateContext();
    if (context?.state === 'suspended') {
      void context.resume().catch(() => {});
    }
  }

  private getOrCreateContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext;
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      this.audioContext = null;
    }
    return this.audioContext;
  }

  private withReadyContext(play: (context: AudioContext) => void): void {
    if (!this.enabled) return;
    const context = this.getOrCreateContext();
    if (!context) return;
    if (context.state === 'suspended') {
      void context.resume().then(() => play(context)).catch(() => {});
      return;
    }
    play(context);
  }

  private scheduleTone(
    context: AudioContext,
    frequency: number,
    startAt: number,
    durationSeconds: number,
    volume: number,
    type: OscillatorType = 'sine',
  ): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.type = type;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSeconds + 0.02);
  }

  /**
   * Play a short ping sound notification
   * @param frequency - Frequency in Hz (default: 800)
   * @param duration - Duration in milliseconds (default: 100)
   */
  playPing(frequency: number = 800, duration: number = 100): void {
    this.withReadyContext((context) => {
      this.scheduleTone(context, frequency, context.currentTime, duration / 1000, 0.32);
    });
  }

  /**
   * Play a notification for order changes (slightly different tone)
   * @deprecated Use playRestaurantOrderChange() or playCustomerOrderChange() instead
   */
  playOrderChange(): void {
    this.playPing(600, 150);
  }

  /**
   * Play a notification for status changes (higher tone)
   * @deprecated Use playRestaurantStatusChange() or playCustomerStatusChange() instead
   */
  playStatusChange(): void {
    this.playPing(1000, 120);
  }

  /**
   * Play a notification for restaurant backend - new order or order changes
   * Uses a lower, more urgent double beep (like a kitchen bell)
   */
  playRestaurantOrderChange(): void {
    this.playKitchenNewOrderAlert();
  }

  /** A clear two-round restaurant bell that cuts through normal Kitchen noise. */
  playKitchenNewOrderAlert(): void {
    this.withReadyContext((context) => {
      const start = context.currentTime + 0.02;
      for (const roundOffset of [0, 0.72]) {
        [784, 1047, 1319].forEach((frequency, index) => {
          const at = start + roundOffset + index * 0.14;
          this.scheduleTone(context, frequency, at, 0.38, 0.52, 'triangle');
          this.scheduleTone(context, frequency * 2, at, 0.22, 0.11, 'sine');
        });
      }
    });
  }

  /**
   * Play a notification for restaurant backend - status changes
   * Uses a medium tone single beep
   */
  playRestaurantStatusChange(): void {
    this.playKitchenStatusConfirmed();
  }

  /** Short positive confirmation used after a Kitchen status update succeeds. */
  playKitchenStatusConfirmed(): void {
    this.withReadyContext((context) => {
      const start = context.currentTime + 0.01;
      this.scheduleTone(context, 659, start, 0.24, 0.34, 'triangle');
      this.scheduleTone(context, 988, start + 0.15, 0.34, 0.4, 'triangle');
    });
  }

  /**
   * Play a notification for customer frontend - order changes
   * Uses a higher, gentler single chime
   */
  playCustomerOrderChange(): void {
    this.playPing(800, 180);
  }

  /**
   * Play a notification for customer frontend - status changes
   * Uses a pleasant higher tone chime
   */
  playCustomerStatusChange(): void {
    this.playPing(1000, 150);
  }

  /**
   * Play an urgent alert sound for assigned waiter notifications.
   * Triple beep at higher volume for attention.
   */
  playUrgentWaiterAlert(): void {
    if (!this.enabled || !this.audioContext) return;
    try {
      const ctx = this.audioContext;
      const now = ctx.currentTime;
      // Triple ascending beep
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800 + i * 200;
        osc.type = 'square';
        gain.gain.setValueAtTime(0.3, now + i * 0.2);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.2 + 0.18);
        osc.start(now + i * 0.2);
        osc.stop(now + i * 0.2 + 0.2);
      }
    } catch (e) {
      console.warn('Failed to play urgent alert:', e);
    }
  }

  /**
   * Enable or disable audio notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.prepare();
  }

  /**
   * Check if audio is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
