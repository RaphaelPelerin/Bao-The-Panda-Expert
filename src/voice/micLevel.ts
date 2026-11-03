import { signals } from "../avatar/signals";

/**
 * Measures microphone loudness while the user talks, so the scene can react to
 * their voice. Runs alongside speech recognition, which opens its own stream.
 */
export class MicLevel {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private frame = 0;
  private session = 0;

  async start(): Promise<void> {
    this.stop();
    const session = this.session;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return;
    }
    if (session !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.min(1, Math.max(0, (Math.log10(rms + 1e-4) + 2.2) / 1.5));
      signals.micLevel += (level - signals.micLevel) * (level > signals.micLevel ? 0.5 : 0.12);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.session++;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    signals.micLevel = 0;
  }
}
