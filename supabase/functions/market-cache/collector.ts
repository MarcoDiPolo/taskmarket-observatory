// Server-side snapshot. Publication and storage belong to the caller, after both chains return.
const API = "https://api.taskmarket.dev/api/";
const PERIODS = ["7d", "30d", "90d", "all"] as const;
const HEADLINES = ["registeredWorkers", "activeWorkers7d", "activeAgents7d", "openTasks", "paidWorkers", "activeWallets"];
const DAY = 86_400_000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const NETWORKS = [{key: "tempo", id: 4217, name: "Tempo", token: "OUSD"},
                  {key: "base", id: 8453, name: "Base", token: "USDC"}] as const;
type Network = typeof NETWORKS[number];
type Row = Record<string, unknown>;
type Get = (path: string, chain: number, params?: Record<string, string>) => Promise<unknown>;
type Breakdown = Record<string, string | number>[];

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid API object");
  return value as Row;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Invalid API array");
  return value;
}

function rows(value: unknown): Row[] {
  return array(value).map(object);
}

function integer(value: unknown): number {
  const num = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) throw Error("Invalid integer");
  return num;
}

function tokens(value: unknown): number {
  const micros = integer(value), result = micros / 1_000_000;
  if (Math.round(result * 1_000_000) !== micros) throw Error("Token precision lost");
  return result;
}

function label(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw Error("Invalid market label");
  return value;
}

function iso(value: unknown): string {
  if (typeof value !== "string") throw Error("Timestamp missing");
  const parts = /^(\d{4}-\d\d-\d\d)T\d\d:\d\d:\d\d(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts) throw Error("Timestamp requires a time zone");
  const utc = new Date(value).toISOString().slice(0, 19);
  const fraction = (parts[2] ?? "").padEnd(6, "0");
  return utc + (fraction === "000000" ? "" : "." + fraction) + "Z";
}

function dayKey(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value) ||
      new Date(value).toISOString().slice(0, 10) !== value) throw Error("Invalid UTC day");
  return value;
}

function bump(counter: Map<string, number>, key: string, add = 1) {
  counter.set(key, integer((counter.get(key) ?? 0) + add));
}

function cursor(page: Row, visited: Set<string>): string {
  const next = page.nextCursor;
  if (typeof next !== "string" || !next || visited.has(next)) throw Error("Missing or repeated source cursor");
  visited.add(next);
  return next;
}

function counts(counter: Map<string, number>, key: string): Breakdown {
  return [...counter].sort(([a, v], [b, w]) => w - v || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({[key]: name, count}));
}

