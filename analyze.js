/* =================================================================
   EVA — TRADING JOURNAL (analyze.js)
   Phase 2: real Firebase-backed analytics for analyze.html.

   Mirrors journal.js's boot pattern exactly (waitForElement, same
   Firebase app instance, same Firestore paths) and reuses journal.js's
   documented rules verbatim:
     - profitLoss (signed number) is the ONLY source of truth for
       Win/Loss/BE. The stored `result` label is NEVER trusted.
     - never Math.abs() a profitLoss to "fix" a sign.

   dashboard.js was not available to copy from directly (not uploaded),
   so normalizeTrade()/calculateEquity()/calculateDrawdown()/
   calculateStatistics() below are reconstructed from the documented
   spec, not copied byte-for-byte. Functionally they follow the same
   rules: sign-based classification, running-peak drawdown (verified
   against the spec's test case 10000,10200,10000,10500,10300 ->
   dd 0,0,200,0,200), and standard win-rate/profit-factor formulas.

   NOT LIVE VERIFIED: this file has not been run against a live
   Firebase project or a browser in this environment. Logic has been
   traced by hand against the documented schema and test cases, but
   has not been executed against real data.
   ================================================================= */

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, getDocs,
  onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* -----------------------------------------------------------------
   FIREBASE — same app instance as journal.js/dashboard.js
   ----------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyDGh-M9Ps_fy1k8u-r0H899U0L-LQQBKZI",
  authDomain: "eval-61cd9.firebaseapp.com",
  projectId: "eval-61cd9",
  storageBucket: "eval-61cd9.firebasestorage.app",
  messagingSenderId: "843373749164",
  appId: "1:843373749164:web:cc93d5513895ca10065009",
  measurementId: "G-R6D77DNJXT"
};
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* -----------------------------------------------------------------
   DOM HELPERS (same as journal.js)
   ----------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function byId(id) { return document.getElementById(id); }

function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      const el = document.querySelector(selector);
      if (el) resolve(el); else reject(new Error(`Timed out waiting for ${selector}`));
    }, timeoutMs);
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function setText(id, val) { const el = byId(id); if (el) el.textContent = val; }
function setAttr(sel, root, name, val) { const el = $(sel, root); if (el) el.setAttribute(name, val); }

