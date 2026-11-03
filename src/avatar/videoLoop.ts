import * as THREE from "three";

/**
 * Loops an avatar clip with no visible seam. Two <video> elements play the
 * same file in turn: shortly before one reaches the end, the other starts at
 * `loopStart` and the shader cross-fades between their textures. AI-generated
 * clips rarely end on exactly their first frame, so a short fade hides the jump.
 */
export class VideoLoop {
  private readonly videos: [HTMLVideoElement, HTMLVideoElement];
  private readonly textures: [THREE.VideoTexture, THREE.VideoTexture];
  private current = 0;
  private fading = false;
  /** Resolves once both players hold the loop's first frame; rejects if the clip cannot load. */
  readonly loaded: Promise<void>;

  constructor(
    url: string,
    private readonly loopStart: number,
    private readonly fadeSeconds = 0.15,
  ) {
    const make = () => {
      const video = document.createElement("video");
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.loop = false;
      return video;
    };
    const videos: [HTMLVideoElement, HTMLVideoElement] = [make(), make()];
    this.videos = videos;
    this.textures = videos.map((video) => {
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }) as [THREE.VideoTexture, THREE.VideoTexture];

    this.loaded = Promise.all(videos.map((video) => seek(video, loopStart))).then(() => undefined);
  }

  /**
   * Starts playback. Rejects with NotAllowedError when the browser blocks
   * autoplay until the user interacts with the page.
   */
  async start(): Promise<void> {
    await this.loaded;
    await this.videos[this.current].play();
  }

  /** Call every frame. Returns the textures to blend and how far the blend has gone. */
  update(): { from: THREE.Texture; to: THREE.Texture; mix: number } {
    const active = this.videos[this.current];
    const next = this.videos[1 - this.current];
    const end = active.duration;
    let mix = 0;

    if (Number.isFinite(end)) {
      if (!this.fading && active.currentTime >= end - this.fadeSeconds) {
        this.fading = true;
        void next.play();
      }
      if (this.fading) {
        mix = Math.min(1, Math.max(0, (active.currentTime - (end - this.fadeSeconds)) / this.fadeSeconds));
        if (active.ended || mix >= 1) {
          // The other clip takes over; rewind this one so it is ready for the next turn.
          active.pause();
          void seek(active, this.loopStart);
          this.current = 1 - this.current;
          this.fading = false;
          mix = 0;
        }
      }
    }
    return { from: this.textures[this.current], to: this.textures[1 - this.current], mix };
  }

  dispose(): void {
    for (const video of this.videos) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const texture of this.textures) texture.dispose();
  }
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => reject(new Error(`Could not load ${video.src}`));
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      video.currentTime = time;
    } else {
      video.addEventListener("loadedmetadata", () => (video.currentTime = time), { once: true });
    }
  });
}
