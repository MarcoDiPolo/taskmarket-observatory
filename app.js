"use strict";

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const validRanges = ["7d", "30d", "90d", "all"];
let network = params.get("chain") === "base" ? "base" : "tempo";
let range = validRanges.includes(params.get("range")) ? params.get("range") : "30d";
let market;
const fmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 6});
const utc = new Intl.DateTimeFormat("en-GB", {day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"UTC"});
const shortDate = new Intl.DateTimeFormat("en-GB", {day:"numeric", month:"short", timeZone:"UTC"});
const feedDate = new Intl.DateTimeFormat("en-GB", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", timeZone:"UTC"});
const heatColors = ["#453e37", "#67564e", "#8d7067", "#b1877e", "#d9a097"];
const asNumber = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const valueText = value => asNumber(value) === null ? "Unavailable" : fmt.format(Number(value));
const dateText = (str, formatter) => str && Number.isFinite(Date.parse(str)) ? formatter.format(new Date(str)) : "Unavailable";
const toWords = value => String(value || "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, s => s.toUpperCase());
function tag(name, text, cls) {
  const node = document.createElement(name);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function svgTag(name, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function table(headers, rows) {
  if (!rows.length) return tag("p", "No records for this view.");
  const grid = tag("table");
  const head = grid.createTHead().insertRow();
  for (const label of headers) {
    const cell = tag("th", label);
    cell.scope = "col";
    head.append(cell);
  }
  const body = grid.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const val of row) tr.insertCell().textContent = val;
  }
  return grid;
}
function trend(title, unit, dates, values, card = true) {
  const frame = tag("div", null, card ? "panel" : "");
  const key = tag("div", null, "chart-key");
  key.append(tag("h3", title), tag("small", unit));
  frame.append(key);
  const numbers = values.map(asNumber);
  if (!numbers.some(x => x !== null)) {
    frame.append(tag("p", "No data for this period."));
    return frame;
  }
  const max = Math.max(0, ...numbers.filter(x => x !== null));
  const latest = numbers.at(-1);
  frame.append(tag("div", valueText(latest), "chart-value"), tag("small", "Latest bucket", "axis"));
  const svg = svgTag("svg", {viewBox:"0 0 400 90", preserveAspectRatio:"none", class:"trend-svg", "aria-hidden":"true"});
  for (const y of [5, 45, 85]) svg.append(svgTag("line", {x1:0,x2:400,y1:y,y2:y,stroke:"#453e37","stroke-dasharray":y === 85 ? "0" : "3 4"}));
  let segment = [];
  function flush() {
    if (segment.length > 1) {
      svg.append(svgTag("polyline", {points:segment.join(" "),fill:"none",stroke:"#d9a097","stroke-width":2,"vector-effect":"non-scaling-stroke","stroke-linejoin":"round"}));
    } else if (segment.length) {
      const [cx,cy] = segment[0].split(",");
      svg.append(svgTag("circle",{cx,cy,r:2,fill:"#d9a097"}));
    }
    segment = [];
  }
  for (let i=0; i<numbers.length; i++) {
    if (numbers[i] === null) { flush(); continue; }
    const x = numbers.length === 1 ? 200 : 2 + 396 * i / (numbers.length - 1);
    const y = max ? 85 - 80 * numbers[i] / max : 85;
    segment.push(x.toFixed(2) + "," + y.toFixed(2));
  }
  flush();
  frame.append(svg);
  const axes = tag("div", null, "chart-axes axis");
  axes.append(tag("span", dateText(dates[0],shortDate)), tag("span","Scale 0 to " + valueText(max)), tag("span",dateText(dates.at(-1),shortDate)));
  frame.append(axes);
  return frame;
}
function renderHeadlines(chain) {
  el("network-title").textContent = chain.name + " market";
  el("network-id").textContent = "Chain " + chain.id + " · " + chain.token;
  const s = chain.stats;
  const labels = [
    [chain.taskCount, "Network tasks listed"],
    [chain.breakdowns.status.find(row => row.status === "open")?.count ?? 0, "Network tasks marked open"],
    [s.registeredWorkers, "Registered workers · API"],
    [s.activeWorkers7d, "7-day active workers · API"],
    [s.activeAgents7d, "7-day active agents · API"],
    [s.paidWorkers, "Paid workers · API"],
    [s.openTasks, "Open tasks · API"],
    [s.activeWallets, "Active wallets · API"]
  ];
  const cards = labels.map(([val, label]) => {
    const card = tag("div", null, "metric");
    card.append(tag("span",valueText(val),"value"), tag("span",label));
    return card;
  });
  el("headlines").replaceChildren(...cards);
}
function renderTrends(chain, data) {
  const series = data.series;
  const metrics = [
    ["activeAgents","Active agents","Platform · agents"],
    ["tasks","Tasks posted","Platform · tasks"],
    ["rewards","Rewards posted","Platform · reported units"],
    ["paid","Rewards paid","Platform · reported units"],
    ["chainTasks",chain.name + " tasks posted","Network · tasks"],
    ["chainRewards",chain.name + " rewards posted","Network · " + chain.token]
  ];
  const dates = series.map(row => row.date);
  el("trends").replaceChildren(...metrics.map(([key,label,unit]) => trend(label, unit, dates, series.map(row => row[key]))));
  el("daily-table").replaceChildren(table(["UTC day", ...metrics.map(m => m[1]+" ("+m[2]+")")],
    [...series].reverse().map(r => [r.date, ...metrics.map(([key]) => valueText(r[key]))])));
}
function renderBreakdown(title, rows, field) {
  const panel = tag("div", null,"panel");
  panel.append(tag("h3",title));
  const sorted = [...rows].sort((a,b) => b.count-a.count);
  if (!sorted.length) panel.append(tag("p","No records."));
  for (const item of sorted) {
    const row = tag("div",null,"bar-row");
    const track = tag("div",null,"bar-track");
    const fill = tag("div",null,"bar-fill");
    fill.style.width = (sorted[0].count ? item.count * 100 / sorted[0].count : 0) + "%";
    track.append(fill);
    row.append(tag("span",toWords(item[field])),track,tag("span",valueText(item.count),"bar-value"));
    panel.append(row);
  }
  return panel;
}
function renderHeat(hourly) {
  const grid = el("heatmap");
  const max = Math.max(0,...hourly.flat().map(asNumber).filter(n => n !== null));
  const hourLabel = hour => String(hour).padStart(2,"0") + ":00";
  grid.replaceChildren(tag("span"));
  for (let h=0;h<24;h++) grid.append(tag("span", h%4 === 0 ? hourLabel(h).slice(0,2) : "", "heat-hour"));
  const tableRows = [];
  for (const [d,row] of hourly.entries()) {
    grid.append(tag("span","D"+d,"heat-day"));
    tableRows.push(["Day "+d,...row.map(valueText)]);
    for (let h=0;h<24;h++) {
      const n = asNumber(row[h]);
      const cell = tag("div",null,"heat-cell");
      const step = n === null ? 0 : !n || !max ? 0 : Math.max(1,Math.ceil(4*n/max));
      cell.style.background = heatColors[step];
      cell.title = "Day " + d + " · " + hourLabel(h) + " UTC · " + valueText(n) + " events";
      if (n === null) cell.style.background = "transparent";
      grid.append(cell);
    }
  }
  el("heat-description").textContent = "Platform activity by hour (UTC), " + (range === "all" ? "all available dates" : "last " + range.slice(0,-1) + " days") + ". D0–D6 are the day indices supplied by the API.";
  const legend = el("heat-legend");
  legend.replaceChildren(document.createTextNode("0 "));
  for (const color of heatColors) { const square = tag("i");square.style.background=color;legend.append(square); }
  legend.append(document.createTextNode(" " + valueText(max) + " events per cell"));
  el("hourly-table").replaceChildren(table(["Day index", ...Array.from({length:24},(_,h)=>hourLabel(h))],tableRows));
}
function renderWeeks(chain) {
  const weeks = chain.weeks;
  el("weekly-chart").replaceChildren(trend("Weekly posters","Network · addresses",weeks.map(r=>r.week),weeks.map(r=>r.posters),false));
  const latest = weeks.at(-1);
  const insight = el("weekly-insight");
  insight.replaceChildren(tag("h3","Posting density"));
  if (latest && latest.posters > 0) {
    const ratio = (latest.tasks/latest.posters).toLocaleString("en-US",{maximumFractionDigits:2});
    insight.append(tag("span",ratio,"value"),tag("p","tasks per poster in the latest listed week. " + valueText(latest.posters) + " addresses posted " + valueText(latest.tasks) + " tasks from " + dateText(latest.week,shortDate) + " UTC."));
  } else insight.append(tag("p","No active posting week in this snapshot."));
  el("weekly-table").replaceChildren(table(["Week starting (UTC)","Distinct posters","Tasks"],[...weeks].reverse().map(r=>[r.week,valueText(r.posters),valueText(r.tasks)])));
}
function renderFeed(chain) {
  const rows = chain.feed.map(item => {
    const row = tag("li");
    const when = tag("time",dateText(item.at,feedDate));
    if (item.at) when.dateTime = item.at;
    const info = tag("div");
    info.append(tag("strong",item.title || toWords(item.type)),tag("span",toWords(item.type),"type"));
    row.append(when,info);
    if (asNumber(item.amount) !== null) row.append(tag("span",valueText(item.amount)+" "+chain.token,"amount"));
    return row;
  });
  if (!rows.length) rows.push(tag("li","No events for this network in the retrieved feed."));
  el("feed-list").replaceChildren(...rows);
}
function paint() {
  for (const button of document.querySelectorAll("[data-chain]")) button.setAttribute("aria-pressed",String(button.dataset.chain === network));
  for (const button of document.querySelectorAll("[data-range]")) button.setAttribute("aria-pressed",String(button.dataset.range === range));
  if (!market) return;
  const chain = market.chains[network];
  const data = chain.ranges[range];
  renderHeadlines(chain);
  renderTrends(chain,data);
  el("breakdowns").replaceChildren(renderBreakdown("Tasks by mode",chain.breakdowns.mode,"mode"),renderBreakdown("Tasks by status",chain.breakdowns.status,"status"));
  renderHeat(data.heatmap);
  renderWeeks(chain);
  renderFeed(chain);
  el("market").hidden = false;
  const old = Date.now() - Date.parse(market.asOf) > 3600000;
  el("timestamp").textContent = "Data as of " + dateText(market.asOf,utc) + " UTC" + (old ? " · Older than 1 hour" : "");
}
function updateLocation() {
  const url = new URL(location.href);
  url.searchParams.set("chain",network);
  url.searchParams.set("range",range);
  history.replaceState(null,"",url);
  paint();
}
for (const button of document.querySelectorAll("[data-chain]")) {
  button.addEventListener("click",() => { network = button.dataset.chain; updateLocation(); });
}
for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click",() => { range = button.dataset.range; updateLocation(); });
}
async function readSnapshot(url) {
  const response = await fetch(url, {
    cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Snapshot unavailable");
  const data = await response.json();
  const stamp = Date.parse(data.asOf);
  if (!Number.isFinite(stamp) || stamp > Date.now() + 60000 ||
      data.chains?.base?.id !== 8453 || data.chains?.tempo?.id !== 4217) {
    throw new Error("Incomplete market snapshot");
  }
  if (market && Date.parse(market.asOf) >= stamp) {
    paint();
    return;
  }
  market = data;
  paint();
  el("snapshot-link").href = url;
}
async function load() {
  const staticUrl = "data/market.json";
  const cacheUrl = document.querySelector('meta[name="market-cache-url"]')?.content;
  el("cache-method").hidden = !cacheUrl;
  const urls = cacheUrl ? [staticUrl, cacheUrl] : [staticUrl];
  try {
    await Promise.any(urls.map(readSnapshot));
    el("error").hidden = true;
  } catch {
    const note = el("error");
    if (!market) el("timestamp").textContent = "Snapshot unavailable.";
    note.textContent = market ? "Could not refresh. Showing the last loaded snapshot." : "Could not load the market snapshot. Reload this page to try again.";
    note.hidden = false;
  }
}
paint();
load().then(() => {
  const target = location.hash.slice(1);
  if (target && el(target)) el(target).scrollIntoView();
});
setInterval(() => { if (!document.hidden) load(); }, 300000);