function fmtMoney(n) {
  const num = Number(n) || 0;
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toFixed(2)}`;
}
function fmtBalance(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toFixed(digits);
}
function fmtDate(d) {
  if (!d) return "—";
  const date = (d instanceof Date) ? d : (d.toDate ? d.toDate() : new Date(d));
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function getTradeDate(trade) {
  if (!trade.tradeDate) return null;
  const d = trade.tradeDate.toDate ? trade.tradeDate.toDate() : new Date(trade.tradeDate);
  return isNaN(d.getTime()) ? null : d;
}

/* -----------------------------------------------------------------
   STATE
   ----------------------------------------------------------------- */
const state = {
  uid: null,
  accounts: [],
  selectedAccountId: null,
  selectedAccount: null,
  unsubAccount: null,
  unsubTrades: null,
  rawTrades: [],        // normalized trades for the selected account, all time
  dateRange: "year",     // matches the pill marked an-active in markup
  customStart: null,
  customEnd: null,
  filters: {
    strategy: "", setup: "", session: "", result: "", symbol: "",
    direction: "", grade: "", condition: "", emotion: "", discipline: ""
  },
  equityTimeframe: "ALL",
  charts: {} // id -> echarts instance
};

const MIN_SAMPLE = 5;      // minimum trades before a "best/worst" claim is shown
const STREAK_MIN_SAMPLE = 10;

/* -----------------------------------------------------------------
   DATA INTEGRITY — the single source of truth (Rule 18 / dashboard.js)
   ----------------------------------------------------------------- */
function normalizeTrade(raw) {
  const profitLoss = Number(raw.profitLoss) || 0;
  const classification = profitLoss > 0 ? "WIN" : profitLoss < 0 ? "LOSS" : "BREAK-EVEN";
  const storedResult = (raw.result || "").toUpperCase().replace("BE", "BREAK-EVEN");
  const inconsistent = storedResult && storedResult !== classification &&
    !(storedResult === "BREAK-EVEN" && classification === "BREAK-EVEN");
  const date = getTradeDate(raw);
  let risk = raw.risk !== undefined && raw.risk !== null && raw.risk !== "" ? Number(raw.risk) : null;
  if (risk !== null && isNaN(risk)) risk = null;
  const rMultiple = (risk && risk !== 0) ? (profitLoss / Math.abs(risk)) : null;
  return {
    ...raw,
    id: raw.id,
    plSigned: profitLoss,
    classification,          // "WIN" | "LOSS" | "BREAK-EVEN" — always trust this, never `result`
    resultInconsistent: inconsistent,
    date,
    risk,
    rMultiple,
    lotSize: raw.lotSize !== undefined ? Number(raw.lotSize) : null
  };
}

/* -----------------------------------------------------------------
   CORE CALCULATIONS
   ----------------------------------------------------------------- */
function calculateEquity(trades, initialBalance) {
  const chrono = [...trades].filter(t => t.date).sort((a, b) => a.date - b.date);
  let bal = Number(initialBalance) || 0;
  const points = [{ date: null, balance: bal, label: "Start" }];
  for (const t of chrono) {
    bal += t.plSigned;
    points.push({ date: t.date, balance: bal, tradeId: t.id });
  }
  return points;
}

/* Running-peak drawdown. Verified against spec test case:
   10000,10200,10000,10500,10300 -> dd 0,0,200,0,200 */
function calculateDrawdown(equityPoints) {
  let peak = -Infinity;
  return equityPoints.map(p => {
    peak = Math.max(peak, p.balance);
    return { date: p.date, drawdown: peak - p.balance, balance: p.balance, peak };
  });
}

function calculateStatistics(trades) {
  const n = trades.length;
  if (n === 0) {
    return {
      total: 0, wins: 0, losses: 0, be: 0, winRate: null, netPL: 0,
      avgWin: null, avgLoss: null, profitFactor: null, expectancy: null,
      avgR: null, largestWin: null, largestLoss: null, bestTrade: null,
      worstTrade: null, maxDrawdown: 0
    };
  }
  const wins = trades.filter(t => t.classification === "WIN");
  const losses = trades.filter(t => t.classification === "LOSS");
  const be = trades.filter(t => t.classification === "BREAK-EVEN");
  const netPL = trades.reduce((s, t) => s + t.plSigned, 0);
  const grossWin = wins.reduce((s, t) => s + t.plSigned, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.plSigned, 0));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -(grossLoss / losses.length) : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
  const winRate = (n > 0) ? (wins.length / n) * 100 : null;
  const lossRate = (n > 0) ? (losses.length / n) * 100 : null;
  const expectancy = n > 0 ? netPL / n : null;
  const rTrades = trades.filter(t => t.rMultiple !== null && isFinite(t.rMultiple));
  const avgR = rTrades.length ? rTrades.reduce((s, t) => s + t.rMultiple, 0) / rTrades.length : null;
  const bestTrade = trades.reduce((best, t) => (!best || t.plSigned > best.plSigned) ? t : best, null);
  const worstTrade = trades.reduce((worst, t) => (!worst || t.plSigned < worst.plSigned) ? t : worst, null);
  const largestWin = wins.length ? Math.max(...wins.map(t => t.plSigned)) : null;
  const largestLoss = losses.length ? Math.min(...losses.map(t => t.plSigned)) : null;
  return {
    total: n, wins: wins.length, losses: losses.length, be: be.length,
    winRate, lossRate, beRate: n > 0 ? (be.length / n) * 100 : null, netPL,
    avgWin, avgLoss, profitFactor, expectancy, avgR,
    largestWin, largestLoss, bestTrade, worstTrade
  };
}

function maxDrawdownOf(ddPoints) {
  return ddPoints.length ? Math.max(...ddPoints.map(p => p.drawdown)) : 0;
}

function stdev(nums) {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

/* Groups trades by a key function, returns Map(key -> trades[]) preserving
   insertion order of first-seen key. Skips null/empty keys (never invents
   a bucket for missing data). */
function groupBy(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k === null || k === undefined || k === "") continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

function bestWorstFromGroups(groupStats, metric = "netPL", minSample = MIN_SAMPLE) {
  const eligible = groupStats.filter(g => g.stats.total >= minSample);
  if (!eligible.length) return { best: null, worst: null, insufficientData: true };
  const sorted = [...eligible].sort((a, b) => b.stats[metric] - a.stats[metric]);
  return { best: sorted[0], worst: sorted[sorted.length - 1], insufficientData: false };
}

/* -----------------------------------------------------------------
   ECHARTS — lazy loaded from cdnjs, same approach dashboard.js used
   ----------------------------------------------------------------- */
let echartsPromise = null;
function loadECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsPromise) return echartsPromise;
  echartsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js";
    s.onload = () => resolve(window.echarts);
    s.onerror = () => reject(new Error("Failed to load ECharts"));
    document.head.appendChild(s);
  });
  return echartsPromise;
}

function themeIsDark() {
  const root = document.querySelector("[data-eva-theme]");
  const val = root ? root.getAttribute("data-eva-theme") : null;
  return val ? val === "dark" : true;
}
function chartTextColor() { return themeIsDark() ? "#c7cdd9" : "#3a3f4b"; }
function chartGridColor() { return themeIsDark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"; }
const POS_COLOR = "#3ddc97", NEG_COLOR = "#ff5c72", NEU_COLOR = "#5b8def";

async function renderChart(containerId, optionFn, emptyMessage) {
  const el = byId(containerId);
  if (!el) return;
  const ec = await loadECharts().catch(() => null);
  if (!ec) { el.innerHTML = `<div class="an-chart-empty"><span>Chart library unavailable.</span></div>`; return; }
  const option = optionFn(ec);
  if (!option) {
    if (state.charts[containerId]) { state.charts[containerId].dispose(); delete state.charts[containerId]; }
    el.innerHTML = `<div class="an-chart-empty"><span>${escapeHtml(emptyMessage || "No data yet.")}</span></div>`;
    return;
  }
  el.innerHTML = "";
  let chart = state.charts[containerId];
  if (!chart || chart.isDisposed()) {
    chart = ec.init(el, null, { renderer: "canvas" });
    state.charts[containerId] = chart;
    if (!chart.__roAttached) {
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(el);
      chart.__roAttached = true;
    }
  }
  chart.setOption(option, true);
}

function barOption(categories, series, opts = {}) {
  return {
    textStyle: { color: chartTextColor(), fontFamily: "inherit" },
    grid: { left: 44, right: 16, top: 24, bottom: 32 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: categories, axisLine: { lineStyle: { color: chartGridColor() } }, axisLabel: { color: chartTextColor(), interval: 0, rotate: categories.length > 6 ? 30 : 0 } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: chartGridColor() } }, axisLabel: { color: chartTextColor() } },
    series: series.map(s => ({
      type: "bar", name: s.name, data: s.data, barMaxWidth: 34,
      itemStyle: { color: s.colorFn ? null : (s.color || NEU_COLOR) },
      ...(s.colorFn ? { itemStyle: { color: (p) => s.colorFn(p.data) } } : {})
    }))
  };
}

function lineOption(categories, series) {
  return {
    textStyle: { color: chartTextColor(), fontFamily: "inherit" },
    grid: { left: 54, right: 16, top: 24, bottom: 32 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: categories, boundaryGap: false, axisLine: { lineStyle: { color: chartGridColor() } }, axisLabel: { color: chartTextColor() } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: chartGridColor() } }, axisLabel: { color: chartTextColor() } },
    series: series.map(s => ({
      type: "line", name: s.name, data: s.data, smooth: 0.2, symbol: "none",
      lineStyle: { color: s.color || NEU_COLOR, width: 2 },
      areaStyle: s.area ? { color: s.color, opacity: 0.12 } : undefined
    }))
  };
}

function pieOption(items) {
  return {
    textStyle: { color: chartTextColor(), fontFamily: "inherit" },
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: { color: chartTextColor() } },
    series: [{
      type: "pie", radius: ["40%", "70%"], center: ["50%", "45%"],
      itemStyle: { borderColor: "transparent", borderWidth: 2 },
      label: { color: chartTextColor() },
      data: items
    }]
  };
}

/* -----------------------------------------------------------------
   BOOT
   ----------------------------------------------------------------- */
function initAuthAndBoot() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    state.uid = user.uid;
    await wireStaticUI();
    await loadAccounts();
  });
}

async function wireStaticUI() {
  await waitForElement("#an-root");
  wireAccountSelector();
  wireDateFilter();
  wireEquityTimeframe();
  wireFilterPanel();
  wireCustomRangeModal();
  const refreshBtn = byId("an-refresh-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => recomputeAndRender());
  window.addEventListener("resize", () => {
    Object.values(state.charts).forEach(c => { if (!c.isDisposed()) c.resize(); });
  });
}

/* -----------------------------------------------------------------
   ACCOUNTS (mirrors journal.js — never cross-account, never trusts
   the stale currentBalance field)
   ----------------------------------------------------------------- */
function accountDisplayName(acc) { return (acc && (acc.name || acc.accountName)) || "Untitled Account"; }
function accountBroker(acc) { return (acc && (acc.broker || acc.brokerName || acc.platform)) || ""; }
function accountInitialBalance(acc) { return acc && acc.initialBalance !== undefined ? Number(acc.initialBalance) : 0; }

async function loadAccounts() {
  try {
    const snap = await getDocs(collection(db, "users", state.uid, "accounts"));
    state.accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("Failed to load accounts:", err);
    state.accounts = [];
  }
  renderAccountList();
  populateAccountFilterSelect();

  const saved = localStorage.getItem(`eva-journal-selected-account-${state.uid}`);
  let target = null;
  if (state.accounts.length === 1) target = state.accounts[0].id;
  else if (saved && state.accounts.some(a => a.id === saved)) target = saved;
  else if (state.accounts.length > 0) target = state.accounts[0].id;

  if (target) selectAccount(target);
  else {
    setText("an-account-trigger-name", "No accounts yet");
    setText("an-account-trigger-meta", "");
    showNoDataState();
  }
}

function renderAccountList() {
  const list = byId("an-account-list");
  if (!list) return;
  if (!state.accounts.length) {
    list.innerHTML = `<div class="an-list-empty"><span>No trading accounts yet.</span></div>`;
    return;
  }
  list.innerHTML = state.accounts.map(acc => {
    const active = acc.id === state.selectedAccountId;
    return `<button type="button" class="an-account-item${active ? " an-active" : ""}" data-account-id="${acc.id}" role="option" aria-selected="${active}">
      <span class="an-account-item-name">${escapeHtml(accountDisplayName(acc))}</span>
      <span class="an-account-item-meta">${escapeHtml(accountBroker(acc))}</span>
    </button>`;
  }).join("");
  $all(".an-account-item", list).forEach(btn => {
    btn.addEventListener("click", () => {
      selectAccount(btn.getAttribute("data-account-id"));
      closeAccountPanel();
    });
  });
}

function populateAccountFilterSelect() {
  const sel = byId("an-f-account");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Selected account only</option>` +
    state.accounts.map(a => `<option value="${a.id}">${escapeHtml(accountDisplayName(a))}</option>`).join("");
  sel.value = current;
}

function wireAccountSelector() {
  const trigger = byId("an-account-trigger");
  const panel = byId("an-account-panel");
  const backdrop = byId("an-account-backdrop");
  if (!trigger || !panel) return;
  trigger.addEventListener("click", () => {
    const open = panel.classList.toggle("an-open");
    trigger.setAttribute("aria-expanded", String(open));
    if (backdrop) backdrop.classList.toggle("an-open", open);
  });
  if (backdrop) backdrop.addEventListener("click", closeAccountPanel);
}
function closeAccountPanel() {
  const panel = byId("an-account-panel");
  const trigger = byId("an-account-trigger");
  const backdrop = byId("an-account-backdrop");
  if (panel) panel.classList.remove("an-open");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  if (backdrop) backdrop.classList.remove("an-open");
}

function selectAccount(accountId) {
  if (state.selectedAccountId === accountId) return;
  state.selectedAccountId = accountId;
  document.getElementById("an-root")?.setAttribute("data-account-id", accountId || "");

  if (state.unsubAccount) { state.unsubAccount(); state.unsubAccount = null; }
  if (state.unsubTrades) { state.unsubTrades(); state.unsubTrades = null; }

  const accountRef = doc(db, "users", state.uid, "accounts", accountId);
  state.unsubAccount = onSnapshot(accountRef, (snap) => {
    if (!snap.exists()) return;
    state.selectedAccount = { id: snap.id, ...snap.data() };
    const idx = state.accounts.findIndex(a => a.id === accountId);
    if (idx >= 0) state.accounts[idx] = state.selectedAccount;
    setText("an-account-trigger-name", accountDisplayName(state.selectedAccount));
    setText("an-account-trigger-meta", accountBroker(state.selectedAccount));
    renderAccountList();
    recomputeAndRender(); // balance-dependent stats (equity, drawdown) must refresh
  }, (err) => console.error("Account listener error:", err));

  const tbodyLoading = byId("an-loading-row");
  if (tbodyLoading) tbodyLoading.hidden = false;

  const q = query(collection(db, "users", state.uid, "accounts", accountId, "trades"), orderBy("tradeDate", "desc"));
  state.unsubTrades = onSnapshot(q, (snap) => {
    state.rawTrades = snap.docs.map(d => normalizeTrade({ id: d.id, ...d.data() }));
    if (tbodyLoading) tbodyLoading.hidden = true;
    populateDynamicFilterOptions();
    recomputeAndRender();
  }, (err) => {
    console.error("Trades listener error:", err);
    if (tbodyLoading) tbodyLoading.hidden = true;
  });
}

