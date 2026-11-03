import * as THREE from "three";

/** Frames are captured this close to the end, so the held frame is the clip's last one. */
const CAPTURE_WINDOW_SECONDS = 0.3;

/**
 * Loops an avatar clip with no visible seam, using a single <video> on the
 * browser's native loop (no seeking during playback, no second player whose
 * texture could be empty or stale).
 *
 * AI-generated clips rarely end on exactly their first frame, and this one
 * starts with a few frames in a brighter color grade. So just before the clip
 * ends, its last frame is copied into a "held" texture; when the video wraps,
 * the held frame covers the first `loopStart` seconds, then fades into the live
 * video. The bright opening frames are never shown.
 */
export class VideoLoop {
  private readonly video: HTMLVideoElement;
  private readonly live: THREE.VideoTexture;
  private readonly held: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private lastTime = 0;
  /** True from a wrap until the held frame has faded out. */
  private covering = false;
  /** Resolves once the first frame is ready; rejects if the clip cannot load. */
  readonly loaded: Promise<void>;

  constructor(
    url: string,
    private readonly loopStart: number,
    private readonly fadeSeconds = 0.15,
  ) {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = true;
    this.video = video;

    this.live = new THREE.VideoTexture(video);
    this.live.colorSpace = THREE.SRGBColorSpace;

    this.canvas = document.createElement("canvas");
    this.held = new THREE.CanvasTexture(this.canvas);
    // three.js always uploads video frames without the sRGB decode (forceLinearTransfer),
    // so the held frame must skip it too, or it shows darker than the video.
    this.held.colorSpace = THREE.NoColorSpace;
    // Sample exactly like the video texture (no mipmaps), or the held frame looks softer.
    this.held.generateMipmaps = false;
    this.held.minFilter = THREE.LinearFilter;
    this.held.magFilter = THREE.LinearFilter;

    this.loaded = new Promise<void>((resolve, reject) => {
      video.addEventListener("error", () => reject(new Error(`Could not load ${url}`)), { once: true });
      video.addEventListener(
        "loadedmetadata",
        () => {
          // Full resolution, so the held frame is indistinguishable from the video.
          this.canvas.width = video.videoWidth;
          this.canvas.height = video.videoHeight;
          video.currentTime = loopStart;
        },
        { once: true },
      );
      video.addEventListener(
        "seeked",
        () => {
          // Upload the starting frame now: three.js only does so once playback presents frames.
          this.live.needsUpdate = true;
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

  /** Call every frame. Returns the live texture, the held frame, and how much of the held frame to show. */
  update(): { from: THREE.Texture; to: THREE.Texture; mix: number } {
    const video = this.video;
    const time = video.currentTime;
    const duration = video.duration;

    // Keep copying frames near the end: the last copy before the wrap is the clip's last frame.
    if (Number.isFinite(duration) && time >= duration - CAPTURE_WINDOW_SECONDS && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.canvas.getContext("2d")!.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      this.held.needsUpdate = true;
    }

    // The native loop jumped back to the start: cover the opening frames.
    if (time < this.lastTime && this.held.version > 0) this.covering = true;
    this.lastTime = time;

    let mix = 0;
    if (this.covering) {
      if (time <= this.loopStart) mix = 1;
      else if (time < this.loopStart + this.fadeSeconds) mix = 1 - (time - this.loopStart) / this.fadeSeconds;
      else this.covering = false;
    }
    return { from: this.live, to: this.held, mix };
  }

  dispose(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.live.dispose();
    this.held.dispose();
  }
}
