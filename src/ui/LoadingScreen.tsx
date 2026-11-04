import { useEffect, useState, useSyncExternalStore } from "react";
import { loading } from "../loading";
import { LeafIcon } from "./icons";

/** With no progress for this long, let the visitor in: whatever is missing keeps loading behind the page. */
const STALL_MS = 20_000;
/** Matches the fade-out of .loading in styles.css. */
const FADE_MS = 600;

function preloadImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  return image.decode();
}

/** Covers the app until everything has loaded, so the first thing seen already works. */
export function LoadingScreen({ label, hint }: { label: string; hint: string }) {
  const progress = useSyncExternalStore(loading.subscribe, () => loading.progress);
  const [stalled, setStalled] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    loading.track("background", preloadImage("/background.png"));
    loading.track("bamboo", preloadImage("/bamboo.png"));
    loading.track("fonts", document.fonts.ready);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [progress]);

  const finished = progress >= 1 || stalled;
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [finished]);

  if (gone) return null;
  const percent = Math.round(progress * 100);
  return (
    <div className="loading" data-finished={finished}>
      <span className="loading-mark">
        <LeafIcon />
      </span>
      <h2>Bao</h2>
      <p>{label}</p>
      <div className="loading-bar" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ transform: `scaleX(${progress})` }} />
      </div>
      <p className="loading-percent">{percent}%</p>
      <p className="loading-hint">{hint}</p>
    </div>
  );
}
