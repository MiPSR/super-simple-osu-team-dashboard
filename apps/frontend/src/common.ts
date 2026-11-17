/** Shared browser utilities: bootstrap data, formatting, colors, SSE (spec 6.x, 7.x). */

export interface PublicTeam {
  id: number | null;
  name: string;
  shortName: string;
  flagUrl: string | null;
  defaultMode: string;
  syncedAt: string | null;
}

export interface Bootstrap {
  team: PublicTeam;
  modes: Array<{ id: string; label: string }>;
  metrics: string[];
  periods: string[];
  sorts: string[];
}

export function readBootstrap(): Bootstrap {
  const el = document.getElementById("bootstrap");
  if (!el || !el.textContent) throw new Error("missing bootstrap data");
  return JSON.parse(el.textContent) as Bootstrap;
}

export function jsonFetch<T>(url: string): Promise<T> {
  return fetch(url, { headers: { Accept: "application/json" } }).then((r) => {
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.json() as Promise<T>;
  });
}

/** Keep last successfully rendered data on network errors (6.6). */
export function connectEvents(onData: (kind: string | null) => void): { indicator: HTMLElement | null } {
  const indicator = document.getElementById("connection");
  const text = document.getElementById("connection-text");
  const source = new EventSource("/api/events");
  source.addEventListener("data-changed", (event) => {
    if (indicator) indicator.hidden = true;
    const payload = JSON.parse((event as MessageEvent<string>).data) as { kind: string | null };
    onData(payload.kind);
  });
  source.onerror = () => {
    // EventSource reconnects automatically; surface an unobtrusive indicator.
    if (indicator) indicator.hidden = false;
    if (text) text.textContent = "Reconnecting…";
  };
  source.onopen = () => {
    if (indicator) indicator.hidden = true;
  };
  return { indicator };
}

const numberFormat = new Intl.NumberFormat("en");
const percentFormat = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 });

/** Big integers arrive as decimal strings; format with grouping either way. */
export function formatMetric(value: number | string | null, kind: string): string {
  if (value === null) return "—";
  if (kind === "percent") return percentFormat.format(Number(value));
  if (kind === "duration") return formatDuration(Number(value));
  return numberFormat.format(Number(value));
}

export function formatDuration(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  if (m > 0) return `${m} m`;
  return `${seconds} s`;
}

/** Change values: rank-based metrics invert the positive/negative meaning (5.9). */
export function formatChange(value: number | string | null, ascending: boolean): { text: string; className: string } {
  if (value === null) return { text: "—", className: "change" };
  const n = Number(value);
  if (n === 0) return { text: "±0", className: "change" };
  const positive = ascending ? n < 0 : n > 0;
  return {
    text: `${n > 0 ? "+" : "−"}${numberFormat.format(Math.abs(n))}`,
    className: `change ${positive ? "positive" : "negative"}`,
  };
}

export function formatRelativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * OKLCH player colors: evenly distributed hues across the roster with
 * consistent chroma/lightness within each theme (7.3).
 */
export function playerColor(index: number, total: number): string {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const lightness = dark ? 0.75 : 0.55;
  const chroma = 0.14;
  const hue = (index * 360) / Math.max(1, total);
  return `oklch(${lightness} ${chroma} ${hue})`;
}

export function queryState(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function updateQuery(mutate: (params: URLSearchParams) => void): void {
  const params = queryState();
  mutate(params);
  const qs = params.toString();
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

export function setPressed(buttons: NodeListOf<Element> | Element[], active: Element): void {
  for (const b of buttons) b.setAttribute("aria-pressed", String(b === active));
}

/** Header: team identity left, pages centered, mode selector right (5.1). */
export function renderHeader(bootstrap: Bootstrap): { mode: string; setMode(mode: string): void } {
  const team = bootstrap.team;
  const name = document.getElementById("team-name");
  const logo = document.getElementById("team-logo") as HTMLImageElement | null;
  if (name && team.name) name.textContent = team.name;
  if (logo && team.flagUrl) {
    logo.src = team.flagUrl;
    logo.hidden = false;
    logo.alt = `${team.name} logo`;
  }
  const github = document.getElementById("footer-github");
  if (github) github.setAttribute("href", "https://github.com/");

  const container = document.getElementById("mode-selector");
  const initial = new URLSearchParams(window.location.search).get("mode") ?? team.defaultMode ?? "osu";
  let mode = bootstrap.modes.some((m) => m.id === initial) ? initial : team.defaultMode ?? "osu";

  const apply = () => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  };
  const setMode = (next: string) => {
    mode = next;
    apply();
    updateQuery((p) => p.set("mode", next));
  };

  const buttons: HTMLButtonElement[] = [];
  for (const m of bootstrap.modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    button.textContent = m.label;
    button.dataset.mode = m.id;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => setMode(m.id));
    buttons.push(button);
    container?.appendChild(button);
  }
  apply();
  return {
    get mode() { return mode; },
    setMode,
  };
}