/* -----------------------------------------------------------------
   DATE-RANGE + FILTER WIRING
   ----------------------------------------------------------------- */
function wireDateFilter() {
  const wrap = byId("an-date-filter");
  if (!wrap) return;
  $all("button", wrap).forEach(btn => {
    btn.addEventListener("click", () => {
      const range = btn.getAttribute("data-range");
      if (range === "custom") { openCustomRangeModal(); return; }
      $all("button", wrap).forEach(b => b.classList.remove("an-active"));
      btn.classList.add("an-active");
      state.dateRange = range;
      recomputeAndRender();
    });
  });
}

function wireCustomRangeModal() {
  const applyBtn = byId("an-custom-range-apply");
  if (applyBtn) applyBtn.addEventListener("click", () => {
    const s = byId("an-custom-start")?.value;
    const e = byId("an-custom-end")?.value;
    if (!s || !e) return;
    state.customStart = new Date(s + "T00:00:00");
    state.customEnd = new Date(e + "T23:59:59");
    state.dateRange = "custom";
    const wrap = byId("an-date-filter");
    if (wrap) { $all("button", wrap).forEach(b => b.classList.remove("an-active")); $('[data-range="custom"]', wrap)?.classList.add("an-active"); }
    closeModal("an-custom-range-modal");
    recomputeAndRender();
  });
  $all('[data-close-modal="an-custom-range-modal"]').forEach(b => b.addEventListener("click", () => closeModal("an-custom-range-modal")));
}
function openCustomRangeModal() {
  const modal = byId("an-custom-range-modal");
  if (!modal) return;
  modal.style.opacity = "1"; modal.style.pointerEvents = "auto"; modal.setAttribute("aria-hidden", "false");
}
function closeModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.style.opacity = "0"; modal.style.pointerEvents = "none"; modal.setAttribute("aria-hidden", "true");
}

function wireEquityTimeframe() {
  const wrap = byId("an-equity-timeframe");
  if (!wrap) return;
  $all("button", wrap).forEach(btn => {
    btn.addEventListener("click", () => {
      $all("button", wrap).forEach(b => b.classList.remove("an-active"));
      btn.classList.add("an-active");
      state.equityTimeframe = btn.getAttribute("data-timeframe");
      renderEquitySection(getFilteredTrades());
    });
  });
}

function wireFilterPanel() {
  const map = {
    "an-f-strategy": "strategy", "an-f-setup": "setup", "an-f-session": "session",
    "an-f-result": "result", "an-f-direction": "direction", "an-f-grade": "grade",
    "an-f-condition": "condition", "an-f-emotion": "emotion", "an-f-discipline": "discipline"
  };
  const applyBtn = byId("an-filters-apply");
  const resetBtn = byId("an-filters-reset");
  const symbolInput = byId("an-f-symbol");
  if (applyBtn) applyBtn.addEventListener("click", () => {
    Object.entries(map).forEach(([id, key]) => { const el = byId(id); if (el) state.filters[key] = el.value; });
    if (symbolInput) state.filters.symbol = symbolInput.value.trim().toUpperCase();
    recomputeAndRender();
  });
  if (resetBtn) resetBtn.addEventListener("click", () => {
    Object.keys(state.filters).forEach(k => state.filters[k] = "");
    Object.keys(map).forEach(id => { const el = byId(id); if (el) el.value = ""; });
    if (symbolInput) symbolInput.value = "";
    recomputeAndRender();
  });
}

/* Populates strategy/setup/session/grade/condition/emotion select options
   from what's actually in this account's trades — never a hardcoded list. */
function populateDynamicFilterOptions() {
  const distinct = (fn) => [...new Set(state.rawTrades.map(fn).filter(Boolean))].sort();
  fillSelect("an-f-strategy", distinct(t => t.strategy), "All strategies");
  fillSelect("an-f-setup", distinct(t => t.setup), "All setups");
  fillSelect("an-f-session", distinct(t => t.session), "All sessions");
  fillSelect("an-f-grade", distinct(t => t.tradeRating), "All grades");
  fillSelect("an-f-condition", distinct(t => t.marketCondition), "All conditions");
  const allEmotions = new Set();
  state.rawTrades.forEach(t => {
    (t.emotionBefore || []).concat(t.emotionDuring || [], t.emotionAfter || []).forEach(e => allEmotions.add(e));
  });
  fillSelect("an-f-emotion", [...allEmotions].sort(), "All emotions");

  const discSel = byId("an-f-discipline");
  if (discSel && state.rawTrades.some(t => t.followedPlan === "Partially") && !$('[value="PARTIAL"]', discSel)) {
    const opt = document.createElement("option");
    opt.value = "PARTIAL"; opt.textContent = "Partially Followed";
    discSel.appendChild(opt);
  }
}
function fillSelect(id, values, allLabel) {
  const sel = byId(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (values.includes(current)) sel.value = current;
}

/* -----------------------------------------------------------------
   FILTERING PIPELINE
   ----------------------------------------------------------------- */
function rangeStartFor(range) {
  const now = new Date();
  const start = new Date(now);
  if (range === "today") { start.setHours(0, 0, 0, 0); return start; }
  if (range === "week") { const day = (start.getDay() + 6) % 7; start.setDate(start.getDate() - day); start.setHours(0, 0, 0, 0); return start; }
  if (range === "month") { start.setDate(1); start.setHours(0, 0, 0, 0); return start; }
  if (range === "quarter") { const q = Math.floor(start.getMonth() / 3); start.setMonth(q * 3, 1); start.setHours(0, 0, 0, 0); return start; }
  if (range === "year") { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); return start; }
  return null; // "all"
}

function getFilteredTrades() {
  let trades = state.rawTrades;

  if (state.dateRange === "custom" && state.customStart && state.customEnd) {
    trades = trades.filter(t => t.date && t.date >= state.customStart && t.date <= state.customEnd);
  } else if (state.dateRange !== "all") {
    const start = rangeStartFor(state.dateRange);
    if (start) trades = trades.filter(t => t.date && t.date >= start);
  }

  const f = state.filters;
  if (f.strategy) trades = trades.filter(t => t.strategy === f.strategy);
  if (f.setup) trades = trades.filter(t => t.setup === f.setup);
  if (f.session) trades = trades.filter(t => t.session === f.session);
  if (f.result) trades = trades.filter(t => t.classification === (f.result === "BE" ? "BREAK-EVEN" : f.result));
  if (f.symbol) trades = trades.filter(t => (t.instrument || "").toUpperCase().includes(f.symbol));
  if (f.direction) trades = trades.filter(t => t.direction === f.direction);
  if (f.grade) trades = trades.filter(t => t.tradeRating === f.grade);
  if (f.condition) trades = trades.filter(t => t.marketCondition === f.condition);
  if (f.emotion) trades = trades.filter(t => (t.emotionBefore || []).concat(t.emotionDuring || [], t.emotionAfter || []).includes(f.emotion));
  if (f.discipline === "FOLLOWED") trades = trades.filter(t => t.followedPlan === "Yes");
  if (f.discipline === "BROKE") trades = trades.filter(t => t.followedPlan === "No");
  if (f.discipline === "PARTIAL") trades = trades.filter(t => t.followedPlan === "Partially");

  return trades;
}

function showNoDataState() {
  setText("an-summary-trades", "0");
  setText("an-summary-pl", "$0.00");
  setText("an-summary-winrate", "—");
  setText("an-summary-pf", "—");
  ["stat-total-trades","stat-net-pl","stat-win-rate","stat-avg-win","stat-avg-loss","stat-profit-factor",
    "stat-expectancy","stat-avg-r","stat-max-drawdown","stat-best-trade","stat-worst-trade",
    "stat-winning-trades","stat-losing-trades","stat-breakeven-trades"].forEach(id => setText(id, "—"));
  const eq = byId("an-equity-chart");
  if (eq) eq.innerHTML = `<div class="an-chart-empty"><span>No trading data yet.</span></div>`;
}