async function catalog(get: Get, chain: number) {
  const refs = new Map<string, string | null>(), tasks = new Map<string, number>(), reward = new Map<string, number>();
  const modes = new Map<string, number>(), statuses = new Map<string, number>();
  const posted = new Map<string, number>(), posters = new Map<string, Set<string>>();
  const visited = new Set<string>();
  let next = "";
  do {
    const params: Record<string, string> = {sort: "newest", limit: "100"};
    if (next) params.cursor = next;
    const page = object(await get("tasks", chain, params));
    const pageTasks = rows(page.tasks);
    for (const task of pageTasks) {
      if (task.chainId !== chain) throw Error("Unexpected task chain");
      if (typeof task.id !== "string" || !task.id) throw Error("Missing task identity");
      const id = task.id.toLowerCase();
      if (refs.has(id)) continue;
      const reference = task.referenceCode;
      refs.set(id, typeof reference === "string" && /^TSK-[A-Z0-9]+$/.test(reference) ? reference : null);
      const day = iso(task.createdAt).slice(0, 10);
      const dayStart = new Date(day);
      const monday = new Date(+dayStart - ((dayStart.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
      bump(tasks, day);
      bump(reward, day, integer(task.reward));
      bump(posted, monday);
      bump(modes, label(task.mode));
      bump(statuses, label(task.status));
      if (typeof task.requester !== "string" || !/^0x[0-9a-f]{40}$/i.test(task.requester)) throw Error("Invalid requester");
      if (!posters.has(monday)) posters.set(monday, new Set());
      posters.get(monday)!.add(task.requester.toLowerCase());
    }
    if (page.hasMore === false) break;
    if (page.hasMore !== true || !pageTasks.length) throw Error("Incomplete task pagination");
    next = cursor(page, visited);
  } while (next);

  const weeks = [];
  const first = [...posted.keys()].sort()[0];
  for (let t = first ? Date.parse(first) : Infinity; t <= Date.now(); t += 7 * DAY) {
    const week = new Date(t).toISOString().slice(0, 10);
    weeks.push({week, posters: posters.get(week)?.size ?? 0, tasks: posted.get(week) ?? 0});
  }
  return {refs, tasks, reward, weeks, status: counts(statuses, "status"), mode: counts(modes, "mode")};
}

type Catalog = Awaited<ReturnType<typeof catalog>>;

function series(raw: unknown, cat: Catalog) {
  const seen = new Set<string>();
  return rows(raw).map(item => {
    const date = dayKey(item.bucket);
    if (seen.has(date)) throw Error("Duplicate daily bucket");
    seen.add(date);
    return {date, activeAgents: integer(item.activeAgents), tasks: integer(item.tasksCreated),
            rewards: tokens(item.rewardVolume), paid: tokens(item.paidVolume), completed: integer(item.completedTasks),
            settlements: integer(item.settlements), newAgents: integer(item.newAgents), ratings: integer(item.ratings),
            chainTasks: cat.tasks.get(date) ?? 0, chainRewards: tokens(cat.reward.get(date) ?? 0)};
  }).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

function heatmap(raw: unknown) {
  const data = object(raw);
  for (const [keys, size] of [[data.rowKeys, 7], [data.colKeys, 24]] as const) {
    const indices = new Set(array(keys).map(integer));
    if (indices.size !== size || [...indices].some(i => i >= size)) throw Error("Invalid heatmap dimensions");
  }
  const matrix = Array.from({length: 7}, () => Array<number>(24).fill(0));
  const seen = new Set<number>();
  for (const cell of rows(data.cells)) {
    const row = integer(cell.row), col = integer(cell.col), key = row * 24 + col;
    if (row >= 7 || col >= 24 || seen.has(key)) throw Error("Invalid heatmap coordinates");
    seen.add(key);
    matrix[row][col] = integer(cell.count);
  }
  return matrix;
}

async function activity(get: Get, chain: number, refs: Catalog["refs"]) {
  const result = [], visited = new Set<string>();
  let next = "";
  for (let i = 0; i < 12; i++) {
    const params: Record<string, string> = {limit: "50"};
    if (next) params.cursor = next;
    const page = object(await get("stats/activity-feed", chain, params)), items = rows(page.items);
    for (const event of items) {
      if (event.chainId !== chain) continue;
      const id = typeof event.taskId === "string" ? event.taskId.toLowerCase() : "";
      result.push({type: label(event.type), at: iso(event.timestamp), title: refs.get(id) ?? null,
                   amount: event.amount == null ? null : tokens(event.amount)});
      if (result.length === 15) return result;
    }
    if (!page.nextCursor || !items.length) break;
    next = cursor(page, visited);
  }
  return result;
}

async function metrics(get: Get, chain: number) {
  const headline = object(await get("market/stats", chain));
  const stats = Object.fromEntries(HEADLINES.map(k => [k, integer(headline[k])]));
  const reported = object(await get("stats/breakdowns", chain));
  const breakdowns: Record<string, Breakdown> = {};
  for (const k of ["status", "mode", "actorType"]) {
    breakdowns[k] = rows(reported[k]).map(r => ({[k]: label(r[k]), count: integer(r.count)}));
  }
  const ranges = [];
  for (const period of PERIODS) {
    const values = await get("stats/platform-time-series", chain, {range: period, bucket: "day"});
    const grid = heatmap(await get("stats/activity-heatmap", chain, {range: period, dimension: "hourOfWeek"}));
    ranges.push({period, values, grid});
  }
  return {stats, breakdowns, ranges};
}

async function collectChain(get: Get, network: Network) {
  const {id, name, token} = network;
  // Two serial lanes per network, four concurrent requests in total. Collect the feed as soon as IDs are known.
  const catalogAndFeed = async () => {
    const cat = await catalog(get, id);
    return {cat, feed: await activity(get, id, cat.refs)};
  };
  const [{cat, feed}, reported] = await Promise.all([catalogAndFeed(), metrics(get, id)]);
  const ranges = Object.fromEntries(reported.ranges.map(({period, values, grid}) =>
    [period, {series: series(values, cat), heatmap: grid}]));
  return {id, name, token, stats: reported.stats, breakdowns: {status: cat.status, mode: cat.mode, actorType: reported.breakdowns.actorType},
          reportedBreakdowns: reported.breakdowns, ranges, feed, weeks: cat.weeks, taskCount: cat.refs.size};
}

export async function collectMarket() {
  const start = Date.now(), deadline = start + 120_000;
  const control = new AbortController(), timeout = setTimeout(() => control.abort(), deadline - start);
  let cooldownUntil = 0;
  const get: Get = async (path, chain, params = {}) => {
    const url = new URL(API + path);
    url.search = new URLSearchParams({chainId: String(chain), ...params}).toString();
    for (let attempt = 0; attempt < 4; attempt++) {
      while (cooldownUntil > Date.now()) {
        control.signal.throwIfAborted();
        if (cooldownUntil >= deadline) throw Error("Source cooldown exceeds collection deadline");
        await new Promise(resolve => setTimeout(resolve, Math.min(cooldownUntil - Date.now(), 500)));
      }
      control.signal.throwIfAborted();
      const signal = AbortSignal.any([control.signal, AbortSignal.timeout(20_000)]);
      let response: Response;
      try {
        response = await fetch(url, {headers: {Accept: "application/json", "User-Agent": "Taskmarket-Market-Observatory/1.0"}, signal});
      } catch (err) {
        if (attempt === 3 || control.signal.aborted) throw err;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + (2 ** attempt) * 1000);
        continue;
      }
      if (response.ok) {
        const result: unknown = await response.json();
        if (result && typeof result === "object" && "error" in result && result.error) throw Error("Upstream reported an error");
        return result;
      }
      await response.body?.cancel();
      if (!RETRYABLE.has(response.status) || attempt === 3) throw Error("Taskmarket returned HTTP " + response.status + " for " + path);
      const retry = response.headers.get("Retry-After");
      const resume = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
      cooldownUntil = Math.max(cooldownUntil, Date.now() + 2 ** (attempt + 1) * 1000, Number.isFinite(resume) ? resume : 0);
    }
    throw Error("Upstream exhausted retries");
  };
  try {
    const [tempo, base] = await Promise.all(NETWORKS.map(network => collectChain(get, network)));
    if (Date.now() >= deadline) throw Error("Collection deadline exceeded");
    return {startedAt: new Date(start).toISOString().slice(0, 19) + "Z",
            asOf: new Date().toISOString().slice(0, 19) + "Z", chains: {tempo, base}};
  } finally {
    clearTimeout(timeout);
    control.abort();
  }
}
