/**
 * Side bamboo overlays that sway in a soft wind. Decorative only —
 * pointer-events none so mic / settings stay clickable.
 */
export function BambooFrame() {
  return (
    <div className="bamboo-frame" aria-hidden>
      <img className="bamboo bamboo-left" src="/bamboo.png" alt="" draggable={false} />
      <img className="bamboo bamboo-right" src="/bamboo.png" alt="" draggable={false} />
    </div>
  );
}