/* -----------------------------------------------------------------
   MAIN RECOMPUTE + RENDER PIPELINE
   Runs on: account change, filter change, date-range change, and
   automatically on every realtime add/edit/delete (onSnapshot above).
   ----------------------------------------------------------------- */
function recomputeAndRender() {
  if (!state.selectedAccountId) { showNoDataState(); return; }
  const trades = getFilteredTrades();
  const stats = calculateStatistics(trades);
  const initialBalance = accountInitialBalance(state.selectedAccount);
  const equity = calculateEquity(trades, initialBalance);
  const drawdown = calculateDrawdown(equity);

  renderSummaryStrip(trades, stats);
  renderKpiGrid(stats, drawdown);
  renderEquitySection(trades, equity, drawdown);
  renderStrategySection(trades);
  renderSetupSection(trades);
  renderSessionSection(trades);
  renderDaySection(trades);
  renderTimeSection(trades);
  renderMonthlyWeeklySection(trades);
  renderWinLossSection(trades, stats);
  renderRiskRewardSection(trades);
  renderDrawdownSection(drawdown, trades);
  renderGradeSection(trades);
  renderDisciplineSection(trades);
  renderEmotionSection(trades);
  renderConditionSection(trades);
  renderLongShortSection(trades);
  renderBestWorstInsights(trades);
  renderMistakes(trades);
  renderEdgeAndImprove(trades);

  const summarySub = byId("an-filter-summary");
  if (summarySub) summarySub.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"} match current filters`;
}

/* ---------- Summary strip + KPI grid ---------- */
function renderSummaryStrip(trades, stats) {
  setText("an-summary-trades", String(stats.total));
  setText("an-summary-pl", fmtMoney(stats.netPL));
  setText("an-summary-winrate", stats.winRate === null ? "—" : fmtPct(stats.winRate));
  setText("an-summary-pf", stats.profitFactor === null ? "—" : (isFinite(stats.profitFactor) ? fmtNum(stats.profitFactor) : "∞"));
  const rangeLabel = { today: "Today", week: "This Week", month: "This Month", quarter: "This Quarter", year: "This Year", all: "All Time", custom: "Custom Range" }[state.dateRange] || "All Time";
  setText("an-summary-range", rangeLabel);
}

function renderKpiGrid(stats, drawdown) {
  setText("stat-total-trades", stats.total ? String(stats.total) : "No trading data yet.");
  setText("stat-net-pl", fmtMoney(stats.netPL));
  setText("stat-win-rate", stats.winRate === null ? "—" : fmtPct(stats.winRate));
  setText("stat-avg-win", stats.avgWin === null ? "—" : fmtMoney(stats.avgWin));
  setText("stat-avg-loss", stats.avgLoss === null ? "—" : fmtMoney(stats.avgLoss));
  setText("stat-profit-factor", stats.profitFactor === null ? "—" : (isFinite(stats.profitFactor) ? fmtNum(stats.profitFactor) : "∞"));
  setText("stat-expectancy", stats.expectancy === null ? "—" : fmtMoney(stats.expectancy));
  setText("stat-avg-r", stats.avgR === null ? "Not enough data" : `${fmtNum(stats.avgR)}R`);
  setText("stat-max-drawdown", fmtBalance(maxDrawdownOf(drawdown)));
  setText("stat-best-trade", stats.bestTrade ? fmtMoney(stats.bestTrade.plSigned) : "—");
  setText("stat-worst-trade", stats.worstTrade ? fmtMoney(stats.worstTrade.plSigned) : "—");
  setText("stat-winning-trades", String(stats.wins));
  setText("stat-losing-trades", String(stats.losses));
  setText("stat-breakeven-trades", String(stats.be));
}

/* ---------- Equity & cumulative P/L ---------- */
function equityFilteredByTimeframe(equity) {
  if (state.equityTimeframe === "ALL" || !equity.length) return equity;
  const now = new Date();
  const days = { "1D": 1, "1W": 7, "1M": 30, "3M": 90 }[state.equityTimeframe];
  let start;
  if (state.equityTimeframe === "YTD") { start = new Date(now.getFullYear(), 0, 1); }
  else if (days) { start = new Date(now); start.setDate(start.getDate() - days); }
  if (!start) return equity;
  const startPoint = equity[0];
  return [startPoint, ...equity.filter(p => p.date && p.date >= start)];
}

function renderEquitySection(trades, equity, drawdown) {
  if (!equity) {
    const initialBalance = accountInitialBalance(state.selectedAccount);
    equity = calculateEquity(trades, initialBalance);
  }
  const shown = equityFilteredByTimeframe(equity);
  const sub = byId("an-equity-sub");
  if (sub) sub.textContent = trades.length ? "Performance trend over the selected range." : "No trading data yet.";
  if (shown.length <= 1) {
    renderChart("an-equity-chart", () => null, "No trading data yet.");
    return;
  }
  renderChart("an-equity-chart", () => lineOption(
    shown.map(p => p.date ? fmtDate(p.date) : "Start"),
    [{ name: "Equity", data: shown.map(p => Number(p.balance.toFixed(2))), color: NEU_COLOR, area: true }]
  ));
}

/* ---------- Per-dimension stat helper ---------- */
function statsForGroups(map) {
  return [...map.entries()].map(([key, groupTrades]) => ({ key, trades: groupTrades, stats: calculateStatistics(groupTrades) }));
}

