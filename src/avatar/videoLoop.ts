import * as THREE from "three";

/**
 * Loops an avatar clip on a single <video> with the browser's native loop.
 *
 * The clip file itself is the seamless loop: its last frame flows into its
 * first, so playback never seeks, freezes or blends at the wrap.
 */
export class VideoLoop {
  private readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  /** Resolves once the first frame is ready; rejects if the clip cannot load. */
  readonly loaded: Promise<void>;
  /** Media time of the last presented frame; null where requestVideoFrameCallback is missing. */
  private presentedTime: number | null = null;
  private frameCallback = 0;

  constructor(url: string) {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = true;
    this.video = video;

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    if ("requestVideoFrameCallback" in video) {
      const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        this.presentedTime = metadata.mediaTime;
        this.frameCallback = video.requestVideoFrameCallback(onFrame);
      };
      this.frameCallback = video.requestVideoFrameCallback(onFrame);
    }

    this.loaded = new Promise<void>((resolve, reject) => {
      video.addEventListener("error", () => reject(new Error(`Could not load ${url}`)), { once: true });
      video.addEventListener(
        "loadeddata",
        () => {
          // Upload the first frame now: three.js only does so once playback presents frames.
          this.texture.needsUpdate = true;
          resolve();
        },
        { once: true },
      );
    });
  }

  /**
   * Starts playback. Rejects with NotAllowedError when the browser blocks
   * autoplay until the user interacts with the page.
   */
  async start(): Promise<void> {
    await this.loaded;
    await this.video.play();
  }

  /**
   * Jumps to `seconds` and keeps playing. Only for a loop that is hidden: the
   * texture shows a stale frame until the new one is presented.
   */
  seek(seconds: number): void {
    this.video.currentTime = seconds;
  }

  /** Media time of the frame on screen, in seconds: what the texture shows, not where the decoder is. */
  get mediaTime(): number {
    return this.presentedTime ?? this.video.currentTime;
  }

  dispose(): void {
    if (this.frameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.texture.dispose();
  }
}
