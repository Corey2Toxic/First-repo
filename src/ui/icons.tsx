/**
 * Line icons (24×24, stroke-based) drawn for Fireweed.
 */
import type { JSX } from 'preact';

const P = (props: { children: JSX.Element | JSX.Element[]; size?: number }) => (
  <svg viewBox="0 0 24 24" width={props.size ?? 22} height={props.size ?? 22} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    {props.children}
  </svg>
);

export const Icons: Record<string, (p?: { size?: number }) => JSX.Element> = {
  inspect: (p) => (
    <P size={p?.size}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </P>
  ),
  zone: (p) => (
    <P size={p?.size}>
      <path d="M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2z" />
      <path d="M9 3v16M15 5v16" />
    </P>
  ),
  thin: (p) => (
    <P size={p?.size}>
      <path d="M7 21V9M7 9l-3 4h6zM7 5l-2.5 4h5z" />
      <path d="M15 20l5-11M14 13l7 3" />
    </P>
  ),
  burn: (p) => (
    <P size={p?.size}>
      <path d="M12 21c-4 0-6-2.6-6-6 0-3 2-4.5 3-7 1.2 2 2.5 2.6 3 1 .6-2-.5-4.5 1-6 1 3 5 5.5 5 11 0 4-2.8 7-6 7z" />
    </P>
  ),
  plant: (p) => (
    <P size={p?.size}>
      <path d="M12 21v-8" />
      <path d="M12 13c-4 0-6-3-6-6 3 0 6 2 6 6zM12 11c0-4 3-6 6-6 0 3-2 6-6 6z" />
      <path d="M7 21h10" />
    </P>
  ),
  fuelbreak: (p) => (
    <P size={p?.size}>
      <path d="M5 20V8l-2 3h4zM19 20V8l-2 3h4z" />
      <path d="M10 4v16M14 4v16" stroke-dasharray="2 2.5" />
    </P>
  ),
  fireline: (p) => (
    <P size={p?.size}>
      <path d="M4 20l7-7M9 11l4 4M13 7l4 4M11 9l6-6" />
      <path d="M3 21h8" />
    </P>
  ),
  airdrop: (p) => (
    <P size={p?.size}>
      <path d="M3 8h13l3-3h2l-2 4 2 1h-5l-4 3H9l2-3H3z" />
      <path d="M7 15v1M10 17v1M13 15v1M16 17v1" />
    </P>
  ),
  road: (p) => (
    <P size={p?.size}>
      <path d="M8 21L11 3M16 21L13 3" />
      <path d="M12 7v2M12 12v2M12 17v2" />
    </P>
  ),
  tower: (p) => (
    <P size={p?.size}>
      <path d="M8 21l3-12M16 21l-3-12M9 16h6" />
      <path d="M7 9h10l-1-4H8z" />
    </P>
  ),
  camp: (p) => (
    <P size={p?.size}>
      <path d="M3 20L12 5l9 15z" />
      <path d="M12 12l-3 8M12 12l3 8" />
    </P>
  ),
  wolves: (p) => (
    <P size={p?.size}>
      <path d="M5 9l2-5 3 4h4l3-4 2 5-2 3 1 4-6 5-6-5 1-4z" />
      <path d="M10 13h.01M14 13h.01" />
    </P>
  ),
  beavers: (p) => (
    <P size={p?.size}>
      <path d="M3 17c3-6 15-6 18 0z" />
      <path d="M7 17v-2M11 17v-3M15 17v-2" />
    </P>
  ),
  play: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M8 5l11 7-11 7z" fill="currentColor" />
    </P>
  ),
  pause: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M8 5v14M16 5v14" stroke-width="3" />
    </P>
  ),
  fire: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M12 21c-4 0-6-2.6-6-6 0-3 2-4.5 3-7 1.2 2 2.5 2.6 3 1 .6-2-.5-4.5 1-6 1 3 5 5.5 5 11 0 4-2.8 7-6 7z" />
    </P>
  ),
  crew: (p) => (
    <P size={p?.size ?? 16}>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21c0-4 3-7 6-7s6 3 6 7" />
      <path d="M17 11l4-4M19 6l2 2" />
    </P>
  ),
  project: (p) => (
    <P size={p?.size ?? 16}>
      <rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2" />
      <path d="M8 12l3 3 5-6" />
    </P>
  ),
  policy: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </P>
  ),
  council: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
    </P>
  ),
  ledger: (p) => (
    <P size={p?.size ?? 16}>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5c-.5-1-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2 0 2.8 5.2 1.5 5.2 4.2 0 1.2-1.1 1.9-2.7 1.9-1.2 0-2.2-.6-2.7-1.6M12 6.5V8M12 16v1.5" />
    </P>
  ),
  chart: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M4 20V4M4 20h16" />
      <path d="M7 15l4-5 3 3 5-6" />
    </P>
  ),
  book: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z" />
      <path d="M5 17a3 3 0 013-3h11" />
    </P>
  ),
  leaf: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15z" />
      <path d="M5 19l8-8" />
    </P>
  ),
  help: (p) => (
    <P size={p?.size ?? 16}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 015 .5c0 2-2.5 2-2.5 4M12 17h.01" />
    </P>
  ),
  menu: (p) => (
    <P size={p?.size ?? 16}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </P>
  ),
  target: (p) => (
    <P size={p?.size ?? 16}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
    </P>
  ),
};
