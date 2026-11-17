import {
  readBootstrap,
  renderHeader,
  jsonFetch,
  connectEvents,
  formatMetric,
  formatRelativeTime,
  formatAbsoluteTime,
  queryState,
  updateQuery,
} from "./common.ts";

/** Live page (spec 5.10 – 5.12): 10 newest plays and the extended team leaderboard. */

interface PlaysResponse {
  mode: string;
  updatedAt: string | null;
  plays: Array<{
    scoreId: number;
    userId: number;
    username: string;
    avatarUrl: string | null;
    beatmapTitle: string | null;
    beatmapArtist: string | null;
    difficultyName: string | null;
    starRating: number | null;
    coverUrl: string | null;
    grade: string;
    mods: string;
    pp: number | null;
    accuracy: number | null;
    score: number | string | null;
    maxCombo: number | null;
    endedAt: string;
  }>;
}

interface LiveLeaderboardResponse {
  mode: string;
  sort: string;
  collectedAt: string | null;
  rows: Array<{ userId: number; username: string; avatarUrl: string | null; values: Record<string, number | string | null> }>;
}

const SORTS: Array<{ key: string; label: string }> = [
  { key: "pp", label: "PP" },
  { key: "ranked_score", label: "Ranked score" },
  { key: "total_score", label: "Total score" },
  { key: "accuracy", label: "Accuracy" },
  { key: "play_count", label: "Play count" },
  { key: "play_time", label: "Play time" },
  { key: "total_hits", label: "Total hits" },
  { key: "global_rank", label: "Global rank" },
  { key: "grade_ss", label: "SS" },
  { key: "grade_ssh", label: "SSH" },
  { key: "grade_s", label: "S" },
  { key: "grade_sh", label: "SH" },
  { key: "grade_a", label: "A" },
];

const bootstrap = readBootstrap();
const header = renderHeader(bootstrap);

let sort = queryState().get("sort") ?? "pp";
if (!SORTS.some((s) => s.key === sort)) sort = "pp";

function parseMods(mods: string): string {
  try {
    const parsed = JSON.parse(mods) as Array<string | { acronym: string }>;
    return parsed
      .map((m) => (typeof m === "string" ? m : m.acronym))
      .filter(Boolean)
      .join(",");
  } catch {
    return "";
  }
}

async function refreshPlays(): Promise<void> {
  const data = await jsonFetch<PlaysResponse>(`/api/live/plays?mode=${encodeURIComponent(header.mode)}&limit=10`);
  const body = document.getElementById("plays-body") as HTMLTableSectionElement | null;
  const empty = document.getElementById("plays-empty");
  const timeEl = document.getElementById("plays-time");
  if (!body) return;
  body.textContent = "";
  if (empty) empty.hidden = data.plays.length > 0;
  if (timeEl) {
    timeEl.textContent = data.updatedAt
      ? `Newest play ${formatAbsoluteTime(data.updatedAt)} (${formatRelativeTime(data.updatedAt)})`
      : "No plays captured yet.";
  }
  for (const play of data.plays) {
    const tr = body.insertRow();

    const tdPlayer = tr.insertCell();
    const wrap = document.createElement("span");
    wrap.className = "player-cell";
    if (play.avatarUrl) {
      const img = document.createElement("img");
      img.src = play.avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      wrap.appendChild(img);
    }
    wrap.appendChild(document.createTextNode(play.username));
    tdPlayer.appendChild(wrap);

    const tdMap = tr.insertCell();
    const map = document.createElement("div");
    map.textContent = `${play.beatmapArtist ?? "?"} — ${play.beatmapTitle ?? "?"}`;
    const diff = document.createElement("div");
    diff.className = "collection-time";
    diff.textContent = `${play.difficultyName ?? "?"}${play.starRating === null ? "" : ` · ${play.starRating.toFixed(2)}★`}`;
    map.appendChild(diff);
    tdMap.appendChild(map);

    const tdGrade = tr.insertCell();
    const badge = document.createElement("span");
    badge.className = "grade-badge";
    badge.textContent = play.grade;
    tdGrade.appendChild(badge);

    tr.insertCell().textContent = parseMods(play.mods);
    const tdPp = tr.insertCell();
    tdPp.className = "num";
    tdPp.textContent = play.pp === null ? "—" : `${play.pp.toFixed(2)} pp`;
    const tdAcc = tr.insertCell();
    tdAcc.className = "num";
    tdAcc.textContent = play.accuracy === null ? "—" : new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 }).format(play.accuracy);
    const tdScore = tr.insertCell();
    tdScore.className = "num";
    tdScore.textContent = formatMetric(play.score, "number");
    const tdTime = tr.insertCell();
    tdTime.className = "num";
    tdTime.textContent = formatRelativeTime(play.endedAt);
    tdTime.title = formatAbsoluteTime(play.endedAt);
  }
}

async function refreshLeaderboard(): Promise<void> {
  const data = await jsonFetch<LiveLeaderboardResponse>(
    `/api/live/leaderboard?mode=${encodeURIComponent(header.mode)}&sort=${encodeURIComponent(sort)}`,
  );
  const headRow = document.getElementById("live-head-row") as HTMLTableRowElement | null;
  const body = document.getElementById("live-body") as HTMLTableSectionElement | null;
  const empty = document.getElementById("live-empty");
  const timeEl = document.getElementById("live-collection-time");
  if (!headRow || !body) return;
  headRow.textContent = "";
  body.textContent = "";
  if (empty) empty.hidden = data.rows.length > 0;
  if (timeEl) {
    timeEl.textContent = data.collectedAt
      ? `Profile collection ${formatAbsoluteTime(data.collectedAt)}`
      : "No profile collection published yet.";
  }

  const thRank = document.createElement("th");
  thRank.scope = "col";
  thRank.textContent = "#";
  headRow.appendChild(thRank);
  const thPlayer = document.createElement("th");
  thPlayer.scope = "col";
  thPlayer.textContent = "Player";
  headRow.appendChild(thPlayer);
  for (const definition of SORTS) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "num";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = definition.label;
    button.setAttribute("aria-sort", definition.key === sort ? "descending" : "none");
    button.addEventListener("click", () => {
      sort = definition.key;
      updateQuery((p) => p.set("sort", sort));
      void refreshLeaderboard().catch(() => undefined);
    });
    th.appendChild(button);
    headRow.appendChild(th);
  }

  data.rows.forEach((row, index) => {
    const tr = body.insertRow();
    const tdRank = tr.insertCell();
    tdRank.className = "num";
    tdRank.textContent = String(index + 1);
    const tdPlayer = tr.insertCell();
    const wrap = document.createElement("span");
    wrap.className = "player-cell";
    if (row.avatarUrl) {
      const img = document.createElement("img");
      img.src = row.avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      wrap.appendChild(img);
    }
    wrap.appendChild(document.createTextNode(row.username));
    tdPlayer.appendChild(wrap);
    for (const definition of SORTS) {
      const td = tr.insertCell();
      td.className = "num";
      td.textContent = definition.key === sort ? formatMetric(row.values[sort] ?? null, definition.key === "accuracy" ? "percent" : definition.key === "play_time" ? "duration" : "number") : "—";
    }
  });
}

async function refresh(): Promise<void> {
  await Promise.allSettled([refreshPlays(), refreshLeaderboard()]);
}

await refresh().catch(() => undefined);

connectEvents((kind) => {
  if (kind === "collection") void refreshLeaderboard().catch(() => undefined);
  void refreshPlays().catch(() => undefined);
});
