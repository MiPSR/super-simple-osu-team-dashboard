import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import {
  readBootstrap,
  renderHeader,
  jsonFetch,
  connectEvents,
  formatMetric,
  formatChange,
  formatAbsoluteTime,
  playerColor,
  queryState,
  updateQuery,
  setPressed,
} from "./common.ts";

/** Leaderboards page (spec 5.3 – 5.9): metric selector, Chart.js line graph, ranked entries. */

interface LeaderboardResponse {
  metric: { key: string; label: string; unit: string; kind: string; ascending: boolean };
  mode: string;
  period: string;
  collectedAt: string | null;
  labels: string[];
  series: Array<{ userId: number; username: string; values: Array<number | string | null> }>;
  ranking: Array<{
    userId: number;
    username: string;
    avatarUrl: string | null;
    value: number | string | null;
    rank: number | null;
    change23h: number | string | null;
    change7d: number | string | null;
  }>;
}

const bootstrap = readBootstrap();
const header = renderHeader(bootstrap);

let metric = queryState().get("metric") ?? "pp";
if (!bootstrap.metrics.includes(metric)) metric = "pp";
let period = queryState().get("period") ?? "24h";
if (!bootstrap.periods.includes(period)) period = "24h";

let chart: Chart | null = null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildSelector(): void {
  const metricContainer = document.getElementById("metric-selector");
  const metricButtons: HTMLButtonElement[] = [];
  for (const key of bootstrap.metrics) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "metric-button";
    b.textContent = key === "pp" ? "PP" : key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    b.dataset.metric = key;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      metric = key;
      setPressed(metricButtons, b);
      updateQuery((p) => p.set("metric", key));
      void refresh().catch(() => undefined);
    });
    metricButtons.push(b);
    metricContainer?.appendChild(b);
  }
  const activeMetric = metricButtons.find((b) => b.dataset.metric === metric);
  if (activeMetric) setPressed(metricButtons, activeMetric);

  const timelineContainer = document.getElementById("timeline-selector");
  const timelineButtons: HTMLButtonElement[] = [];
  for (const option of [{ id: "24h", label: "24 hours" }, { id: "7d", label: "7 days" }]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "timeline-button";
    b.textContent = option.label;
    b.dataset.period = option.id;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      period = option.id;
      setPressed(timelineButtons, b);
      updateQuery((p) => p.set("period", option.id));
      void refresh().catch(() => undefined);
    });
    timelineButtons.push(b);
    timelineContainer?.appendChild(b);
  }
  const activeTimeline = timelineButtons.find((b) => b.dataset.period === period);
  if (activeTimeline) setPressed(timelineButtons, activeTimeline);
}

async function refresh(): Promise<void> {
  const data = await jsonFetch<LeaderboardResponse>(
    `/api/leaderboards?mode=${encodeURIComponent(header.mode)}&metric=${encodeURIComponent(metric)}&period=${encodeURIComponent(period)}`,
  );
  render(data);
}

function render(data: LeaderboardResponse): void {
  const timeEl = document.getElementById("collection-time");
  if (timeEl) {
    timeEl.textContent = data.collectedAt
      ? `Collected ${formatAbsoluteTime(data.collectedAt)}`
      : "No collection published yet — graphs fill as hourly collections accumulate.";
  }
  renderChart(data);
  renderRanking(data);
  renderAccessibleTable(data);
}

function chartLabel(iso: string): string {
  // Hourly axis: "MM-DD HH:MM"; daily axis: full date.
  return period === "7d" ? iso.slice(0, 10) : iso.slice(5, 16).replace("T", " ");
}

function renderChart(data: LeaderboardResponse): void {
  const canvas = document.getElementById("chart") as HTMLCanvasElement | null;
  if (!canvas) return;
  const total = Math.max(1, data.series.length);
  const separator = getComputedStyle(document.documentElement).getPropertyValue("--separator").trim() || "rgba(128,128,128,0.3)";
  const datasets = data.series.map((series, i) => ({
    label: series.username,
    data: series.values.map((v) => (v === null ? null : Number(v))),
    borderColor: playerColor(i, total),
    pointBackgroundColor: playerColor(i, total),
    borderWidth: 1.5,
    pointRadius: 2.5,
    pointHitRadius: 8,
    tension: 0,
    spanGaps: false, // missing observations remain gaps (5.7)
    fill: false,
  }));

  const config: ChartConfiguration<"line"> = {
    type: "line",
    data: { labels: data.labels.map(chartLabel), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion ? false : { duration: 200 },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 2 } },
        tooltip: {
          callbacks: {
            label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              `${ctx.dataset.label ?? ""}: ${ctx.parsed.y === null ? "—" : formatMetric(String(ctx.parsed.y), data.metric.kind)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
        y: { grid: { color: separator } },
      },
    },
  };

  if (chart) {
    chart.data = config.data;
    chart.options = config.options as typeof chart.options;
    chart.update(reducedMotion ? "none" : undefined);
  } else {
    chart = new Chart(canvas, config);
  }
}

function renderRanking(data: LeaderboardResponse): void {
  const body = document.getElementById("ranking-body") as HTMLTableSectionElement | null;
  if (!body) return;
  body.textContent = "";
  for (const entry of data.ranking) {
    const tr = body.insertRow();

    const tdRank = tr.insertCell();
    tdRank.className = "num";
    tdRank.textContent = entry.rank === null ? "—" : String(entry.rank);

    const tdPlayer = tr.insertCell();
    const wrap = document.createElement("span");
    wrap.className = "player-cell";
    if (entry.avatarUrl) {
      const img = document.createElement("img");
      img.src = entry.avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      wrap.appendChild(img);
    }
    wrap.appendChild(document.createTextNode(entry.username));
    tdPlayer.appendChild(wrap);

    const tdValue = tr.insertCell();
    tdValue.className = "num";
    tdValue.textContent = formatMetric(entry.value, data.metric.kind);

    const td23 = tr.insertCell();
    td23.className = `num ${formatChange(entry.change23h, data.metric.ascending).className}`;
    td23.textContent = formatChange(entry.change23h, data.metric.ascending).text;

    const td7d = tr.insertCell();
    td7d.className = `num ${formatChange(entry.change7d, data.metric.ascending).className}`;
    td7d.textContent = formatChange(entry.change7d, data.metric.ascending).text;
  }
}

/** Accessible textual time-series data alongside the canvas (7.7). */
function renderAccessibleTable(data: LeaderboardResponse): void {
  const container = document.getElementById("chart-table");
  if (!container) return;
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `${data.metric.label} per player over time`;
  table.appendChild(caption);
  const head = table.createTHead().insertRow();
  head.appendChild(document.createElement("th")).textContent = "Player";
  for (const label of data.labels) {
    head.appendChild(document.createElement("th")).textContent = label;
  }
  const body = table.createTBody();
  for (const series of data.series) {
    const row = body.insertRow();
    row.appendChild(document.createElement("th")).textContent = series.username;
    for (const v of series.values) {
      row.appendChild(document.createElement("td")).textContent =
        v === null ? "gap" : formatMetric(v, data.metric.kind);
    }
  }
  container.replaceChildren(table);
}

buildSelector();
await refresh().catch(() => {
  // Keep last rendered data; show connection state (6.6).
  const timeEl = document.getElementById("collection-time");
  if (timeEl) timeEl.textContent = "Connection problem — showing last loaded data.";
});

connectEvents(() => {
  void refresh().catch(() => undefined);
});
