/**
 * Background player — singleton audio-only player for pinned live streams.
 *
 * Lets the user keep listening to a live stream (podcast / radio with a
 * static image) while browsing NoorNote. One stream at a time: pinning
 * another replaces the current one. Owned by the addon runtime — the audio
 * element lives outside the DOM and survives route changes; destroy()
 * (logout / account switch / addon off) fully tears it down.
 *
 * Persistence: the pinned stream's metadata survives reloads — the widget
 * then shows PAUSED (browsers block autoplay without a user gesture; the
 * first play click is that gesture).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { TypedEventBus } from '../../core/TypedEventBus';

export interface PinnedStream {
  naddr: string;
  title: string;
  /** HLS/streaming URL from the `streaming` tag */
  streaming: string;
  /** Cover art / static image (poster), may be empty */
  image: string;
}

export interface BackgroundPlayerState {
  pinned: PinnedStream | null;
  playing: boolean;
}

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegURL',
];

export class BackgroundPlayer {
  private audio: HTMLAudioElement | null = null;
  private hls: { destroy(): void } | null = null;
  private pinned: PinnedStream | null = null;
  private playing = false;

  constructor() {
    /* state is restored by restore() — called from the runtime's init,
     * i.e. after login when PerAccountLocalStorage has the current pubkey. */
  }

  /**
   * Restore the pinned stream's metadata (paused) for the current account.
   * Called on runtime init — after login, so the per-account pin is readable.
   */
  public restore(): void {
    this.stopPlayback();
    this.pinned = null;
    this.playing = false;
    try {
      const raw = PerAccountLocalStorage.getInstance().get<string | null>(
        StorageKeys.LIVE_STREAMS_PINNED,
        null
      );
      if (!raw) return;
      this.pinned = JSON.parse(raw) as PinnedStream;
      this.playing = false;
    } catch {
      this.pinned = null;
    }
    this.emit();
  }

  /** Pin a stream and start playing immediately (must run in a click handler). */
  public async pin(stream: PinnedStream): Promise<void> {
    const sameStream = this.pinned?.naddr === stream.naddr;
    this.stopPlayback();

    this.pinned = stream;
    this.playing = false;
    this.persist();

    if (!sameStream || !this.audio) {
      await this.attach(stream);
    }
    await this.resume();
  }

  public async resume(): Promise<void> {
    if (!this.pinned || !this.audio) return;
    try {
      await this.audio.play();
      this.playing = true;
    } catch {
      // Autoplay rejected or media error — stay paused; the widget keeps
      // showing the play button so the user can retry.
      this.playing = false;
    }
    this.emit();
  }

  public pause(): void {
    if (!this.audio) return;
    this.audio.pause();
    this.playing = false;
    this.persist();
    this.emit();
  }

  public toggle(): void {
    if (this.playing) this.pause();
    else void this.resume();
  }

  /** Unpin: stop playback and clear the persisted pin. */
  public stop(): void {
    this.stopPlayback();
    this.pinned = null;
    this.playing = false;
    PerAccountLocalStorage.getInstance().remove(
      StorageKeys.LIVE_STREAMS_PINNED
    );
    this.emit();
  }

  public getState(): BackgroundPlayerState {
    return { pinned: this.pinned, playing: this.playing };
  }

  public isPinned(naddr: string): boolean {
    return this.pinned?.naddr === naddr;
  }

  /** Extract pin data from a kind 30311 event (undefined when no HLS URL). */
  public static fromEvent(
    event: NostrEvent,
    naddr: string
  ): PinnedStream | undefined {
    const getTag = (name: string) =>
      event.tags.find(t => t[0] === name)?.[1] || '';
    const streaming = getTag('streaming');
    if (!streaming) return undefined;
    return {
      naddr,
      title: getTag('title'),
      streaming,
      image: getTag('image'),
    };
  }

  private persist(): void {
    if (!this.pinned) return;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.LIVE_STREAMS_PINNED,
      JSON.stringify(this.pinned)
    );
  }

  private stopPlayback(): void {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        /* ignore */
      }
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.audio = null;
  }

  /** Create the audio element and connect it to the stream URL. */
  private async attach(stream: PinnedStream): Promise<void> {
    const audio = document.createElement('audio');
    audio.preload = 'none';

    const isHls = stream.streaming.includes('.m3u8');
    const nativeHls = HLS_CONTENT_TYPES.some(t => audio.canPlayType(t));

    if (!isHls || nativeHls) {
      audio.src = stream.streaming;
      this.audio = audio;
      return;
    }

    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) {
      // Last resort: try native src anyway
      audio.src = stream.streaming;
      this.audio = audio;
      return;
    }

    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(stream.streaming);
    hls.attachMedia(audio);
    this.audio = audio;
    this.hls = hls;
  }

  private emit(): void {
    TypedEventBus.getInstance().emit('live-streams:background-player', {
      pinned: !!this.pinned,
    });
  }

  /** Addon teardown: kill playback + in-memory state. The persisted pin
   * stays — it belongs to the account and is restored on next init. */
  public destroy(): void {
    this.stopPlayback();
    this.pinned = null;
    this.playing = false;
  }
}

export const backgroundPlayer = new BackgroundPlayer();
