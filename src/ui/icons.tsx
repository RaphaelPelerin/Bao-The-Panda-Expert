const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const MicIcon = () => (
  <svg {...base}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const StopIcon = () => (
  <svg {...base}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const KeyboardIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8" />
  </svg>
);

export const SendIcon = () => (
  <svg {...base}>
    <path d="M5 12h13M13 6l6 6-6 6" />
  </svg>
);

export const LeafIcon = () => (
  <svg {...base} strokeWidth={1.8}>
    <path d="M4 20c2-8 7-13 16-16-1 9-6 14-14 15" />
    <path d="M4 20l7-7" />
  </svg>
);