/* ---------- Strategy ---------- */
function renderStrategySection(trades) {
  const groups = statsForGroups(groupBy(trades, t => t.strategy));
  const { best, worst, insufficientData } = bestWorstFromGroups(groups);
  setText("an-best-strategy", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  setText("an-worst-strategy", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  const eligible = groups.filter(g => g.stats.total >= MIN_SAMPLE);
  const mostConsistent = eligible.length ? eligible.reduce((a, b) => stdev(a.trades.map(t => t.plSigned)) <= stdev(b.trades.map(t => t.plSigned)) ? a : b) : null;
  const highestWinRate = eligible.length ? eligible.reduce((a, b) => (a.stats.winRate || 0) >= (b.stats.winRate || 0) ? a : b) : null;
  const highestProfit = groups.length ? groups.reduce((a, b) => a.stats.netPL >= b.stats.netPL ? a : b) : null;
  setText("an-consistent-strategy", mostConsistent ? mostConsistent.key : "Not enough data");
  setText("an-winrate-strategy", highestWinRate ? `${highestWinRate.key} (${fmtPct(highestWinRate.stats.winRate)})` : "Not enough data");
  setText("an-profit-strategy", highestProfit ? `${highestProfit.key} (${fmtMoney(highestProfit.stats.netPL)})` : "—");

  const cats = groups.map(g => g.key);
  renderChart("an-strategy-pl-chart", () => cats.length ? barOption(cats, [{ name: "Net P/L", data: groups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null, "No strategy data yet.");
  renderChart("an-strategy-winrate-chart", () => cats.length ? barOption(cats, [{ name: "Win Rate %", data: groups.map(g => g.stats.winRate === null ? 0 : Number(g.stats.winRate.toFixed(1))), color: NEU_COLOR }]) : null, "No strategy data yet.");
  renderChart("an-strategy-count-chart", () => cats.length ? barOption(cats, [{ name: "Trades", data: groups.map(g => g.stats.total), color: NEU_COLOR }]) : null);
  renderChart("an-strategy-avgr-chart", () => cats.length ? barOption(cats, [{ name: "Avg R", data: groups.map(g => g.stats.avgR === null ? 0 : Number(g.stats.avgR.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
  renderChart("an-strategy-pf-chart", () => cats.length ? barOption(cats, [{ name: "Profit Factor", data: groups.map(g => g.stats.profitFactor === null ? 0 : (isFinite(g.stats.profitFactor) ? Number(g.stats.profitFactor.toFixed(2)) : 0)), color: NEU_COLOR }]) : null);

  renderCatList("an-strategy-list", groups, "strategy");
}

function renderCatList(containerId, groups, dimLabel) {
  const el = byId(containerId);
  if (!el) return;
  if (!groups.length) { el.innerHTML = `<div class="an-list-empty"><span>No ${dimLabel} data yet.</span></div>`; return; }
  const sorted = [...groups].sort((a, b) => b.stats.netPL - a.stats.netPL);
  el.innerHTML = sorted.map(g => `
    <button type="button" class="an-cat-row" data-drill="${dimLabel}" data-key="${escapeHtml(g.key)}">
      <span class="an-cat-name">${escapeHtml(g.key)}</span>
      <span class="an-cat-count">${g.stats.total} trade${g.stats.total === 1 ? "" : "s"}</span>
      <span class="an-cat-winrate">${g.stats.winRate === null ? "—" : fmtPct(g.stats.winRate)}</span>
      <span class="an-cat-pl ${g.stats.netPL >= 0 ? "an-pos" : "an-neg"}">${fmtMoney(g.stats.netPL)}</span>
    </button>`).join("");
  $all(".an-cat-row", el).forEach(row => row.addEventListener("click", () => {
    const key = row.getAttribute("data-key");
    const group = groups.find(g => g.key === key);
    if (group) openDrilldown(`${dimLabel}: ${key}`, group.trades);
  }));
}

/* ---------- Setup ---------- */
function renderSetupSection(trades) {
  const groups = statsForGroups(groupBy(trades, t => t.setup));
  const { best, worst, insufficientData } = bestWorstFromGroups(groups);
  setText("an-best-setup", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  setText("an-worst-setup", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  const cats = groups.map(g => g.key);
  renderChart("an-setup-pl-chart", () => cats.length ? barOption(cats, [{ name: "Net P/L", data: groups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
  renderChart("an-setup-winrate-chart", () => cats.length ? barOption(cats, [{ name: "Win Rate %", data: groups.map(g => g.stats.winRate === null ? 0 : Number(g.stats.winRate.toFixed(1))), color: NEU_COLOR }]) : null);
  renderChart("an-setup-avgr-chart", () => cats.length ? barOption(cats, [{ name: "Avg R", data: groups.map(g => g.stats.avgR === null ? 0 : Number(g.stats.avgR.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
  const sub = byId("an-setup-consistency-sub");
  if (sub) sub.textContent = groups.length ? "Consistency & frequency shown per setup." : "No setup data yet.";
  renderCatList("an-setup-list", groups, "setup");
}

/* ---------- Session (fixed cards: Asian / London / NY-AM / NY-PM) ---------- */
function sessionBucket(trade) {
  const s = (trade.session || "").toLowerCase();
  if (s === "asia") return "asian";
  if (s === "london") return "london";
  if (s === "new york") return "ny-all"; // real data has no AM/PM split — see below
  return null;
}
function renderSessionSection(trades) {
  const buckets = { asian: [], london: [], "ny-am": [], "ny-pm": [] };
  const nyTrades = [];
  trades.forEach(t => {
    const s = (t.session || "").toLowerCase();
    if (s === "asia") buckets.asian.push(t);
    else if (s === "london") buckets.london.push(t);
    else if (s === "new york") nyTrades.push(t);
  });
  ["asian", "london"].forEach(key => fillSessionCard(key, buckets[key]));
  // Honest handling of the AM/PM mismatch: the journal only stores "New York"
  // with no AM/PM split, so that card shows the real combined data and the
  // PM card is explicitly marked as not tracked rather than fabricated.
  fillSessionCard("ny-am", nyTrades, "New York (combined — no AM/PM split in journal)");
  fillSessionCard("ny-pm", [], null, "Not tracked — journal only stores a single \"New York\" session");

  const extra = byId("an-session-extra-list");
  if (extra) {
    const groups = [
      { key: "Asian", trades: buckets.asian, stats: calculateStatistics(buckets.asian) },
      { key: "London", trades: buckets.london, stats: calculateStatistics(buckets.london) },
      { key: "New York", trades: nyTrades, stats: calculateStatistics(nyTrades) }
    ].filter(g => g.stats.total > 0);
    renderCatList("an-session-extra-list", groups, "session");
  }
}
function fillSessionCard(key, trades, overrideNote, forceNotTracked) {
  const stats = calculateStatistics(trades);
  const plEl = document.querySelector(`[data-session-pl="${key}"]`);
  const wrEl = document.querySelector(`[data-session-winrate="${key}"]`);
  const cntEl = document.querySelector(`[data-session-count="${key}"]`);
  const rEl = document.querySelector(`[data-session-avgr="${key}"]`);
  if (forceNotTracked) {
    if (plEl) plEl.textContent = "Not tracked";
    if (wrEl) wrEl.textContent = "Not tracked";
    if (cntEl) cntEl.textContent = "—";
    if (rEl) rEl.textContent = "—";
    return;
  }
  if (plEl) plEl.textContent = stats.total ? fmtMoney(stats.netPL) : "—";
  if (wrEl) wrEl.textContent = stats.total ? fmtPct(stats.winRate) : "—";
  if (cntEl) cntEl.textContent = String(stats.total);
  if (rEl) rEl.textContent = stats.avgR === null ? "—" : `${fmtNum(stats.avgR)}R`;
}

/* ---------- Day of week (Mon-Fri only, per spec) ---------- */
const DOW_KEYS = ["mon", "tue", "wed", "thu", "fri"];
function renderDaySection(trades) {
  const byDay = { mon: [], tue: [], wed: [], thu: [], fri: [] };
  trades.forEach(t => {
    if (!t.date) return;
    const idx = t.date.getDay(); // 0=Sun..6=Sat
    const key = ["sun","mon","tue","wed","thu","fri","sat"][idx];
    if (byDay[key]) byDay[key].push(t);
  });
  const groups = DOW_KEYS.map(key => ({ key, trades: byDay[key], stats: calculateStatistics(byDay[key]) }));
  groups.forEach(g => {
    const cnt = document.querySelector(`[data-day-count="${g.key}"]`);
    const pl = document.querySelector(`[data-day-pl="${g.key}"]`);
    const wr = document.querySelector(`[data-day-winrate="${g.key}"]`);
    const avg = document.querySelector(`[data-day-avg="${g.key}"]`);
    if (cnt) cnt.textContent = String(g.stats.total);
    if (pl) pl.textContent = g.stats.total ? fmtMoney(g.stats.netPL) : "—";
    if (wr) wr.textContent = g.stats.total ? fmtPct(g.stats.winRate) : "—";
    if (avg) avg.textContent = g.stats.total ? fmtMoney(g.stats.netPL / g.stats.total) : "—";
  });
  const named = groups.map(g => ({ key: { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday" }[g.key], trades: g.trades, stats: g.stats }));
  const { best, worst, insufficientData } = bestWorstFromGroups(named);
  setText("an-best-day", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  setText("an-worst-day", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
}

/* ---------- Time / hour of day ---------- */
function parseHour(entryTime) {
  if (!entryTime || typeof entryTime !== "string") return null;
  const m = entryTime.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return (h >= 0 && h <= 23) ? h : null;
}
function renderTimeSection(trades) {
  const withHour = trades.map(t => ({ ...t, hour: parseHour(t.entryTime) })).filter(t => t.hour !== null);
  if (withHour.length < MIN_SAMPLE) {
    ["an-best-hour", "an-worst-hour", "an-best-window", "an-worst-window"].forEach(id => setText(id, "Not enough data"));
    renderChart("an-hour-pl-chart", () => null, "Not enough entry-time data logged yet.");
    renderChart("an-hour-winrate-chart", () => null, "Not enough entry-time data logged yet.");
    renderChart("an-hour-freq-chart", () => null, "Not enough entry-time data logged yet.");
    return;
  }
  const byHour = groupBy(withHour, t => String(t.hour).padStart(2, "0") + ":00");
  const groups = statsForGroups(byHour).sort((a, b) => a.key.localeCompare(b.key));
  const { best, worst } = bestWorstFromGroups(groups, "netPL", 3);
  setText("an-best-hour", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : "Not enough data");
  setText("an-worst-hour", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : "Not enough data");
  setText("an-best-window", best ? best.key : "Not enough data");
  setText("an-worst-window", worst ? worst.key : "Not enough data");
  const cats = groups.map(g => g.key);
  renderChart("an-hour-pl-chart", () => barOption(cats, [{ name: "P/L", data: groups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]));
  renderChart("an-hour-winrate-chart", () => barOption(cats, [{ name: "Win Rate %", data: groups.map(g => g.stats.winRate === null ? 0 : Number(g.stats.winRate.toFixed(1))), color: NEU_COLOR }]));
  renderChart("an-hour-freq-chart", () => barOption(cats, [{ name: "Trades", data: groups.map(g => g.stats.total), color: NEU_COLOR }]));
}

/* ---------- Monthly / Weekly ---------- */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
function renderMonthlyWeeklySection(trades) {
  const dated = trades.filter(t => t.date);
  const byMonth = groupBy(dated, t => `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`);
  const byWeek = groupBy(dated, t => isoWeekKey(t.date));
  const monthGroups = statsForGroups(byMonth).sort((a, b) => a.key.localeCompare(b.key));
  const weekGroups = statsForGroups(byWeek).sort((a, b) => a.key.localeCompare(b.key));

  renderChart("an-monthly-pl-chart", () => monthGroups.length ? barOption(monthGroups.map(g => g.key), [{ name: "Monthly P/L", data: monthGroups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
  renderChart("an-weekly-pl-chart", () => weekGroups.length ? barOption(weekGroups.map(g => g.key), [{ name: "Weekly P/L", data: weekGroups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
  renderChart("an-monthly-winrate-chart", () => monthGroups.length ? lineOption(monthGroups.map(g => g.key), [{ name: "Win Rate %", data: monthGroups.map(g => g.stats.winRate === null ? 0 : Number(g.stats.winRate.toFixed(1))), color: NEU_COLOR }]) : null);
  const consistencyData = monthGroups.map(g => Number(stdev(g.trades.map(t => t.plSigned)).toFixed(2)));
  renderChart("an-consistency-chart", () => monthGroups.length ? barOption(monthGroups.map(g => g.key), [{ name: "P/L Std Dev", data: consistencyData, color: NEU_COLOR }]) : null);
}

/* ---------- Win vs Loss ---------- */
function renderWinLossSection(trades, stats) {
  setText("an-wl-wins", String(stats.wins));
  setText("an-wl-losses", String(stats.losses));
  setText("an-wl-be", String(stats.be));
  const ratio = (stats.avgWin !== null && stats.avgLoss) ? Math.abs(stats.avgWin / stats.avgLoss) : null;
  setText("an-wl-ratio", ratio === null ? "—" : `${fmtNum(ratio)} : 1`);
  setText("an-wl-avgwin", stats.avgWin === null ? "—" : fmtMoney(stats.avgWin));
  setText("an-wl-avgloss", stats.avgLoss === null ? "—" : fmtMoney(stats.avgLoss));
  setText("an-wl-largestwin", stats.largestWin === null ? "—" : fmtMoney(stats.largestWin));
  setText("an-wl-largestloss", stats.largestLoss === null ? "—" : fmtMoney(stats.largestLoss));
  renderChart("an-winloss-chart", () => stats.total ? pieOption([
    { name: "Wins", value: stats.wins, itemStyle: { color: POS_COLOR } },
    { name: "Losses", value: stats.losses, itemStyle: { color: NEG_COLOR } },
    { name: "Break-Even", value: stats.be, itemStyle: { color: "#8a93a6" } }
  ]) : null);
}

/* ---------- Risk / Reward ---------- */
function renderRiskRewardSection(trades) {
  const withR = trades.filter(t => t.rMultiple !== null && isFinite(t.rMultiple));
  const withRisk = trades.filter(t => t.risk !== null && t.risk > 0);
  const avgR = withR.length ? withR.reduce((s, t) => s + t.rMultiple, 0) / withR.length : null;
  setText("an-rr-avgr", avgR === null ? "Not enough data" : `${fmtNum(avgR)}R`);
  const riskCV = withRisk.length > 1 ? stdev(withRisk.map(t => t.risk)) / (withRisk.reduce((s, t) => s + t.risk, 0) / withRisk.length) : null;
  setText("an-rr-riskcons", riskCV === null ? "Not enough data" : fmtPct((1 - Math.min(riskCV, 1)) * 100));
  const rewardVals = withR.map(t => t.rMultiple).filter(r => r > 0);
  const rewardCV = rewardVals.length > 1 ? stdev(rewardVals) / (rewardVals.reduce((s, r) => s + r, 0) / rewardVals.length) : null;
  setText("an-rr-rewardcons", rewardCV === null ? "Not enough data" : fmtPct((1 - Math.min(rewardCV, 1)) * 100));

  if (withR.length < MIN_SAMPLE) {
    ["an-r-dist-chart", "an-r-dist-win-chart", "an-r-dist-loss-chart"].forEach(id => renderChart(id, () => null, "Not enough R-multiple data logged yet."));
    return;
  }
  const buckets = ["<-2R","-2R to -1R","-1R to 0R","0R to 1R","1R to 2R","2R to 3R",">3R"];
  const bucketOf = r => r < -2 ? 0 : r < -1 ? 1 : r < 0 ? 2 : r < 1 ? 3 : r < 2 ? 4 : r < 3 ? 5 : 6;
  const counts = new Array(7).fill(0);
  withR.forEach(t => counts[bucketOf(t.rMultiple)]++);
  renderChart("an-r-dist-chart", () => barOption(buckets, [{ name: "Trades", data: counts, color: NEU_COLOR }]));
  const winCounts = new Array(7).fill(0), lossCounts = new Array(7).fill(0);
  withR.forEach(t => { if (t.classification === "WIN") winCounts[bucketOf(t.rMultiple)]++; else if (t.classification === "LOSS") lossCounts[bucketOf(t.rMultiple)]++; });
  renderChart("an-r-dist-win-chart", () => barOption(buckets, [{ name: "Wins", data: winCounts, color: POS_COLOR }]));
  renderChart("an-r-dist-loss-chart", () => barOption(buckets, [{ name: "Losses", data: lossCounts, color: NEG_COLOR }]));
}

/* ---------- Drawdown ---------- */
function longestDrawdownPeriodDays(equityWithDD) {
  let longest = 0, currentStart = null;
  for (const p of equityWithDD) {
    if (p.drawdown > 0) {
      if (!currentStart) currentStart = p.date;
    } else if (currentStart) {
      const days = p.date && currentStart ? Math.round((p.date - currentStart) / 86400000) : 0;
      longest = Math.max(longest, days);
      currentStart = null;
    }
  }
  return longest;
}
function renderDrawdownSection(drawdown, trades) {
  if (!trades.length) {
    renderChart("an-drawdown-chart", () => null, "Drawdown history will appear here once trades are logged.");
    ["an-dd-max","an-dd-avg","an-dd-longest","an-dd-recovery","an-dd-frequency"].forEach(id => setText(id, "—"));
    return;
  }
  const ddValues = drawdown.map(p => p.drawdown);
  const maxDD = Math.max(...ddValues);
  const nonZero = ddValues.filter(v => v > 0);
  const avgDD = nonZero.length ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length : 0;
  const longestDays = longestDrawdownPeriodDays(drawdown);
  const netPL = trades.reduce((s, t) => s + t.plSigned, 0);
  const recoveryFactor = maxDD > 0 ? netPL / maxDD : null;
  let ddPeriods = 0, inDD = false;
  ddValues.forEach(v => { if (v > 0 && !inDD) { ddPeriods++; inDD = true; } else if (v === 0) inDD = false; });

  setText("an-dd-max", fmtBalance(maxDD));
  setText("an-dd-avg", fmtBalance(avgDD));
  setText("an-dd-longest", `${longestDays} day${longestDays === 1 ? "" : "s"}`);
  setText("an-dd-recovery", recoveryFactor === null ? "—" : fmtNum(recoveryFactor));
  setText("an-dd-frequency", String(ddPeriods));

  renderChart("an-drawdown-chart", () => lineOption(
    drawdown.map(p => p.date ? fmtDate(p.date) : "Start"),
    [{ name: "Drawdown", data: drawdown.map(p => -Number(p.drawdown.toFixed(2))), color: NEG_COLOR, area: true }]
  ));
}

/* ---------- Trade Grade (A+/A/B/C) ---------- */
const GRADE_MAP = { "A+": "a-plus", "A": "a", "B": "b", "C": "c" };
function renderGradeSection(trades) {
  const groups = Object.entries(GRADE_MAP).map(([label, key]) => {
    const g = trades.filter(t => t.tradeRating === label);
    return { label, key, stats: calculateStatistics(g), trades: g };
  });
  groups.forEach(g => {
    const pl = document.querySelector(`[data-grade-pl="${g.key}"]`);
    const wr = document.querySelector(`[data-grade-winrate="${g.key}"]`);
    const r = document.querySelector(`[data-grade-avgr="${g.key}"]`);
    const cnt = document.querySelector(`[data-grade-count="${g.key}"]`);
    if (pl) pl.textContent = g.stats.total ? fmtMoney(g.stats.netPL) : "—";
    if (wr) wr.textContent = g.stats.total ? fmtPct(g.stats.winRate) : "—";
    if (r) r.textContent = g.stats.avgR === null ? "—" : `${fmtNum(g.stats.avgR)}R`;
    if (cnt) cnt.textContent = String(g.stats.total);
  });
  const named = groups.map(g => ({ key: g.label, trades: g.trades, stats: g.stats }));
  const { best, worst, insufficientData } = bestWorstFromGroups(named, "netPL", 3);
  setText("an-best-grade", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  setText("an-worst-grade", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
}

/* ---------- Discipline ---------- */
function renderDisciplineSection(trades) {
  const followed = trades.filter(t => t.followedPlan === "Yes");
  const broke = trades.filter(t => t.followedPlan === "No");
  const partial = trades.filter(t => t.followedPlan === "Partially");
  const fStats = calculateStatistics(followed), bStats = calculateStatistics(broke);
  setText("an-disc-followed-count", String(fStats.total));
  setText("an-disc-followed-pl", fmtMoney(fStats.netPL));
  setText("an-disc-followed-winrate", fStats.total ? fmtPct(fStats.winRate) : "—");
  setText("an-disc-followed-avgr", fStats.avgR === null ? "—" : `${fmtNum(fStats.avgR)}R`);
  setText("an-disc-broke-count", String(bStats.total));
  setText("an-disc-broke-pl", fmtMoney(bStats.netPL));
  setText("an-disc-broke-winrate", bStats.total ? fmtPct(bStats.winRate) : "—");
  setText("an-disc-broke-avgr", bStats.avgR === null ? "—" : `${fmtNum(bStats.avgR)}R`);

  renderChart("an-discipline-pl-chart", () => (fStats.total || bStats.total) ? barOption(
    ["Followed Plan", "Partially", "Broke Plan"],
    [{ name: "Net P/L", data: [fStats.netPL, calculateStatistics(partial).netPL, bStats.netPL].map(v => Number(v.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]
  ) : null);

  const list = byId("an-rule-violations-list");
  if (list) {
    if (!bStats.total && !partial.length) {
      list.innerHTML = `<div class="an-list-empty"><span>No plan violations logged yet.</span></div>`;
    } else {
      const rows = [];
      if (bStats.total) rows.push({ key: "Broke Plan", trades: broke, stats: bStats });
      if (partial.length) rows.push({ key: "Partially Followed", trades: partial, stats: calculateStatistics(partial) });
      renderCatList("an-rule-violations-list", rows, "discipline");
    }
  }
}

/* ---------- Emotion (only real vocab — never fabricated) ---------- */
const EMOTION_VOCAB = new Set(["Calm", "Anxious", "Confident", "Tired", "Excited", "Rushed", "Patient", "Nervous", "Over-confident", "Stressed", "Detached", "FOMO", "Satisfied", "Regretful", "Relieved", "Frustrated", "Neutral", "Disciplined"]);
const EMOTION_CARD_MAP = { calm: "Calm", confident: "Confident", fear: null, greed: null, revenge: null, fomo: "FOMO", hesitation: null };
function renderEmotionSection(trades) {
  const allEmotionTrades = (emotion) => trades.filter(t => (t.emotionBefore || []).concat(t.emotionDuring || [], t.emotionAfter || []).includes(emotion));
  const groups = [];
  Object.entries(EMOTION_CARD_MAP).forEach(([key, label]) => {
    const freqEl = document.querySelector(`[data-emotion-freq="${key}"]`);
    const plEl = document.querySelector(`[data-emotion-pl="${key}"]`);
    const wrEl = document.querySelector(`[data-emotion-winrate="${key}"]`);
    if (label === null) {
      // Not in the journal's actual chip vocabulary — say so honestly instead of fabricating.
      if (freqEl) freqEl.textContent = "Not tracked";
      if (plEl) plEl.textContent = "Not tracked";
      if (wrEl) wrEl.textContent = "Not tracked";
      return;
    }
    const g = allEmotionTrades(label);
    const stats = calculateStatistics(g);
    if (g.length) groups.push({ key: label, trades: g, stats });
    if (freqEl) freqEl.textContent = String(g.length);
    if (plEl) plEl.textContent = g.length ? fmtMoney(stats.netPL) : "—";
    if (wrEl) wrEl.textContent = g.length ? fmtPct(stats.winRate) : "—";
  });
  const { best, worst, insufficientData } = bestWorstFromGroups(groups, "netPL", 3);
  setText("an-best-emotion", best ? `${best.key} (${fmtMoney(best.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
  setText("an-worst-emotion", worst ? `${worst.key} (${fmtMoney(worst.stats.netPL)})` : (insufficientData ? "Not enough data" : "—"));
}

/* ---------- Market Condition (Trending/Ranging/Volatile — matches real data) ---------- */
function renderConditionSection(trades) {
  const groups = statsForGroups(groupBy(trades, t => t.marketCondition));
  const cats = groups.map(g => g.key);
  renderChart("an-condition-chart", () => cats.length ? barOption(cats, [{ name: "Net P/L", data: groups.map(g => Number(g.stats.netPL.toFixed(2))), colorFn: v => v >= 0 ? POS_COLOR : NEG_COLOR }]) : null);
}

/* ---------- Long vs Short ---------- */
function renderLongShortSection(trades) {
  const long = trades.filter(t => t.direction === "LONG");
  const short = trades.filter(t => t.direction === "SHORT");
  const lStats = calculateStatistics(long), sStats = calculateStatistics(short);
  setText("an-long-count", String(lStats.total));
  setText("an-long-pl", fmtMoney(lStats.netPL));
  setText("an-long-winrate", lStats.total ? fmtPct(lStats.winRate) : "—");
  setText("an-long-avgr", lStats.avgR === null ? "—" : `${fmtNum(lStats.avgR)}R`);
  setText("an-short-count", String(sStats.total));
  setText("an-short-pl", fmtMoney(sStats.netPL));
  setText("an-short-winrate", sStats.total ? fmtPct(sStats.winRate) : "—");
  setText("an-short-avgr", sStats.avgR === null ? "—" : `${fmtNum(sStats.avgR)}R`);
}

/* ---------- Best & Worst Trade Insights (across all dimensions) ---------- */
function topByPL(groups, dir = "best", minSample = MIN_SAMPLE) {
  const eligible = groups.filter(g => g.stats.total >= minSample);
  if (!eligible.length) return null;
  return dir === "best" ? eligible.reduce((a, b) => a.stats.netPL >= b.stats.netPL ? a : b) : eligible.reduce((a, b) => a.stats.netPL <= b.stats.netPL ? a : b);
}
function renderBestWorstInsights(trades) {
  const stats = calculateStatistics(trades);
  setText("an-ib-best-trade", stats.bestTrade ? `${stats.bestTrade.instrument || "Trade"} (${fmtMoney(stats.bestTrade.plSigned)})` : "—");
  setText("an-ib-worst-trade", stats.worstTrade ? `${stats.worstTrade.instrument || "Trade"} (${fmtMoney(stats.worstTrade.plSigned)})` : "—");

  const setupGroups = statsForGroups(groupBy(trades, t => t.setup));
  const bestSetup = topByPL(setupGroups, "best"), worstSetup = topByPL(setupGroups, "worst");
  setText("an-ib-best-setup", bestSetup ? bestSetup.key : "Not enough data");
  setText("an-ib-worst-setup", worstSetup ? worstSetup.key : "Not enough data");

  const stratGroups = statsForGroups(groupBy(trades, t => t.strategy));
  const bestStrat = topByPL(stratGroups, "best"), worstStrat = topByPL(stratGroups, "worst");
  setText("an-ib-best-strategy", bestStrat ? bestStrat.key : "Not enough data");
  setText("an-ib-worst-strategy", worstStrat ? worstStrat.key : "Not enough data");

  const sessionGroups = statsForGroups(groupBy(trades, t => t.session));
  const bestSession = topByPL(sessionGroups, "best"), worstSession = topByPL(sessionGroups, "worst");
  setText("an-ib-best-session", bestSession ? bestSession.key : "Not enough data");
  setText("an-ib-worst-session", worstSession ? worstSession.key : "Not enough data");

  const dayGroups = statsForGroups(groupBy(trades.filter(t => t.date), t => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.date.getDay()]));
  const bestDay = topByPL(dayGroups, "best"), worstDay = topByPL(dayGroups, "worst");
  setText("an-ib-best-day", bestDay ? bestDay.key : "Not enough data");
  setText("an-ib-worst-day", worstDay ? worstDay.key : "Not enough data");
}

/* ---------- Trading Mistakes (heuristic, evidence-based, real fields only) ---------- */
function renderMistakes(trades) {
  const setCount = (key, n) => { const el = document.querySelector(`[data-mistake="${key}"]`); if (el) el.textContent = String(n); };

  // Overtrading: days with trade count more than 1.5x the account's average daily count
  const byDate = groupBy(trades.filter(t => t.date), t => t.date.toDateString());
  const dailyCounts = [...byDate.values()].map(arr => arr.length);
  const avgDaily = dailyCounts.length ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0;
  const overtradingDays = dailyCounts.filter(c => avgDaily > 0 && c > avgDaily * 1.5).length;
  setCount("overtrading", dailyCounts.length >= STREAK_MIN_SAMPLE ? overtradingDays : 0);

  // Low-quality setups: losing trades graded B or C
  setCount("low-quality-setups", trades.filter(t => t.classification === "LOSS" && (t.tradeRating === "B" || t.tradeRating === "C")).length);

  // Poor risk management: risk far above this account's median risk
  const risks = trades.filter(t => t.risk !== null && t.risk > 0).map(t => t.risk).sort((a, b) => a - b);
  const median = risks.length ? risks[Math.floor(risks.length / 2)] : null;
  setCount("poor-risk", median ? trades.filter(t => t.risk !== null && t.risk > median * 2).length : 0);

  // Revenge trading: another trade opened same day within 30 min of a loss (needs entryTime)
  let revengeCount = 0;
  [...byDate.values()].forEach(dayTrades => {
    const timed = dayTrades.map(t => ({ t, mins: parseHour(t.entryTime) !== null ? toMinutes(t.entryTime) : null })).filter(x => x.mins !== null).sort((a, b) => a.mins - b.mins);
    for (let i = 1; i < timed.length; i++) {
      if (timed[i - 1].t.classification === "LOSS" && (timed[i].mins - timed[i - 1].mins) <= 30) revengeCount++;
    }
  });
  setCount("revenge-trading", revengeCount);

  // FOMO entries: FOMO chip present in any emotion field
  setCount("fomo", trades.filter(t => (t.emotionBefore || []).concat(t.emotionDuring || [], t.emotionAfter || []).includes("FOMO")).length);

  // Outside preferred session: session missing/unrecognized
  setCount("outside-session", trades.filter(t => !["Asia", "London", "New York"].includes(t.session)).length);

  // Broke trading plan
  setCount("broke-plan", trades.filter(t => t.followedPlan === "No").length);

  // Poor entry/exit timing: keyword mentions in the free-text mistakes field (approximate, not a structured field)
  const mentionsOf = (word) => trades.filter(t => typeof t.mistakes === "string" && t.mistakes.toLowerCase().includes(word)).length;
  setCount("poor-entry", mentionsOf("entry"));
  setCount("poor-exit", mentionsOf("exit"));

  // Excessive losses: trades that are part of a losing streak of 3+
  const chrono = [...trades].filter(t => t.date).sort((a, b) => a.date - b.date);
  let streak = 0, excessiveLossTrades = 0;
  chrono.forEach(t => {
    if (t.classification === "LOSS") { streak++; if (streak >= 3) excessiveLossTrades++; }
    else streak = 0;
  });
  setCount("excessive-losses", excessiveLossTrades);

  // Inconsistent position sizing: coefficient of variation of lotSize > 0.5
  const sizes = trades.filter(t => t.lotSize !== null && t.lotSize > 0).map(t => t.lotSize);
  const sizeMean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const sizeCV = sizes.length > 1 && sizeMean > 0 ? stdev(sizes) / sizeMean : 0;
  setCount("inconsistent-sizing", sizes.length >= MIN_SAMPLE && sizeCV > 0.5 ? sizes.length : 0);
}
function toMinutes(timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* ---------- Edge detection / Improve banners ---------- */
function renderEdgeAndImprove(trades) {
  const strategyGroups = statsForGroups(groupBy(trades, t => t.strategy));
  const setupGroups = statsForGroups(groupBy(trades, t => t.setup));
  const sessionGroups = statsForGroups(groupBy(trades, t => t.session));
  const dayGroups = statsForGroups(groupBy(trades.filter(t => t.date), t => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.date.getDay()]));
  const hourTrades = trades.map(t => ({ ...t, hour: parseHour(t.entryTime) })).filter(t => t.hour !== null);
  const hourGroups = statsForGroups(groupBy(hourTrades, t => String(t.hour).padStart(2, "0") + ":00"));
  const conditionGroups = statsForGroups(groupBy(trades, t => t.marketCondition));
  const gradeGroups = statsForGroups(groupBy(trades, t => t.tradeRating));

  setEdge("an-edge-strategy", "an-edge-strategy-sub", topByPL(strategyGroups, "best"));
  setEdge("an-edge-setup", "an-edge-setup-sub", topByPL(setupGroups, "best"));
  setEdge("an-edge-session", "an-edge-session-sub", topByPL(sessionGroups, "best"));
  setEdge("an-edge-day", "an-edge-day-sub", topByPL(dayGroups, "best"));
  setEdge("an-edge-time", "an-edge-time-sub", topByPL(hourGroups, "best", 3));
  setEdge("an-edge-condition", "an-edge-condition-sub", topByPL(conditionGroups, "best"));
  setEdge("an-edge-grade", "an-edge-grade-sub", topByPL(gradeGroups, "best", 3));

  const worstStrategy = topByPL(strategyGroups, "worst");
  const worstSession = topByPL(sessionGroups, "worst");
  const worstDay = topByPL(dayGroups, "worst");
  const worstSetup = topByPL(setupGroups, "worst");
  const emotionGroups = ["Calm", "Confident", "FOMO"].map(label => {
    const g = trades.filter(t => (t.emotionBefore || []).concat(t.emotionDuring || [], t.emotionAfter || []).includes(label));
    return { key: label, trades: g, stats: calculateStatistics(g) };
  });
  const worstEmotion = topByPL(emotionGroups.filter(g => g.stats.total > 0), "worst");

  const allNegative = [worstStrategy, worstSetup, worstSession, worstDay].filter(g => g && g.stats.netPL < 0);
  const biggestWeakness = allNegative.length ? allNegative.reduce((a, b) => a.stats.netPL <= b.stats.netPL ? a : b) : null;

  setEdge("an-improve-weakness", null, biggestWeakness);
  setText("an-improve-mistake", biggestWeakness ? `${fmtMoney(biggestWeakness.stats.netPL)} across ${biggestWeakness.stats.total} trades` : "Not enough data");
  setEdge("an-improve-strategy", null, worstStrategy);
  setEdge("an-improve-session", null, worstSession);
  setEdge("an-improve-day", null, worstDay);
  setEdge("an-improve-emotion", null, worstEmotion);
  setEdge("an-improve-setup", null, worstSetup);
}
function setEdge(valueId, subId, group, minSample = MIN_SAMPLE) {
  const valid = group && group.stats.total >= minSample;
  setText(valueId, valid ? group.key : "Not enough data");
  if (subId) setText(subId, valid ? `${fmtMoney(group.stats.netPL)} · ${group.stats.total} trades · ${fmtPct(group.stats.winRate)} win rate` : "Log more trades to see this.");
}

/* -----------------------------------------------------------------
   DRILL-DOWN — click any category row to see the real trades behind it
   ----------------------------------------------------------------- */
function openDrilldown(title, trades) {
  let modal = byId("an-drilldown-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "an-drilldown-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.style.cssText = "position:fixed;inset:0;background:rgba(5,7,12,0.55);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:16px;z-index:1000;opacity:0;pointer-events:none;transition:opacity .22s ease;";
    modal.innerHTML = `
      <div class="an-modal" style="width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;background:var(--eva-surface);border:1px solid var(--eva-border);border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.32);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:18px 20px;border-bottom:1px solid var(--eva-border);">
          <div id="an-drilldown-title" style="font-family:var(--eva-font-display);font-size:1.05rem;font-weight:700;"></div>
          <button type="button" id="an-drilldown-close" aria-label="Close" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--eva-border);background:var(--eva-surface-2);">✕</button>
        </div>
        <div id="an-drilldown-body" style="padding:14px 20px;overflow-y:auto;"></div>
      </div>`;
    document.body.appendChild(modal);
    byId("an-drilldown-close").addEventListener("click", () => { modal.style.opacity = "0"; modal.style.pointerEvents = "none"; });
  }
  byId("an-drilldown-title").textContent = `${title} — ${trades.length} trade${trades.length === 1 ? "" : "s"}`;
  const sorted = [...trades].sort((a, b) => (b.date || 0) - (a.date || 0));
  byId("an-drilldown-body").innerHTML = sorted.map(t => `
    <div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--eva-border);font-size:0.85rem;">
      <span>${fmtDate(t.date)} · ${escapeHtml(t.instrument || "—")} · ${escapeHtml(t.direction || "")}</span>
      <span class="${t.plSigned >= 0 ? 'an-pos' : 'an-neg'}">${fmtMoney(t.plSigned)}</span>
    </div>`).join("") || `<div class="an-list-empty"><span>No trades in this group.</span></div>`;
  modal.style.opacity = "1"; modal.style.pointerEvents = "auto"; modal.setAttribute("aria-hidden", "false");
}

/* -----------------------------------------------------------------
   ENTRY POINT
   ----------------------------------------------------------------- */
initAuthAndBoot();
