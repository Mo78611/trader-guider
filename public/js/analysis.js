"use strict";
/* Analysis Hub — public gallery + personal list. */
let mode = "public";
let cache = [];
let myId = null;

function tagChipsHTML(tags) {
  if (!tags || !tags.length) return "";
  return tags.map((t) => `<span class="tag-chip" style="cursor:default">${escapeHtml(t)}</span>`).join("");
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
async function boot() {
  const me = await fetch("/api/auth/me").then((r) => r.json()).catch(() => ({ user: null }));
  if (!me.user) { location.href = "/login.html"; return; }
  myId = me.user.id;
  document.getElementById("logoutBtn").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" }); location.href = "/login.html";
  };
  document.getElementById("tabPublic").onclick = () => setMode("public");
  document.getElementById("tabMine").onclick = () => setMode("mine");
  document.getElementById("vLoad").onclick = loadIntoTerminal;
  document.getElementById("vDel").onclick = deleteCurrent;
  document.getElementById("viewModal").addEventListener("click", (e) => {
    if (e.target.id === "viewModal") e.target.classList.remove("open");
  });
  load();
}
function setMode(m) {
  mode = m;
  document.getElementById("tabPublic").classList.toggle("active", m === "public");
  document.getElementById("tabMine").classList.toggle("active", m === "mine");
  load();
}
async function load() {
  const url = mode === "public" ? "/api/analysis" : "/api/analysis/mine";
  const j = await fetch(url).then((r) => r.json()).catch(() => ({ analyses: [] }));
  cache = j.analyses || [];
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  document.getElementById("empty").style.display = cache.length ? "none" : "block";
  for (const a of cache) {
    const card = document.createElement("div");
    card.className = "hub-card";
    // Snapshot loads on open (keeps the list payload light).
    card.innerHTML = `<div class="body"><h3></h3>
      <div class="meta"></div><p></p></div>`;
    card.querySelector("h3").textContent = a.title;
    card.querySelector(".meta").textContent =
      `${a.author ? a.author.name : "?"} · ${a.symbol} ${a.timeframe} · ${a.created_at.slice(0, 16).replace("T", " ")}`;
    card.querySelector("p").textContent = (a.body || "").slice(0, 220);
    if (a.tags && a.tags.length) {
      const chips = document.createElement("div");
      chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:8px";
      chips.innerHTML = tagChipsHTML(a.tags);
      card.querySelector(".body").appendChild(chips);
    }
    card.style.cursor = "pointer";
    card.onclick = () => openView(a.id);
    grid.appendChild(card);
  }
}
let current = null;
async function openView(id) {
  const j = await fetch("/api/analysis/" + id).then((r) => r.json());
  if (!j.analysis) return;
  current = j.analysis;
  document.getElementById("vTitle").textContent = current.title;
  document.getElementById("vMeta").textContent =
    `${current.author ? current.author.name : "?"} · ${current.symbol} ${current.timeframe} · ${current.created_at}`;
  const img = document.getElementById("vImg");
  if (current.snapshot) { img.src = current.snapshot; img.style.display = "block"; }
  else img.style.display = "none";
  document.getElementById("vBody").textContent = current.body || "(no breakdown written)";
  document.getElementById("vTags").innerHTML = tagChipsHTML(current.tags);
  document.getElementById("vDel").style.display =
    (current.author && current.author.id === myId) ? "inline-block" : "none";
  document.getElementById("viewModal").classList.add("open");
}
async function loadIntoTerminal() {
  if (!current || !current.chart_state) return;
  const cs = current.chart_state;
  await fetch("/api/chart/state", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: cs.symbol || current.symbol, timeframe: cs.timeframe || current.timeframe,
      indicators: cs.indicators || [], drawings: cs.drawings || [], layout: {},
    }),
  });
  location.href = "/terminal";
}
async function deleteCurrent() {
  if (!current || !confirm("Delete this analysis?")) return;
  await fetch("/api/analysis/" + current.id, { method: "DELETE" });
  document.getElementById("viewModal").classList.remove("open");
  load();
}
document.addEventListener("DOMContentLoaded", boot);
