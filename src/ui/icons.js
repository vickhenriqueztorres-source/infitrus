const PATHS = Object.freeze({
  pulse: '<path d="M2 12h4l2.1-7 3.2 14 2.8-10 2.1 6H22"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3v-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  minus: '<path d="M5 12h14"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8 8 0 0 1 0 12"/>',
  volumeOff: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 5M21 9l-5 5"/>',
  document: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  bars: '<path d="M5 20v-6M10 20V8M15 20V4M20 20v-9"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
});

export function icon(name, size = 18, className = "") {
  const body = PATHS[name] || PATHS.circle;
  return `<svg class="ifx-icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function logoMarkup({ compact = false } = {}) {
  return `<span class="ifx-logo${compact ? " is-compact" : ""}">${icon("pulse", compact ? 24 : 30, "ifx-logo-mark")}<span class="ifx-wordmark"><strong>INFLITRUS</strong><small>SIGNALS</small></span></span>`;
}
