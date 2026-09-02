

/*
 * EVA — FUNDED CHALLENGE COMMAND CENTER
 * challenge.js
 *
 * Firebase v12 module. Designed to work with the existing challenge.html
 * without requiring a framework or a second backend.
 *
 * Firestore base path:
 *   users/{uid}/accounts/{accountId}
 *   users/{uid}/accounts/{accountId}/trades/{tradeId}
 *
 * Optional challenge subcollections (read when rules permit them):
 *   phases, rules, dailyStatus, performance, payouts, alerts, riskManagement
 *
 * IMPORTANT:
 * The supplied Firestore rules explicitly authorize users/{uid}/accounts and
 * the trades subcollection, but not arbitrary challenge subcollections. This
 * file therefore treats the account document + trades as the authoritative
 * minimum data source and gracefully falls back when optional subcollections
 * are denied. Derived dashboard metrics are calculated locally from trades.
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  limit,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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

const ROOT = "challenge-command-center";
const ACCOUNTS = "accounts";
const TRADES = "trades";
const OPTIONAL = ["phases", "rules", "dailyStatus", "performance", "payouts", "alerts", "riskManagement"];

const state = {
  uid: null,
  user: null,
  accounts: [],
  activeAccountId: null,
  account: null,
  trades: [],
  optional: {},
  unsubscribeTrades: null,
  unsubscribeAccount: null,
  unsubscribeAccounts: null,
  loading: false,
  activeTradeSlot: 1,
  equityPeriod: "month",
  performancePeriod: "month",
  growthPeriod: "month",
  calendarView: "month",
  calendarDate: new Date(),
  explorerLevel: "year",
  explorerValue: new Date().getFullYear().toString(),
  customRange: null,
  riskSettings: null,
  lastMetrics: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const root = () => document.getElementById(ROOT);

function n(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function pct(v, fallback = 0) {
  const x = n(v, fallback);
  // User-facing forms store percentages as 0.5 for 0.5%. Only treat very
  // small values as fractional percentages (e.g. 0.005 => 0.5%).
  return Math.abs(x) > 0 && Math.abs(x) <= 0.05 ? x * 100 : x;
}

function money(v) {
  const x = n(v);
  const sign = x > 0 ? "+" : x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plainMoney(v) {
  return `$${Math.abs(n(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number(v, digits = 2) {
  return n(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signedClass(v) { return n(v) >= 0 ? "ch-pos" : "ch-neg"; }

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v?.toDate === "function") return v.toDate();
  if (typeof v === "object" && v.seconds) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(v) {
  const d = toDate(v) || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function startOfWeek(d) { const x = startOfDay(d); const day = x.getDay(); x.setDate(x.getDate() - day); return x; }
function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }
function endOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth() + 1, 0); return endOfDay(x); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d) { return new Date(d.getFullYear(), 11, 31, 23,59,59,999); }

function getByAliases(obj, aliases, fallback = undefined) {
  for (const key of aliases) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function accountStartingBalance(a) {
  return n(getByAliases(a, ["startingBalance", "startBalance", "initialBalance", "accountBalance", "balance"]));
}

function accountCurrentBalance(a) {
  const direct = getByAliases(a, ["currentBalance", "liveBalance"]);
  return direct === undefined ? null : n(direct);
}

/*
 * tradePL() is the single source of truth for every P/L number used
 * anywhere on this page (balance, statistics, calendar, risk engine,
 * challenge progress, charts). A trade's own declared result — "win",
 * "loss", or "breakeven" — is authoritative over whatever raw sign
 * happens to be stored in profitLoss/pnl/etc, so a loss can never be
 * read back as a positive number here, no matter how it was written
 * (this UI, the legacy renderer, a script using EVAChallenge.addTrade,
 * or a hand-edited Firestore doc). Math.abs is used only to extract
 * magnitude — never to flip a loss positive.
 */
function tradeResultRaw(t) {
  return String(getByAliases(t, ["result", "status"], "")).toLowerCase();
}
function tradePL(t) {
  const raw = n(getByAliases(t, ["profitLoss", "pnl", "pL", "netProfit", "profit", "resultAmount"], 0));
  const resultRaw = tradeResultRaw(t);
  if (["win","profit","profitable","winner"].includes(resultRaw)) return Math.abs(raw);
  if (["loss","lose","losing","loser"].includes(resultRaw)) return -Math.abs(raw);
  if (["breakeven","break-even","break_even","be","even"].includes(resultRaw)) return 0;
  // No declared result on this trade (older/foreign record) — trust the stored signed number as-is.
  return raw;
}

function tradeRiskAmount(t) {
  return Math.abs(n(getByAliases(t, ["riskAmount", "risk", "riskMoney", "plannedRisk"], 0)));
}

function tradeRiskPct(t, balance) {
  const direct = getByAliases(t, ["riskPercentage", "riskPercent", "riskPct"]);
  if (direct !== undefined) return Math.abs(pct(direct));
  return balance > 0 ? (tradeRiskAmount(t) / balance) * 100 : 0;
}

function tradeDate(t) {
  return toDate(getByAliases(t, ["tradeDate", "date", "createdAt", "timestamp", "entryTime"]));
}

function tradeResult(t) {
  const raw = tradeResultRaw(t);
  if (["win","profit","profitable","winner"].includes(raw)) return "win";
  if (["loss","lose","losing","loser"].includes(raw)) return "loss";
  if (["breakeven","break-even","break_even","be","even"].includes(raw)) return "breakeven";
  const p = tradePL(t);
  return p > 0 ? "win" : p < 0 ? "loss" : "breakeven";
}

function accountRule(a, names, fallback = null) {
  const v = getByAliases(a, names);
  return v === undefined ? fallback : v;
}

function currentPhase(a) {
  return n(getByAliases(a, ["currentPhase", "phase", "activePhase", "currentPhaseNumber"], 1), 1);
}

function challengeType(a) {
  return String(getByAliases(a, ["challengeType", "type", "accountType", "programType"], "Funded Challenge"));
}

function phaseRulesFromAccount(a) {
  const phase = currentPhase(a);
  const phases = a?.phaseRules || a?.phases || {};
  const direct = phases?.[`phase${phase}`] || phases?.[String(phase)] || phases?.[`Phase ${phase}`];
  return direct && typeof direct === "object" ? direct : {};
}

function normalizedRules(a) {
  const p = phaseRulesFromAccount(a);
  const r = a?.rules || {};
  const source = { ...a, ...r, ...p };
  return {
    profitTargetPct: pct(getByAliases(source, ["profitTargetPct", "profitTargetPercent", "targetPercent", "profitTarget"], 0)),
    profitTargetAmount: n(getByAliases(source, ["profitTargetAmount", "targetAmount"], 0)),
    dailyDdPct: pct(getByAliases(source, ["dailyDrawdownPct", "dailyDrawdownPercent", "dailyDDPct", "maxDailyDrawdownPct"], 0)),
    dailyDdAmount: n(getByAliases(source, ["dailyDrawdownAmount", "dailyDD", "maxDailyDrawdown"], 0)),
    overallDdPct: pct(getByAliases(source, ["overallDrawdownPct", "overallDrawdownPercent", "maxOverallDrawdownPct"], 0)),
    overallDdAmount: n(getByAliases(source, ["overallDrawdownAmount", "overallDD", "maxOverallDrawdown"], 0)),
    trailingDdPct: pct(getByAliases(source, ["trailingDrawdownPct", "trailingDrawdownPercent"], 0)),
    trailingDdAmount: n(getByAliases(source, ["trailingDrawdownAmount", "trailingDD"], 0)),
    minTradingDays: n(getByAliases(source, ["minimumTradingDays", "minTradingDays"], 0)),
    maxTradingDays: n(getByAliases(source, ["maximumTradingDays", "maxTradingDays"], 0)),
    maxTradesDay: n(getByAliases(source, ["maxTradesPerDay", "maximumTradesPerDay", "maxTrades"], 0)),
    maxLossesDay: n(getByAliases(source, ["maxLossesPerDay", "maximumLossesPerDay", "stopAfterLosses", "maxConsecutiveLosses"], 0)),
    riskPerTradePct: pct(getByAliases(source, ["riskPerTradePct", "plannedRiskPerTradePct", "defaultRiskPct"], 0)),
    riskPerDayPct: pct(getByAliases(source, ["riskPerDayPct", "plannedRiskPerDayPct", "dailyRiskPct"], 0)),
    consistencyPct: pct(getByAliases(source, ["consistencyPct", "consistencyPercent", "maxProfitDayPct"], 0)),
    payoutSplit: getByAliases(source, ["payoutSplit", "profitSplit"], "80/20"),
    deadline: toDate(getByAliases(source, ["challengeDeadline", "deadline", "endDate"])),
    newsAllowed: Boolean(getByAliases(source, ["newsTradingAllowed", "newsTrading", "allowNews"], true)),
    weekendHolding: Boolean(getByAliases(source, ["weekendHolding", "allowWeekendHolding"], false)),
    hedgingAllowed: Boolean(getByAliases(source, ["hedgingAllowed", "hedging"], false))
  };
}

function calcMetrics(account, trades) {
  const start = accountStartingBalance(account);
  const rules = normalizedRules(account);
  const sorted = [...trades].sort((a,b) => (tradeDate(a)?.getTime() || 0) - (tradeDate(b)?.getTime() || 0));
  const totalPL = sorted.reduce((sum,t) => sum + tradePL(t), 0);
  // Trades are the authoritative performance ledger. Only fall back to a stored
  // currentBalance when there are no trades at all (e.g. a freshly created account).
  const directBalance = accountCurrentBalance(account);
  const balance = sorted.length ? start + totalPL : (directBalance === null ? start : directBalance);

  let equity = start, peak = start, maxDdMoney = 0, maxDdPct = 0;
  let wins = 0, losses = 0, be = 0, grossWin = 0, grossLoss = 0;
  let bestWin = 0, worstLoss = 0, riskTotal = 0;
  let currentWinStreak = 0, currentLossStreak = 0, bestWinStreak = 0, bestLossStreak = 0;
  const equityPoints = [{ date: toDate(account?.createdAt) || new Date(), balance: start, pl: 0 }];
  for (const t of sorted) {
    const pl = tradePL(t);
    equity += pl;
    peak = Math.max(peak, equity);
    const dd = Math.max(0, peak - equity);
    maxDdMoney = Math.max(maxDdMoney, dd);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? dd / peak * 100 : 0);
    const result = tradeResult(t);
    if (result === "win") { wins++; grossWin += Math.max(0,pl); bestWin = Math.max(bestWin, pl); currentWinStreak++; currentLossStreak=0; bestWinStreak=Math.max(bestWinStreak,currentWinStreak); }
    else if (result === "loss") { losses++; grossLoss += Math.abs(Math.min(0,pl)); worstLoss = Math.min(worstLoss, pl); currentLossStreak++; currentWinStreak=0; bestLossStreak=Math.max(bestLossStreak,currentLossStreak); }
    else { be++; currentWinStreak=0; currentLossStreak=0; }
    riskTotal += tradeRiskAmount(t);
    equityPoints.push({ date: tradeDate(t) || new Date(), balance: equity, pl });
  }

  const todayKey = isoDay(new Date());
  const todayTrades = sorted.filter(t => isoDay(tradeDate(t)) === todayKey);
  let dayEquity = start + sorted.filter(t => (tradeDate(t)?.getTime()||0) < startOfDay(new Date()).getTime()).reduce((sum,t)=>sum+tradePL(t),0);
  let dayPeak = dayEquity, intradayMaxDd = 0;
  for (const t of todayTrades) {
    dayEquity += tradePL(t); dayPeak = Math.max(dayPeak, dayEquity); intradayMaxDd = Math.max(intradayMaxDd, dayPeak-dayEquity);
  }
  const todayPL = todayTrades.reduce((sum,t)=>sum+tradePL(t),0);
  const todayLoss = Math.max(0, intradayMaxDd, -todayPL);
  const todayRisk = todayTrades.reduce((sum,t)=>sum+tradeRiskAmount(t),0);
  const todayLosses = todayTrades.filter(t=>tradeResult(t)==="loss").length;
  const todayRiskPct = balance > 0 ? todayRisk / balance * 100 : 0;
  const tradingDays = new Set(sorted.map(t=>isoDay(tradeDate(t)))).size;

  const dailyLimit = rules.dailyDdAmount > 0 ? rules.dailyDdAmount : (rules.dailyDdPct > 0 ? start * rules.dailyDdPct / 100 : Infinity);
  const overallLimit = rules.overallDdAmount > 0 ? rules.overallDdAmount : (rules.overallDdPct > 0 ? start * rules.overallDdPct / 100 : Infinity);
  const dailyRemaining = Number.isFinite(dailyLimit) ? Math.max(0,dailyLimit-todayLoss) : Infinity;
  const overallRemaining = Number.isFinite(overallLimit) ? Math.max(0,overallLimit-maxDdMoney) : Infinity;
  const targetAmount = rules.profitTargetAmount > 0 ? rules.profitTargetAmount : (rules.profitTargetPct > 0 ? start * rules.profitTargetPct / 100 : 0);
  const targetProgress = targetAmount > 0 ? Math.max(0, Math.min(100,totalPL/targetAmount*100)) : 0;
  const dangerOverall = Number.isFinite(overallLimit) && overallLimit > 0 ? Math.min(100,maxDdMoney/overallLimit*100) : 0;
  const dangerDaily = Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.min(100,todayLoss/dailyLimit*100) : 0;
  const danger = Math.max(dangerOverall,dangerDaily);
  const winRate = (wins+losses) ? wins/(wins+losses)*100 : 0;
  const avgWin = wins ? grossWin/wins : 0;
  const avgLoss = losses ? grossLoss/losses : 0;
  const profitFactor = grossLoss > 0 ? grossWin/grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgRiskPct = sorted.length ? sorted.reduce((sum,t)=>sum+tradeRiskPct(t,balance),0)/sorted.length : 0;
  const avgR = riskTotal > 0 ? totalPL/riskTotal : 0;
  const byDay = aggregateByDay(sorted);
  const bestDayPL = Math.max(0,...Object.values(byDay).map(x=>x.pl));
  const worstDayPL = Math.min(0,...Object.values(byDay).map(x=>x.pl));
  const consistency = rules.consistencyPct > 0 && totalPL > 0 ? bestDayPL/totalPL*100 : null;
  const consecutiveLossStop = rules.maxLossesDay > 0 && todayLosses >= rules.maxLossesDay;
  const maxTradesStop = rules.maxTradesDay > 0 && todayTrades.length >= rules.maxTradesDay;
  const dailyDdStop = Number.isFinite(dailyLimit) && todayLoss >= dailyLimit;
  const overallDdStop = Number.isFinite(overallLimit) && maxDdMoney >= overallLimit;
  const targetReached = targetAmount > 0 && totalPL >= targetAmount;
  const stopTrading = dailyDdStop || overallDdStop || consecutiveLossStop || maxTradesStop || balance <= 0;
  const recommendedRisk = calculateRecommendedRisk({balance,rules,dailyRemaining,overallRemaining,todayRisk,todayTrades:todayTrades.length,todayLosses,targetRemaining:Math.max(0,targetAmount-totalPL),danger});
  const maximumRisk = Math.max(0,Math.min(Number.isFinite(dailyRemaining)?dailyRemaining:Infinity,Number.isFinite(overallRemaining)?overallRemaining:Infinity,rules.riskPerTradePct>0?balance*rules.riskPerTradePct/100:Infinity));
  return {start,balance,totalPL,todayPL,todayLoss,todayRisk,todayRiskPct,todayTrades:todayTrades.length,todayLosses,tradingDays,wins,losses,be,totalTrades:sorted.length,winRate,avgWin,avgLoss,bestWin,worstLoss,grossWin,grossLoss,profitFactor,avgRiskPct,avgR,maxDdMoney,maxDdPct,bestWinStreak,bestLossStreak,dailyLimit,dailyRemaining,overallLimit,overallRemaining,targetAmount,targetProgress,danger,dangerDaily,dangerOverall,recommendedRisk,maximumRisk,stopTrading,dailyDdStop,overallDdStop,consecutiveLossStop,maxTradesStop,targetReached,consistency,equityPoints,rules,sorted,bestDayPL,worstDayPL};
}

function calculateRecommendedRisk({balance,rules,dailyRemaining,overallRemaining,todayRisk,todayTrades,todayLosses,targetRemaining,danger}) {
  if (balance <= 0 || danger >= 100 || dailyRemaining <= 0 || overallRemaining <= 0) return 0;
  if (rules.maxTradesDay > 0 && todayTrades >= rules.maxTradesDay) return 0;
  if (rules.maxLossesDay > 0 && todayLosses >= rules.maxLossesDay) return 0;
  let base = rules.riskPerTradePct > 0 ? balance*rules.riskPerTradePct/100 : balance*0.005;
  if (Number.isFinite(dailyRemaining)) base=Math.min(base,dailyRemaining);
  if (Number.isFinite(overallRemaining)) base=Math.min(base,overallRemaining);
  if (rules.riskPerDayPct > 0) base=Math.min(base,Math.max(0,balance*rules.riskPerDayPct/100-todayRisk));
  if (danger >= 90) return 0;
  if (danger >= 75) base*=0.5; else if (danger >= 60) base*=0.75;
  if (rules.riskPerTradePct===0 && targetRemaining>0) base=Math.min(base,targetRemaining);
  return Math.max(0,base);
}

function aggregateByDay(trades) {
  const out = {};
  for (const t of trades) {
    const key = isoDay(tradeDate(t));
    if (!out[key]) out[key] = { pl: 0, trades: [] };
    out[key].pl += tradePL(t);
    out[key].trades.push(t);
  }
  return out;
}

function aggregateByWeek(trades) {
  const out = {};
  for (const t of trades) {
    const d = startOfWeek(tradeDate(t) || new Date());
    const key = isoDay(d);
    if (!out[key]) out[key] = { start: d, pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function aggregateByMonth(trades) {
  const out = {};
  for (const t of trades) {
    const d = tradeDate(t) || new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!out[key]) out[key] = { start: new Date(d.getFullYear(), d.getMonth(), 1), pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function aggregateByYear(trades) {
  const out = {};
  for (const t of trades) {
    const d = tradeDate(t) || new Date();
    const key = String(d.getFullYear());
    if (!out[key]) out[key] = { start: new Date(d.getFullYear(),0,1), pl: 0, trades: [] };
    out[key].pl += tradePL(t); out[key].trades.push(t);
  }
  return out;
}

function periodFilter(trades, period, custom = null) {
  const now = new Date();
  let start, end;
  if (period === "day") { start = startOfDay(now); end = endOfDay(now); }
  else if (period === "week") { start = startOfWeek(now); end = new Date(start); end.setDate(end.getDate()+6); end = endOfDay(end); }
  else if (period === "year") { start = startOfYear(now); end = endOfYear(now); }
  else if (period === "custom" && custom?.start && custom?.end) { start = startOfDay(custom.start); end = endOfDay(custom.end); }
  else { start = startOfMonth(now); end = endOfMonth(now); }
  return trades.filter(t => { const d = tradeDate(t); return d && d >= start && d <= end; });
}

function showToast(message, kind = "info") {
  let host = document.getElementById("ch-toast-host");
  if (!host) {
    host = document.createElement("div"); host.id = "ch-toast-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(420px,calc(100vw - 36px));";
    document.body.appendChild(host);
  }
  const colors = { success: "#16a34a", error: "#dc2626", warning: "#d97706", info: "#4f46e5" };
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = `pointer-events:auto;background:${colors[kind] || colors.info};color:#fff;padding:11px 16px;border-radius:12px;font-size:.82rem;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.25);`;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .25s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, 3500);
}

function friendlyError(err) {
  const code = err?.code || "";
  console.error("EVA Challenge Firebase error", err);
  if (code.includes("permission-denied")) return "Firebase rejected this action by your Firestore security rules.";
  if (code.includes("unauthenticated")) return "You are not signed in. Please sign in again.";
  if (code.includes("unavailable")) return "Firebase is temporarily unavailable. Check your connection and try again.";
  if (code.includes("failed-precondition")) return "Firebase needs an index or configuration change for this query.";
  return err?.message || "Something went wrong.";
}

function accountRef(accountId) { return doc(db, "users", state.uid, ACCOUNTS, accountId); }
function tradesRef(accountId) { return collection(db, "users", state.uid, ACCOUNTS, accountId, TRADES); }
function optionalRef(accountId, name) { return collection(db, "users", state.uid, ACCOUNTS, accountId, name); }

function subscribeAccounts(){
  if(state.unsubscribeAccounts)state.unsubscribeAccounts();
  state.unsubscribeAccounts=onSnapshot(collection(db,"users",state.uid,ACCOUNTS),snap=>{
    const previous=state.activeAccountId;
    state.accounts=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name||a.accountName||a.id).localeCompare(String(b.name||b.accountName||b.id),undefined,{numeric:true}));
    renderAccountList();
    if(!state.accounts.length){state.activeAccountId=null;state.account=null;state.trades=[];showEmptyAccountState();return;}
    const selected=state.accounts.some(a=>a.id===previous)?previous:state.accounts[0].id;
    if(selected!==state.activeAccountId || !state.account) switchAccount(selected,false);
    else if(state.account){const fresh=state.accounts.find(a=>a.id===state.activeAccountId);if(fresh)state.account={...state.account,...fresh};renderAll();}
  },err=>showToast(friendlyError(err),"error"));
}

async function loadAccounts() {
  const snap = await getDocs(collection(db, "users", state.uid, ACCOUNTS));
  state.accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  state.accounts.sort((a,b) => String(a.name || a.accountName || a.id).localeCompare(String(b.name || b.accountName || b.id), undefined, { numeric: true }));
  if (!state.accounts.length) {
    state.activeAccountId = null;
    state.account = null;
    state.trades = [];
    renderAll();
    showEmptyAccountState();
    return;
  }
  const requested = root()?.dataset.accountId || state.activeAccountId;
  state.activeAccountId = state.accounts.some(a => a.id === requested) ? requested : state.accounts[0].id;
  await switchAccount(state.activeAccountId, false);
}

function subscribeAccount(accountId) {
  if (state.unsubscribeAccount) state.unsubscribeAccount();
  state.unsubscribeAccount = onSnapshot(accountRef(accountId), snap => {
    if (!snap.exists()) return;
    state.account = { id: snap.id, ...snap.data() };
    renderAll();
  }, err => showToast(friendlyError(err), "error"));
}

function subscribeTrades(accountId) {
  if (state.unsubscribeTrades) state.unsubscribeTrades();
  // The query is intentionally simple to avoid requiring a composite index.
  state.unsubscribeTrades = onSnapshot(tradesRef(accountId), snap => {
    state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.trades.sort((a,b) => (tradeDate(b)?.getTime() || 0) - (tradeDate(a)?.getTime() || 0));
    renderAll();
  }, err => {
    showToast(friendlyError(err), "error");
    state.trades = [];
    renderAll();
  });
}

async function loadOptionalCollections(accountId) {
  state.optional = {};
  await Promise.all(OPTIONAL.map(async name => {
    try {
      const snap = await getDocs(optionalRef(accountId, name));
      state.optional[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      // Expected with the currently supplied rules. Do not break the dashboard.
      state.optional[name] = [];
    }
  }));
  renderAll();
}

async function switchAccount(accountId, toast = true) {
  if (!state.accounts.some(a => a.id === accountId)) return;
  state.activeAccountId = accountId;
  state.account = state.accounts.find(a => a.id === accountId) || null;
  const el = root(); if (el) el.dataset.accountId = accountId;
  renderAccountList();
  subscribeAccount(accountId);
  subscribeTrades(accountId);
  await loadOptionalCollections(accountId);
  if (toast) showToast("Account switched.", "success");
}

function renderAccountList() {
  const list = document.getElementById("account-list");
  if (!list) return;
  list.innerHTML = "";
  for (const a of state.accounts) {
    const b = accountCurrentBalance(a);
    const start = accountStartingBalance(a);
    const phase = currentPhase(a);
    const btn = document.createElement("button");
    btn.className = `ch-account-item${a.id === state.activeAccountId ? " ch-active" : ""}`;
    btn.dataset.accountId = a.id;
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(a.id === state.activeAccountId));
    btn.innerHTML = `<span class="ch-account-item-info"><span class="ch-account-item-name"></span><span class="ch-account-item-meta"></span></span><span class="ch-pill ${a.status === "failed" || a.status === "breached" ? "ch-pill-warn" : "ch-pill-safe"}"><span class="ch-pill-dot"></span>${escapeHtml(String(a.status || (phase > 1 ? `Phase ${phase}` : "Active")))}</span>`;
    $(".ch-account-item-name", btn).textContent = a.name || a.accountName || a.id;
    $(".ch-account-item-meta", btn).textContent = `${plainMoney(b ?? start)} · ${challengeType(a)} · Phase ${phase}`;
    list.appendChild(btn);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c])); }

function renderHeader(metrics) {
  const a = state.account; if (!a) return;
  const trigger = document.getElementById("ch-account-trigger");
  if (trigger) {
    const name = $(".ch-account-trigger-name", trigger);
    const meta = $(".ch-account-trigger-meta", trigger);
    if (name) name.textContent = a.name || a.accountName || state.activeAccountId;
    if (meta) meta.textContent = `${plainMoney(metrics.start)} ${challengeType(a)} · Phase ${currentPhase(a)}`;
    trigger.setAttribute("aria-expanded", "false");
  }
  const status = document.getElementById("challenge-status");
  const title = document.getElementById("challenge-status-title");
  const desc = document.getElementById("challenge-status-desc");
  const phaseStatus = document.getElementById("phase-status");
  const phasePct = document.getElementById("phase-progress-pct");
  const phase = currentPhase(a);
  let statusTitle = "On Track";
  let statusDesc = `Phase ${phase} · ${metrics.tradingDays} trading days · rules within calculated limits`;
  let stateName = "on-track";
  if (metrics.overallDdStop) { statusTitle = "Account Breached"; statusDesc = "Overall drawdown limit has been reached."; stateName = "danger"; }
  else if (metrics.dailyDdStop) { statusTitle = "Stop Trading"; statusDesc = "Today's daily drawdown limit has been reached."; stateName = "danger"; }
  else if (metrics.stopTrading) { statusTitle = "Trading Paused"; statusDesc = "Your configured trading-stop rule has been triggered."; stateName = "warning"; }
  else if (metrics.targetReached) { statusTitle = `Phase ${phase} Target Reached`; statusDesc = "Profit target reached. Review your firm requirements before marking the phase passed."; stateName = "safe"; }
  else if (metrics.danger >= 75) { statusTitle = "Caution — Drawdown Risk"; statusDesc = `${number(100 - metrics.danger,1)}% drawdown headroom remains before the calculated danger threshold.`; stateName = "warning"; }
  if (status) { status.dataset.state = stateName; status.classList.toggle("ch-status-safe", stateName === "safe" || stateName === "on-track"); status.classList.toggle("ch-glow-safe", stateName === "safe" || stateName === "on-track"); }
  if (title) title.textContent = statusTitle;
  if (desc) desc.textContent = statusDesc;
  if (phaseStatus) phaseStatus.textContent = `Phase ${phase}`;
  if (phasePct) phasePct.textContent = `${number(metrics.targetProgress,0)}%`;
}

function setText(id, value, cls = null) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = value;
  if (cls) { el.classList.remove("ch-pos","ch-neg"); el.classList.add(cls); }
}

function renderOverview(metrics) {
  setText("current-balance", plainMoney(metrics.balance));
  setText("starting-balance", plainMoney(metrics.start));
  setText("current-profit", money(metrics.totalPL), signedClass(metrics.totalPL));
  setText("today-pl", `Today: ${money(metrics.todayPL)}`, signedClass(metrics.todayPL));
  setText("profit-progress", `${number(metrics.targetProgress,0)}%`);
  const bar = document.getElementById("profit-progress-bar"); if (bar) bar.style.width = `${Math.max(0,Math.min(100,metrics.targetProgress))}%`;
  setText("profit-target", `${plainMoney(metrics.targetAmount)} (${number(metrics.rules.profitTargetPct,0)}%)`);
  setText("today-risk", `${number(metrics.todayRiskPct)}%`);
  const riskBar = document.querySelector("#account-overview .ch-metric-card:nth-child(4) .ch-bar-fill");
  if (riskBar) riskBar.style.width = `${Math.min(100, metrics.rules.riskPerDayPct ? metrics.todayRiskPct / metrics.rules.riskPerDayPct * 100 : metrics.todayRiskPct)}%`;
}

function renderPhase(metrics) {
  const track = document.querySelector("#phase-progression .ch-phase-track");
  if (!track || !state.account) return;
  const active = currentPhase(state.account);
  const phaseTrigger=document.querySelector("#phase-selector > button span"); if(phaseTrigger) phaseTrigger.textContent=active===4?"Funded":`Phase ${active}`;
  const all = [1,2,3,4];
  const enabled = state.account.phasesEnabled || {phase1:true,phase2:false,phase3:false};
  const phaseEnabled = p => p===1 || p===4 || enabled[`phase${p}`] !== false;
  const nodes = [];
  for (const p of all) {
    if (!phaseEnabled(p)) continue;
    const phaseObj = (state.account.phaseRules||{})[`phase${p}`] || (p===1 ? state.account.rules||{} : {});
    const targetPct = pct(getByAliases(phaseObj,["profitTargetPct","profitTargetPercent","targetPercent","profitTarget"],0));
    const targetAmt = n(getByAliases(phaseObj,["profitTargetAmount","targetAmount"],0)) || (targetPct>0 ? metrics.start*targetPct/100 : 0);
    const phaseProgress = p===active ? metrics.targetProgress : (p<active ? 100 : 0);
    const remaining = Math.max(0,targetAmt - (p===active ? metrics.totalPL : 0));
    const status = p===4 ? (active>=4 ? "Active" : "Locked") : (p<active ? "Passed" : p===active ? "Active" : "Locked");
    const cls = status==="Passed" ? "ch-phase-passed" : status==="Active" ? "ch-phase-active" : "ch-phase-locked";
    nodes.push(`<div class="ch-phase-node ${cls}" data-phase="${p}"><div class="ch-phase-node-head"><span class="ch-phase-node-name">${p===4?"Funded":`Phase ${p}`}</span><span class="ch-phase-node-icon"><svg viewBox="0 0 24 24">${status==="Locked"?'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>':'<polyline points="20 6 9 17 4 12"/>'}</svg></span></div>${p<4?`<div class="ch-bar-track"><div class="ch-bar-fill" style="width:${phaseProgress}%"></div></div><div class="ch-phase-node-stat"><span>Progress</span><b>${number(phaseProgress,0)}%</b></div><div class="ch-phase-node-stat"><span>Target</span><b>${targetAmt>0?plainMoney(metrics.start+targetAmt):"—"}</b></div><div class="ch-phase-node-stat"><span>Remaining</span><b>${targetAmt>0?plainMoney(remaining):"—"}</b></div><div class="ch-phase-node-stat"><span>Trading Days</span><b>${metrics.tradingDays} / ${n(getByAliases(phaseObj,["minimumTradingDays","minTradingDays"],0))||"—"} min</b></div>`:`<div class="ch-phase-node-stat"><span>Status</span><b>${status}</b></div><div class="ch-phase-node-stat"><span>Payout Split</span><b>${escapeHtml(String(metrics.rules.payoutSplit||"—"))}</b></div>`}</div>`);
    if (p !== 4) nodes.push(`<div class="ch-phase-connector"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div>`);
  }
  track.innerHTML = nodes.join("");
}

function renderDrawdown(metrics) {
  const dailyPct = Number.isFinite(metrics.dailyLimit) && metrics.dailyLimit>0 ? Math.min(100,metrics.todayLoss/metrics.dailyLimit*100) : 0;
  const overallPct = Number.isFinite(metrics.overallLimit) && metrics.overallLimit>0 ? Math.min(100,metrics.maxDdMoney/metrics.overallLimit*100) : 0;
  const cards = $$(".ch-dd-card");
  if (cards[0]) {
    const fill=cards[0].querySelector(".ch-bar-fill"); if(fill) fill.style.width=`${dailyPct}%`;
    const used=cards[0].querySelector(".ch-dd-used"); if(used) used.textContent=`${plainMoney(metrics.todayLoss)} / ${Number.isFinite(metrics.dailyLimit)?plainMoney(metrics.dailyLimit):"No limit"} used`;
    const pctEl=cards[0].querySelector(".ch-dd-row > .ch-num"); if(pctEl)pctEl.textContent=`${number(dailyPct,0)}%`;
    setText("daily-dd-remaining",Number.isFinite(metrics.dailyRemaining)?plainMoney(metrics.dailyRemaining):"—");
  }
  if (cards[1]) {
    const fill=cards[1].querySelector(".ch-bar-fill"); if(fill) fill.style.width=`${overallPct}%`;
    const used=cards[1].querySelector(".ch-dd-used"); if(used) used.textContent=`${plainMoney(metrics.maxDdMoney)} / ${Number.isFinite(metrics.overallLimit)?plainMoney(metrics.overallLimit):"No limit"} used`;
    const pctEl=cards[1].querySelector(".ch-dd-row > .ch-num"); if(pctEl)pctEl.textContent=`${number(overallPct,0)}%`;
    setText("overall-dd-remaining",Number.isFinite(metrics.overallRemaining)?plainMoney(metrics.overallRemaining):"—");
  }
  const danger=Math.max(dailyPct,overallPct); setText("danger-percentage",`${number(danger,0)}%`);
  const ring=document.getElementById("danger-ring-fill"); if(ring){const r=52,c=2*Math.PI*r;ring.style.strokeDasharray=`${c}`;ring.style.strokeDashoffset=`${c*(1-danger/100)}`;ring.style.stroke=danger>=90?"var(--ch-danger)":danger>=70?"var(--ch-warn)":"var(--ch-safe)";}
  const pill=document.getElementById("danger-level-pill"); const panel=document.getElementById("risk-engine");
  let label="Safe", cls="ch-pill-safe"; if(metrics.overallDdStop||metrics.dailyDdStop){label="Breached";cls="ch-pill-danger";} else if(metrics.stopTrading){label="Stop Trading";cls="ch-pill-danger";} else if(danger>=75){label="Danger";cls="ch-pill-warn";} else if(danger>=50){label="Caution";cls="ch-pill-warn";}
  if(pill){pill.className=`ch-pill ${cls}`;pill.innerHTML=`<span class="ch-pill-dot"></span>${label}`;} if(panel){panel.dataset.dangerLevel=label.toLowerCase().replace(/\s+/g,"-");panel.classList.remove("ch-glow-safe","ch-glow-warn","ch-glow-danger");panel.classList.add(label==="Safe"?"ch-glow-safe":label==="Caution"||label==="Danger"?"ch-glow-warn":"ch-glow-danger");}
  const items=document.querySelectorAll("#risk-engine .ch-danger-breach-item .ch-num"); if(items[0])items[0].textContent=Number.isFinite(metrics.dailyRemaining)?plainMoney(metrics.dailyRemaining):"—"; if(items[1])items[1].textContent=Number.isFinite(metrics.overallRemaining)?plainMoney(metrics.overallRemaining):"—";
  const stop=document.getElementById("stop-trading-banner"); if(stop)stop.classList.toggle("ch-visible",metrics.stopTrading);
}

function renderRisk(metrics) {
  const card=document.getElementById("risk-management");if(!card)return;const rows=$$(".ch-risk-row",card);const vals=[plainMoney(metrics.balance),Number.isFinite(metrics.dailyRemaining)?plainMoney(metrics.dailyRemaining):"—",Number.isFinite(metrics.overallRemaining)?plainMoney(metrics.overallRemaining):"—",`${number(metrics.todayRiskPct)}%`,`${number(metrics.rules.riskPerTradePct)}%`,`${number(metrics.rules.riskPerDayPct)}%`,`${metrics.todayTrades} / ${metrics.rules.maxTradesDay||"—"}`,`${metrics.todayLosses} / ${metrics.rules.maxLossesDay||"—"}`];rows.forEach((r,i)=>{const el=$(".ch-num",r);if(el)el.textContent=vals[i]??"—";});
  let projected={...metrics,balance:metrics.balance,todayRisk:metrics.todayRisk,todayTrades:metrics.todayTrades,todayLosses:metrics.todayLosses,dailyRemaining:metrics.dailyRemaining,overallRemaining:metrics.overallRemaining};
  for(let slot=1;slot<state.activeTradeSlot;slot++){const risk=calculateRecommendedRisk(projected);if(risk<=0){projected={...projected,recommendedRisk:0,maximumRisk:0,stopTrading:true};break;}const projectedBalance=projected.balance-risk;const projectedTodayRisk=projected.todayRisk+risk;const projectedDailyRemaining=Number.isFinite(projected.dailyRemaining)?Math.max(0,projected.dailyRemaining-risk):projected.dailyRemaining;const projectedOverallRemaining=Number.isFinite(projected.overallRemaining)?Math.max(0,projected.overallRemaining-risk):projected.overallRemaining;projected={...projected,balance:projectedBalance,todayRisk:projectedTodayRisk,todayTrades:projected.todayTrades+1,todayLosses:projected.todayLosses+1,todayPL:(projected.todayPL||0)-risk,dailyRemaining:projectedDailyRemaining,overallRemaining:projectedOverallRemaining,danger:Math.max(projected.danger,projected.dailyLimit>0?(projected.dailyLimit-projectedDailyRemaining)/projected.dailyLimit*100:0),recommendedRisk:0,maximumRisk:0};}
  const rec=calculateRecommendedRisk(projected);const max=Math.max(0,Math.min(Number.isFinite(projected.dailyRemaining)?projected.dailyRemaining:Infinity,Number.isFinite(projected.overallRemaining)?projected.overallRemaining:Infinity,projected.rules.riskPerTradePct>0?projected.balance*projected.rules.riskPerTradePct/100:Infinity));
  setText("recommended-risk",plainMoney(rec));setText("maximum-risk",plainMoney(max));const foot=document.querySelector("#next-trade .ch-next-trade-stat:first-of-type .ch-metric-foot");if(foot)foot.textContent=`${number(projected.balance>0?rec/projected.balance*100:0)}% of projected balance`;
  const status=document.getElementById("next-trade-status");if(status){const blocked=projected.stopTrading||rec<=0;const caution=!blocked&&projected.danger>=60;status.dataset.state=blocked?"danger":caution?"warning":"safe";status.className=`ch-next-trade-status ${blocked?"ch-pill-danger":caution?"ch-pill-warn":"ch-pill-safe"}`;status.textContent=blocked?"STOP — Do Not Trade":caution?"Caution — Reduced Risk":"Safe to Trade";}
  $$("#trade-slot-tabs .ch-next-trade-tab").forEach(tab=>tab.classList.toggle("ch-active",n(tab.dataset.trade)===state.activeTradeSlot));
}

function renderRuleMonitor(metrics) {
  const grid = document.querySelector("#rule-monitor .ch-rule-grid"); if (!grid) return;
  const defs = [
    ["daily-drawdown", "Daily Drawdown", `${plainMoney(metrics.todayLoss)} / ${plainMoney(metrics.dailyLimit)}`, metrics.dailyDdStop ? "danger" : metrics.dangerDaily >= 70 ? "warn" : "safe"],
    ["overall-drawdown", "Overall Drawdown", `${plainMoney(metrics.maxDdMoney)} / ${plainMoney(metrics.overallLimit)}`, metrics.overallDdStop ? "danger" : metrics.dangerOverall >= 70 ? "warn" : "safe"],
    ["profit-target", "Profit Target", `${number(metrics.targetProgress,0)}%`, metrics.targetReached ? "safe" : "progress"],
    ["min-trading-days", "Minimum Trading Days", `${metrics.tradingDays} / ${metrics.rules.minTradingDays || "—"}`, metrics.rules.minTradingDays && metrics.tradingDays < metrics.rules.minTradingDays ? "progress" : "safe"],
    ["max-trades", "Maximum Trades", `${metrics.todayTrades} / ${metrics.rules.maxTradesDay || "—"}`, metrics.maxTradesStop ? "danger" : "safe"],
    ["risk-per-trade", "Risk Per Trade", `${number(metrics.rules.riskPerTradePct)}% · ${metrics.recommendedRisk > 0 ? "Safe" : "Blocked"}`, metrics.recommendedRisk > 0 ? "safe" : "danger"],
    ["daily-risk", "Daily Risk", `${number(metrics.todayRiskPct)}% / ${number(metrics.rules.riskPerDayPct)}%`, metrics.rules.riskPerDayPct && metrics.todayRiskPct >= metrics.rules.riskPerDayPct ? "danger" : "safe"],
    ["consistency", "Consistency", metrics.consistency === null ? "Not enough data" : `${number(metrics.consistency,1)}% of total profit`, metrics.consistency !== null && metrics.rules.consistencyPct > 0 && metrics.consistency > metrics.rules.consistencyPct ? "danger" : "safe"],
    ["news-trading", "News Trading", metrics.rules.newsAllowed ? "Enabled" : "Disabled", metrics.rules.newsAllowed ? "enabled" : "disabled"],
    ["weekend-holding", "Weekend Holding", metrics.rules.weekendHolding ? "Enabled" : "Disabled", metrics.rules.weekendHolding ? "enabled" : "disabled"],
    ["position-size", "Position Size", getByAliases(state.account, ["maxPositionSize","maximumPositionSize","maxLotSize"], "Not configured"), "safe"],
    ["max-losses", "Maximum Losses", `${metrics.todayLosses} / ${metrics.rules.maxLossesDay || "—"}`, metrics.consecutiveLossStop ? "danger" : "safe"]
  ];
  grid.innerHTML = defs.map(([key,name,value,status]) => `<div class="ch-rule-row" data-rule="${key}" data-status="${status}"><span class="ch-rule-name"><span class="ch-rule-dot ${status === "danger" ? "ch-danger" : status === "warn" || status === "progress" ? "ch-warn" : status === "safe" ? "ch-safe" : "ch-neutral"}"></span>${escapeHtml(name)}</span><span class="ch-rule-value">${escapeHtml(String(value))}</span></div>`).join("");
}

function filteredEquityPoints(metrics,period){
  const trades=periodFilter(metrics.sorted,period,state.customRange);
  if(!trades.length)return [{date:new Date(),balance:metrics.start,pl:0}];
  const firstTime=tradeDate(trades[0])?.getTime()||0;
  let running=metrics.start+metrics.sorted.filter(t=>(tradeDate(t)?.getTime()||0)<firstTime).reduce((sum,t)=>sum+tradePL(t),0);
  const points=[{date:tradeDate(trades[0])||new Date(),balance:running,pl:0}];
  for(const t of trades){running+=tradePL(t);points.push({date:tradeDate(t)||new Date(),balance:running,pl:tradePL(t)});}
  return points;
}

function periodBounds(period,custom=null){
  const now=new Date();if(period==="day")return [startOfDay(now),endOfDay(now)];if(period==="week"){const st=startOfWeek(now),en=new Date(st);en.setDate(en.getDate()+6);return [st,endOfDay(en)];}if(period==="year")return [startOfYear(now),endOfYear(now)];if(period==="custom"&&custom?.start&&custom?.end)return [startOfDay(custom.start),endOfDay(custom.end)];return [startOfMonth(now),endOfMonth(now)];
}

/* =========================================================
   ECHARTS ENGINE
   Replaces the old raw-SVG line/bar chart renderer. Every
   chart below is fed exclusively from calcMetrics()/state.trades
   (real Firestore trade data) — nothing here invents numbers.
   Colors are re-resolved from the page's live CSS custom
   properties on every render, so dark/light theme and the
   existing design system keep working with zero extra wiring.
   ========================================================= */
const echartInstances = {};
const echartResizeObserver = (typeof ResizeObserver !== "undefined")
  ? new ResizeObserver(() => resizeAllCharts())
  : null;

function chartScopeEl(){ return document.querySelector(".ch-wrap") || document.documentElement; }
function cssVar(name, fallback=""){
  try { const v = getComputedStyle(chartScopeEl()).getPropertyValue(name).trim(); return v || fallback; }
  catch(e){ return fallback; }
}
function chartTheme(){
  return {
    text: cssVar("--eva-text", "#e7e9f4"),
    textDim: cssVar("--eva-text-dim", "#8a90a6"),
    border: cssVar("--eva-border", "rgba(255,255,255,.1)"),
    surface: cssVar("--eva-surface", "#12141c"),
    accent1: cssVar("--eva-accent-1", "#6366F1"),
    accent2: cssVar("--eva-accent-2", "#8B5CF6"),
    safe: cssVar("--ch-safe", "#22C55E"),
    danger: cssVar("--ch-danger", "#EF4444"),
    warn: cssVar("--ch-warn", "#F59E0B")
  };
}
function colorWithAlpha(color, alpha){
  if(!color) return `rgba(99,102,241,${alpha})`;
  color=color.trim();
  if(color[0]==="#"){
    let hex=color.slice(1); if(hex.length===3) hex=hex.split("").map(c=>c+c).join("");
    const r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
    if([r,g,b].some(Number.isNaN)) return color;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m=color.match(/rgba?\(([^)]+)\)/);
  if(m){ const parts=m[1].split(",").map(s=>s.trim()); return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`; }
  return color;
}

function getEChart(id){
  if(typeof echarts==="undefined") return null;
  const mount=document.querySelector(`#${id} .ch-echart-mount`);
  if(!mount) return null;
  let inst=echartInstances[id];
  if(inst && inst._mountEl!==mount){ try{inst.dispose();}catch(e){} inst=null; }
  if(!inst || inst.isDisposed()){
    inst=echarts.init(mount,null,{renderer:"svg"});
    inst._mountEl=mount;
    echartInstances[id]=inst;
    if(echartResizeObserver) echartResizeObserver.observe(mount);
  }
  return inst;
}
let echartResizeQueued=false;
function resizeAllCharts(){
  if(echartResizeQueued) return; echartResizeQueued=true;
  requestAnimationFrame(()=>{ echartResizeQueued=false; Object.values(echartInstances).forEach(inst=>{ try{ if(inst && !inst.isDisposed()) inst.resize(); }catch(e){} }); });
}
window.addEventListener("resize", resizeAllCharts);

function watchChartTheme(){
  if(typeof MutationObserver==="undefined") return;
  const redraw=()=>{ if(state.lastMetrics) renderCharts(state.lastMetrics); };
  const obs=new MutationObserver(redraw);
  obs.observe(document.documentElement,{attributes:true,attributeFilter:["class","data-theme"]});
  obs.observe(document.body,{attributes:true,attributeFilter:["class","data-theme"]});
}

function buildLineOption({points, valueKey="balance", color, theme, formatValue, yFormat, invert=false, zeroLine=false, targetLine=null, areaOpacity=0.28, dateFmt}){
  const t=theme;
  const fmtDate=dateFmt || (d=>d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}));
  const data=points.map(p=>{
    const raw=n(p[valueKey]);
    const val=invert?-raw:raw;
    const time=(p.date instanceof Date && !Number.isNaN(p.date.getTime()))?p.date.getTime():Date.now();
    return [time,val,raw];
  });
  const markLineData=[]; if(zeroLine) markLineData.push({yAxis:0}); if(targetLine!=null) markLineData.push({yAxis:targetLine});
  return {
    backgroundColor:"transparent",
    animationDuration:280,
    grid:{left:8,right:14,top:16,bottom:8,containLabel:true},
    xAxis:{type:"time",axisLine:{lineStyle:{color:t.border}},axisLabel:{color:t.textDim,fontSize:10,hideOverlap:true},axisTick:{show:false},splitLine:{show:false}},
    yAxis:{type:"value",axisLine:{show:false},axisTick:{show:false},splitLine:{lineStyle:{color:t.border,opacity:.5}},axisLabel:{color:t.textDim,fontSize:10,formatter:yFormat||(v=>v)}},
    tooltip:{
      trigger:"axis",backgroundColor:t.surface,borderColor:t.border,textStyle:{color:t.text,fontSize:12},extraCssText:"box-shadow:0 10px 30px rgba(0,0,0,.25);",
      axisPointer:{type:"line",lineStyle:{color:t.textDim}},
      formatter:(params)=>{ const p=params&&params[0]; if(!p||!p.data) return ""; const d=new Date(p.axisValue); const raw=p.data[2]; return `${fmtDate(d)}<br/><b>${formatValue?formatValue(raw):raw}</b>`; }
    },
    series:[{
      type:"line",data,showSymbol:false,smooth:false,connectNulls:true,
      lineStyle:{width:2.5,color},itemStyle:{color},
      emphasis:{focus:"series"},
      areaStyle: areaOpacity>0 ? {color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:colorWithAlpha(color,areaOpacity)},{offset:1,color:colorWithAlpha(color,0)}])} : undefined,
      markLine: markLineData.length ? {symbol:"none",silent:true,lineStyle:{color:t.border,type:"dashed",width:1},label:{show:false},data:markLineData} : undefined
    }]
  };
}

function renderEquityChart(id, points, {color, area=true, zoom=false}={}){
  const chart=getEChart(id); if(!chart) return;
  const t=chartTheme();
  const option=buildLineOption({points,valueKey:"balance",color:color||t.accent1,theme:t,formatValue:v=>plainMoney(v),yFormat:v=>`$${Number(v).toLocaleString(undefined,{maximumFractionDigits:0})}`,areaOpacity:area?0.25:0});
  if(zoom && points.length>2){
    option.dataZoom=[
      {type:"inside",throttle:50},
      {type:"slider",height:14,bottom:0,borderColor:t.border,fillerColor:colorWithAlpha(t.accent1,0.14),handleStyle:{color:t.accent1,borderColor:t.accent1},textStyle:{color:t.textDim,fontSize:9},dataBackground:{lineStyle:{color:t.border},areaStyle:{color:t.border,opacity:.3}},moveHandleStyle:{color:t.accent1}}
    ];
    option.grid.bottom=32;
  }
  chart.setOption(option,true);
}

function renderDrawdownChart(id, points){
  const chart=getEChart(id); if(!chart) return;
  const t=chartTheme();
  const option=buildLineOption({points,valueKey:"balance",color:t.danger,theme:t,formatValue:v=>plainMoney(v),yFormat:v=>`-$${Math.abs(Number(v)).toLocaleString(undefined,{maximumFractionDigits:0})}`,invert:true,zeroLine:true,areaOpacity:0.32});
  chart.setOption(option,true);
}

function renderProgressChart(id, points, targetPct=100){
  const chart=getEChart(id); if(!chart) return;
  const t=chartTheme();
  const option=buildLineOption({points,valueKey:"balance",color:t.accent2,theme:t,formatValue:v=>`${number(v,1)}%`,yFormat:v=>`${Number(v).toFixed(0)}%`,targetLine:targetPct,areaOpacity:0.22});
  const maxVal=Math.max(targetPct,...points.map(p=>n(p.balance)),0);
  option.yAxis.min=0; option.yAxis.max=Math.max(targetPct, Math.ceil(maxVal/10)*10);
  chart.setOption(option,true);
}

function renderDailyPLBarChart(id, rows){
  const chart=getEChart(id); if(!chart) return;
  const t=chartTheme();
  const vals=rows.map(r=>n(r.pl));
  const cats=rows.map(r=>r.label);
  const option={
    backgroundColor:"transparent",
    animationDuration:280,
    grid:{left:8,right:8,top:16,bottom:22,containLabel:true},
    xAxis:{type:"category",data:cats,axisLine:{lineStyle:{color:t.border}},axisTick:{show:false},axisLabel:{color:t.textDim,fontSize:9,hideOverlap:true,formatter:v=>{const d=new Date(`${v}T00:00:00`);return Number.isNaN(d.getTime())?v:d.toLocaleDateString(undefined,{month:"short",day:"numeric"});}}},
    yAxis:{type:"value",axisLine:{show:false},axisTick:{show:false},splitLine:{lineStyle:{color:t.border,opacity:.5}},axisLabel:{color:t.textDim,fontSize:10,formatter:v=>`$${Number(v).toLocaleString(undefined,{maximumFractionDigits:0})}`}},
    tooltip:{
      trigger:"axis",backgroundColor:t.surface,borderColor:t.border,textStyle:{color:t.text,fontSize:12},extraCssText:"box-shadow:0 10px 30px rgba(0,0,0,.25);",
      axisPointer:{type:"shadow"},
      formatter:(params)=>{ const p=params&&params[0]; if(!p) return ""; const d=new Date(`${p.axisValue}T00:00:00`); const lbl=Number.isNaN(d.getTime())?p.axisValue:d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); return `${lbl}<br/><b>${money(p.data)}</b>`; }
    },
    series:[{
      type:"bar",data:vals,barMaxWidth:26,
      itemStyle:{color:(params)=>vals[params.dataIndex]>=0?t.safe:t.danger,borderRadius:[3,3,3,3]},
      emphasis:{itemStyle:{color:(params)=>vals[params.dataIndex]>=0?t.safe:t.danger,opacity:.8}},
      markLine: rows.length ? {symbol:"none",silent:true,lineStyle:{color:t.border,width:1},label:{show:false},data:[{yAxis:0}]} : undefined
    }]
  };
  chart.setOption(option,true);
}

function renderCharts(metrics) {
  renderEquityChart("equity-chart", filteredEquityPoints(metrics,state.equityPeriod), {zoom:true});
  renderEquityChart("growth-chart", filteredEquityPoints(metrics,state.growthPeriod), {color:chartTheme().safe});

  const filtered=periodFilter(metrics.sorted,state.performancePeriod,state.customRange);
  const daily=aggregateByDay(filtered);
  const dailyRows=Object.keys(daily).sort().map(k=>({date:new Date(k+"T00:00:00"),pl:daily[k].pl,label:k}));
  renderDailyPLBarChart("performance-chart", dailyRows);

  let peak=metrics.start;
  const ddPoints=metrics.equityPoints.map(p=>{ peak=Math.max(peak,n(p.balance)); return {date:p.date,balance:peak-n(p.balance)}; });
  const [ds,de]=periodBounds(state.performancePeriod,state.customRange);
  const ddFiltered=ddPoints.filter(p=>p.date>=ds&&p.date<=de);
  renderDrawdownChart("drawdown-chart", ddFiltered.length?ddFiltered:[{date:new Date(),balance:0}]);

  let running=metrics.start; const progressPoints=[];
  for(const point of metrics.equityPoints){ running=n(point.balance); progressPoints.push({date:point.date, balance: metrics.targetAmount>0 ? Math.max(0,Math.min(100,(running-metrics.start)/metrics.targetAmount*100)) : 0}); }
  const [ps,pe]=periodBounds(state.performancePeriod,state.customRange);
  const prog=progressPoints.filter(p=>p.date>=ps&&p.date<=pe);
  renderProgressChart("challenge-progress-chart", prog.length?prog:[{date:new Date(),balance:0}]);
}

function renderStatistics(metrics) {
  const section=document.getElementById("performance-statistics");if(!section)return;
  const periodTrades=periodFilter(metrics.sorted,state.performancePeriod,state.customRange);const wins=periodTrades.filter(t=>tradeResult(t)==="win"),losses=periodTrades.filter(t=>tradeResult(t)==="loss"),be=periodTrades.filter(t=>tradeResult(t)==="breakeven");const grossWin=wins.reduce((s,t)=>s+Math.max(0,tradePL(t)),0),grossLoss=losses.reduce((s,t)=>s+Math.abs(Math.min(0,tradePL(t))),0);const pf=grossLoss>0?grossWin/grossLoss:(grossWin>0?Infinity:0);const avgWin=wins.length?grossWin/wins.length:0,avgLoss=losses.length?grossLoss/losses.length:0;const bestWin=wins.length?Math.max(...wins.map(tradePL)):0,worstLoss=losses.length?Math.min(...losses.map(tradePL)):0;const riskTotal=periodTrades.reduce((s,t)=>s+tradeRiskAmount(t),0);const avgR=riskTotal?periodTrades.reduce((s,t)=>s+tradePL(t),0)/riskTotal:0;const days=new Set(periodTrades.map(t=>isoDay(tradeDate(t)))).size;const byDay=aggregateByDay(periodTrades);const bestDay=Math.max(0,...Object.values(byDay).map(x=>x.pl)),worstDay=Math.min(0,...Object.values(byDay).map(x=>x.pl));const periodPL=periodTrades.reduce((s,t)=>s+tradePL(t),0);const vals=[periodTrades.length,wins.length,losses.length,be.length,`${number((wins.length+losses.length)?wins.length/(wins.length+losses.length)*100:0,1)}%`,money(avgWin),losses.length?`-${plainMoney(avgLoss)}`:plainMoney(0),money(bestWin),losses.length?`-${plainMoney(Math.abs(worstLoss))}`:plainMoney(0),Number.isFinite(pf)?number(pf,2):"∞",`${number(avgR,2)}R`,money(periodPL),money(bestDay),money(worstDay),`${number(metrics.maxDdPct,2)}%`,metrics.maxDdMoney===0||metrics.balance>=metrics.start+metrics.maxDdMoney?"Recovered":"In drawdown",`${number(periodTrades.length?periodTrades.reduce((s,t)=>s+tradeRiskPct(t,metrics.balance),0)/periodTrades.length:0,2)}%`,`${number(periodTrades.reduce((s,t)=>s+tradeRiskPct(t,metrics.balance),0),2)}%`,days];const items=$$(".ch-stat-item",section);items.forEach((item,i)=>{const el=$(".ch-num",item);if(el&&vals[i]!==undefined)el.textContent=vals[i];el?.classList.toggle("ch-pos",[1,4,5,7,11,12].includes(i));el?.classList.toggle("ch-neg",[2,6,8,13].includes(i));});
}

function renderGrowth(metrics) {
  const section=document.getElementById("account-growth");if(!section)return;const blocks=$$(".ch-grid-4 > div",section).slice(0,4);const growth=metrics.start>0?metrics.totalPL/metrics.start*100:0;
  if(blocks[0])$(".ch-num",blocks[0]).textContent=plainMoney(metrics.start);if(blocks[1])$(".ch-num",blocks[1]).textContent=plainMoney(metrics.balance);if(blocks[2])$(".ch-num",blocks[2]).textContent=money(metrics.totalPL);if(blocks[3])$(".ch-num",blocks[3]).textContent=`${number(growth,2)}%`;
}

function renderTradingDays(metrics) {
  const section = document.getElementById("trading-day-control"); if (!section) return;
  const card = section.querySelector(".ch-grid-2 > .ch-card"); if (!card) return;
  const rows = $$(".ch-risk-row", card);
  const vals = [metrics.tradingDays, metrics.rules.minTradingDays || "—", metrics.rules.maxTradingDays || "—", metrics.rules.deadline ? metrics.rules.deadline.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "—"];
  rows.forEach((r,i)=>{const num=$(".ch-num",r);if(num&&vals[i]!==undefined)num.textContent=vals[i];});
  const dots = $(".ch-trading-days-row",card);
  if (dots) {
    const count = Math.max(metrics.tradingDays, metrics.rules.minTradingDays || 0, 1);
    dots.innerHTML = Array.from({length:Math.min(Math.max(count,12),30)},(_,i)=>`<span class="ch-td-dot ${i < metrics.tradingDays ? "ch-td-done" : ""}">${i+1}</span>`).join("");
  }
}

function renderPayout(metrics) {
  const card = document.getElementById("payout-progress"); if (!card) return;
  const withdraw = n(getByAliases(state.account,["withdrawableProfit","withdrawable","payoutAmount"], Math.max(0,metrics.totalPL)));
  const split = String(metrics.rules.payoutSplit || "80/20");
  const nums = $$(".ch-payout-hero .ch-num",card); if(nums[0])nums[0].textContent=plainMoney(withdraw);
  const rows = $$(".ch-payout-split-row b",card);
  if(rows[0])rows[0].textContent=split;
  if(rows[1])rows[1].textContent=metrics.targetReached?"Review firm payout requirements":"Available after funding";
  if(rows[2])rows[2].textContent=metrics.targetReached?"Potentially Eligible":"Not Eligible";
  const bar=$(".ch-bar-fill",card);if(bar){const target=metrics.targetAmount||1;bar.style.width=`${Math.max(0,Math.min(100,metrics.totalPL/target*100))}%`;}
}

function renderHealth(metrics) {
  const section=document.getElementById("account-health");if(!section)return;
  const draw=Number.isFinite(metrics.overallLimit)&&metrics.overallLimit>0?Math.max(0,100-metrics.dangerOverall):100;
  const risk=metrics.rules.riskPerDayPct>0?Math.max(0,100-Math.min(100,metrics.todayRiskPct/metrics.rules.riskPerDayPct*100)):100;
  const compliance=Math.max(0,100-([metrics.dailyDdStop,metrics.overallDdStop,metrics.consecutiveLossStop,metrics.maxTradesStop].filter(Boolean).length*25));
  const target=Math.min(100,Math.max(0,metrics.targetProgress));
  const consistency=metrics.consistency===null?100:Math.max(0,100-Math.max(0,metrics.consistency-(metrics.rules.consistencyPct||metrics.consistency))*2);
  const score=Math.round((draw+risk+compliance+target+consistency)/5);setText("account-health-score",String(score));
  const ring=$(".ch-health-ring-fill",section);if(ring){const r=46,c=2*Math.PI*r;ring.style.strokeDasharray=`${c}`;ring.style.strokeDashoffset=`${c*(1-score/100)}`;}
  const vals=[draw,risk,compliance,target,consistency];$$('.ch-health-factor',section).forEach((row,i)=>{const bar=$(".ch-bar-fill",row);const b=$("b",row);if(bar)bar.style.width=`${vals[i]}%`;if(b)b.textContent=number(vals[i],0);});
}

function renderRiskDiscipline(metrics) {
  const section=document.getElementById("account-health");if(!section)return;const cards=$$(".ch-card",section.parentElement);const riskCard=cards[1];if(!riskCard)return;const rows=$$(".ch-risk-row",riskCard);const avg=metrics.avgRiskPct;const maxRisk=metrics.sorted.length?Math.max(...metrics.sorted.map(t=>tradeRiskPct(t,metrics.balance))):0;const riskBudget=metrics.rules.riskPerDayPct;const over=metrics.sorted.filter(t=>riskBudget>0&&tradeRiskAmount(t)>metrics.balance*riskBudget/100).length;const vals=[`${number(avg,2)}%`,`${number(maxRisk,2)}%`,`${number(metrics.todayRiskPct,2)}%`,avg<=Math.max(0,metrics.rules.riskPerTradePct)*1.25||!metrics.rules.riskPerTradePct?"High":"Check",String(over),String(over)];rows.forEach((r,i)=>{const el=$(".ch-num",r);if(el&&vals[i]!==undefined)el.textContent=vals[i];});}

function renderRulesConfig(metrics) {
  const section = document.getElementById("account-rules-configuration"); if (!section) return;
  const rows = $$(".ch-config-row",section);
  const defs = [
    ["Daily Drawdown", metrics.rules.dailyDdPct ? `Maximum ${number(metrics.rules.dailyDdPct,2)}% of balance` : plainMoney(metrics.dailyLimit), metrics.rules.dailyDdPct > 0 || metrics.rules.dailyDdAmount > 0],
    ["Overall Drawdown", metrics.rules.overallDdPct ? `Maximum ${number(metrics.rules.overallDdPct,2)}% of balance` : plainMoney(metrics.overallLimit), metrics.rules.overallDdPct > 0 || metrics.rules.overallDdAmount > 0],
    ["Trailing Drawdown", metrics.rules.trailingDdPct ? `Maximum ${number(metrics.rules.trailingDdPct,2)}%` : "Not configured", metrics.rules.trailingDdPct > 0 || metrics.rules.trailingDdAmount > 0],
    ["Consistency Rule", metrics.rules.consistencyPct ? `No single day > ${number(metrics.rules.consistencyPct,1)}% of total profit` : "Not configured", metrics.rules.consistencyPct > 0],
    ["Minimum Trading Days", `${metrics.rules.minTradingDays || 0} days required`, metrics.rules.minTradingDays > 0],
    ["Maximum Trades / Day", `${metrics.rules.maxTradesDay || 0} trades`, metrics.rules.maxTradesDay > 0],
    ["News Trading", metrics.rules.newsAllowed ? "Allowed" : "Restricted", metrics.rules.newsAllowed],
    ["Weekend Holding", metrics.rules.weekendHolding ? "Allowed" : "Restricted", metrics.rules.weekendHolding],
    ["Hedging", metrics.rules.hedgingAllowed ? "Permitted" : "Not permitted", metrics.rules.hedgingAllowed],
    ["Stop After Losses", `${metrics.rules.maxLossesDay || 0} losses`, metrics.rules.maxLossesDay > 0]
  ];
  rows.forEach((row,i)=>{if(!defs[i])return;const [name,desc,on]=defs[i];const nameEl=$(".ch-config-name",row);const sw=$(".ch-switch",row);if(nameEl){const span=$("span",nameEl);if(span)span.textContent=desc;nameEl.childNodes[0].nodeValue=name+" ";}if(sw)sw.classList.toggle("ch-on",!!on);});
}

function renderTimeline(metrics) {
  const section=document.getElementById("challenge-timeline");if(!section)return;const active=currentPhase(state.account);const items=$$(".ch-timeline-item",section);const start=toDate(state.account?.startDate);const fmt=d=>d?d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"—";const statuses=[true,active>=1,active===1,active>=2,active>=3,active>=4,Boolean(state.account?.lastPayoutAt||state.account?.payoutDate)];items.forEach((item,i)=>{item.classList.toggle("ch-tl-done",!!statuses[i]);item.classList.toggle("ch-tl-active",i===active+1&&!statuses[i]);const dateEl=$(".ch-timeline-date",item);if(!dateEl)return;if(i===0)dateEl.textContent=fmt(start);else if(i===1)dateEl.textContent=active>=1?fmt(start):"Pending";else if(i===2)dateEl.textContent=active===1?`${number(metrics.targetProgress,0)}% toward target`:active>1?"Passed":"Pending";else if(i===3)dateEl.textContent=active>=2?"Started":"Pending";else if(i===4)dateEl.textContent=active>=3?"Passed":"Pending";else if(i===5)dateEl.textContent=active>=4?"Funded":"Pending";else dateEl.textContent=statuses[i]?"Recorded":"Pending";});
}

function renderAlerts(metrics) {
  const list = $("#account-alert-center .ch-alert-list"); if (!list) return;
  const alerts=[];
  if(metrics.overallDdStop) alerts.push(["danger","Account breached","Overall drawdown limit reached."]);
  else if(metrics.dangerOverall>=75) alerts.push(["warning","Overall drawdown approaching",`${number(metrics.overallRemaining / Math.max(1,metrics.overallLimit)*100,1)}% of overall drawdown remains.`]);
  if(metrics.dailyDdStop) alerts.push(["danger","Daily drawdown reached","Trading should be stopped for today."]);
  else if(metrics.dangerDaily>=70) alerts.push(["warning","Daily drawdown approaching",`${number(metrics.dangerDaily,1)}% of today's limit has been used.`]);
  if(metrics.targetReached) alerts.push(["success","Profit target reached","Review the firm's exact pass conditions before advancing the phase."]);
  if(metrics.consecutiveLossStop) alerts.push(["danger","Loss limit reached",`You've reached ${metrics.todayLosses} losses today.`]);
  if(metrics.maxTradesStop) alerts.push(["danger","Maximum trades reached",`You've reached ${metrics.todayTrades} trades today.`]);
  if(!alerts.length) alerts.push(["success","Account healthy","No calculated risk-control alerts are active."]);
  list.innerHTML=alerts.slice(0,8).map(([kind,title,desc])=>`<div class="ch-alert ch-alert-${kind}"><span class="ch-alert-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span><div><div class="ch-alert-title">${escapeHtml(title)}</div><div class="ch-alert-desc">${escapeHtml(desc)}</div></div><span class="ch-alert-time">Now</span></div>`).join("");
}

function renderCalendar(metrics) {
  const section=document.getElementById("performance-calendar");const grid=section?.querySelector(".ch-cal-grid");if(!grid)return;const d=new Date(state.calendarDate);const daily=aggregateByDay(metrics.sorted);const view=state.calendarView;let cells="";
  if(view==="year"){
    for(let m=0;m<12;m++){const monthStart=new Date(d.getFullYear(),m,1);const monthEnd=new Date(d.getFullYear(),m+1,0,23,59,59,999);const rows=metrics.sorted.filter(t=>{const x=tradeDate(t);return x&&x>=monthStart&&x<=monthEnd});const pl=rows.reduce((s,t)=>s+tradePL(t),0);cells+=`<button type="button" class="ch-cal-day ${pl>0?"ch-cal-profit":pl<0?"ch-cal-loss":""}" data-month="${m}"><span class="ch-cal-date">${monthStart.toLocaleDateString(undefined,{month:"short"})}</span><span class="ch-cal-pl">${rows.length?money(pl):"—"}</span><span class="ch-cal-badge">${rows.length} trades</span></button>`;}
    grid.style.gridTemplateColumns="repeat(3,minmax(0,1fr))";
    const title=section.querySelector(".ch-cal-title");if(title)title.textContent=String(d.getFullYear());return;
  }
  grid.style.gridTemplateColumns="repeat(7,minmax(0,1fr))";
  const dows=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let days=[];
  if(view==="week"){const start=startOfWeek(d);for(let i=0;i<7;i++){const x=new Date(start);x.setDate(start.getDate()+i);days.push(x);}}
  else {const first=new Date(d.getFullYear(),d.getMonth(),1);const last=new Date(d.getFullYear(),d.getMonth()+1,0);for(let i=0;i<first.getDay();i++)days.push(null);for(let day=1;day<=last.getDate();day++)days.push(new Date(d.getFullYear(),d.getMonth(),day));}
  cells=dows.map(x=>`<div class="ch-cal-dow">${x}</div>`).join("")+days.map(x=>{if(!x)return `<div class="ch-cal-day ch-cal-empty"></div>`;const key=isoDay(x);const item=daily[key];const pl=item?.pl||0;const cls=pl>0?"ch-cal-profit":pl<0?"ch-cal-loss":"";return `<button type="button" class="ch-cal-day ${cls}${isoDay(new Date())===key?" ch-cal-today":""}" data-date="${key}"><span class="ch-cal-date">${x.getDate()}</span>${item?`<span class="ch-cal-pl">${money(pl)}</span><span class="ch-cal-badge">${item.trades.length}</span>`:""}</button>`;}).join("");
  grid.innerHTML=cells;const title=section.querySelector(".ch-cal-title");if(title)title.textContent=view==="week"?`${days.find(Boolean).toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${days.slice().reverse().find(Boolean).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}`:d.toLocaleDateString(undefined,{month:"long",year:"numeric"});
}

function renderExplorer(metrics) {
  const grid=document.getElementById("explorer-grid");if(!grid)return;
  const level=state.explorerLevel;let source=metrics.sorted;let data={};
  if(level==="year") data=aggregateByYear(source);
  else if(level==="month") { const y=Number(state.explorerValue)||new Date().getFullYear(); source=source.filter(t=>{const d=tradeDate(t);return d&&d.getFullYear()===y;}); data=aggregateByMonth(source); }
  else if(level==="week") { const m=/^(\d{4})-(\d{2})$/.exec(state.explorerValue||""); if(m)source=source.filter(t=>{const d=tradeDate(t);return d&&d.getFullYear()===Number(m[1])&&d.getMonth()+1===Number(m[2]);}); data=aggregateByWeek(source); }
  else { const w=startOfWeek(new Date(`${state.explorerValue}T00:00:00`)); source=source.filter(t=>{const d=tradeDate(t);return d&&d>=w&&d<=endOfDay(new Date(w.getFullYear(),w.getMonth(),w.getDate()+6));}); data=aggregateByDay(source); }
  const keys=Object.keys(data).sort();
  grid.innerHTML=keys.length?keys.map(k=>{const x=data[k];let label=k;if(level==="year")label=k;else if(level==="month")label=x.start.toLocaleDateString(undefined,{month:"short",year:"numeric"});else if(level==="week")label=`Week of ${x.start.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`;else label=new Date(k+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});const next=level==="year"?"month":level==="month"?"week":level==="week"?"day":"day";return `<button type="button" class="ch-explorer-cell ${x.pl>=0?"ch-pos":"ch-neg"}" data-level="${next}" data-value="${escapeHtml(k)}"><span class="ch-explorer-cell-label">${escapeHtml(label)}</span><span class="ch-explorer-cell-value">${money(x.pl)}</span></button>`;}).join(""):`<div class="ch-empty"><strong>No trades yet.</strong><span>Nothing recorded for this period.</span></div>`;
  const crumb=document.getElementById("explorer-breadcrumbs");if(crumb){let html=`<button type="button" class="ch-active" data-level="year">${level==="year"?new Date().getFullYear():state.explorerValue?.slice(0,4)||new Date().getFullYear()}</button>`;if(level!=="year")html+=`<span>›</span><button type="button" class="ch-active" data-level="${level}">${escapeHtml(state.explorerValue||level)}</button>`;crumb.innerHTML=html;}
}

function renderAll() {
  if (!state.account) return;
  hideEmptyAccountState();
  const metrics=calcMetrics(state.account,state.trades);state.lastMetrics=metrics;
  renderHeader(metrics);renderOverview(metrics);renderPhase(metrics);renderDrawdown(metrics);renderRisk(metrics);renderRuleMonitor(metrics);renderCharts(metrics);renderStatistics(metrics);renderGrowth(metrics);renderTradingDays(metrics);renderPayout(metrics);renderHealth(metrics);renderRiskDiscipline(metrics);renderRulesConfig(metrics);renderTimeline(metrics);renderAlerts(metrics);renderCalendar(metrics);renderExplorer(metrics);
}

function showEmptyAccountState() {
  const trigger=document.getElementById("ch-account-trigger");if(trigger){$(".ch-account-trigger-name",trigger).textContent="No accounts yet";$(".ch-account-trigger-meta",trigger).textContent="Create an account to begin";}
  ["current-balance","starting-balance","current-profit","today-pl","profit-progress","today-risk","danger-percentage","recommended-risk","maximum-risk"].forEach(id=>setText(id,"—"));
  const overview=document.getElementById("account-overview");if(!overview)return;
  $$(".ch-section").forEach(sec=>{if(sec.id!=="account-overview")sec.dataset.hiddenNoAccount="true",sec.style.display="none";});
  const grid=overview.querySelector(".ch-grid");if(grid)grid.style.display="none";
  if(!document.getElementById("ch-empty-account-cta")){
    const wrap=document.createElement("div");wrap.id="ch-empty-account-cta";wrap.className="ch-card ch-empty";
    wrap.innerHTML=`<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg><strong>No accounts yet.</strong><span>Create a challenge account to start tracking it.</span><button type="button" class="ch-btn ch-btn-primary" id="ch-empty-create-account-btn" style="margin-top:10px;">+ Create Account</button>`;
    overview.appendChild(wrap);
    document.getElementById("ch-empty-create-account-btn")?.addEventListener("click",openCreateAccountModal);
  }
}
function hideEmptyAccountState(){
  const overview=document.getElementById("account-overview");if(!overview)return;
  const grid=overview.querySelector(".ch-grid");if(grid)grid.style.display="";
  $$(".ch-section[data-hidden-no-account]").forEach(sec=>{sec.style.display="";delete sec.dataset.hiddenNoAccount;});
  document.getElementById("ch-empty-account-cta")?.remove();
}

/* ---------------------------------------------------------------
   ADD TRADE — wires the single real modal already defined in
   challenge.html (#addTradeModalOverlay / #addTradeForm). There is
   intentionally no second button and no second modal created here.
   --------------------------------------------------------------- */
function openTradeModal() {
  if (!state.uid) { showToast("Please sign in first.","warning"); return; }
  if (!state.activeAccountId) { showToast("Create or select a challenge account first.","warning"); return; }
  const overlay=document.getElementById("addTradeModalOverlay");const form=document.getElementById("addTradeForm");
  if(!overlay||!form)return;
  form.reset();
  const dateField=form.elements["date"];if(dateField)dateField.value=new Date().toISOString().slice(0,10);
  const timeField=form.elements["entryTime"];if(timeField){const now=new Date();timeField.value=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;}
  overlay.classList.add("ch-modal-open");overlay.setAttribute("aria-hidden","false");document.body.style.overflow="hidden";
  updateModalRiskPreview();
  setTimeout(()=>document.getElementById("instrument")?.focus(),50);
}
function closeTradeModal(){
  const overlay=document.getElementById("addTradeModalOverlay");if(!overlay)return;
  overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  if(!document.querySelector(".ch-modal-overlay.ch-modal-open"))document.body.style.overflow="";
  document.getElementById("add-trade-btn")?.focus();
}
function updateModalRiskPreview(){
  const m=state.lastMetrics;const form=document.getElementById("addTradeForm");if(!form)return;
  const risk=n(form.elements["riskAmount"]?.value);const max=m?m.maximumRisk:Infinity;
  const preview=document.getElementById("ch-trade-risk-preview");
  if(!preview){
    const foot=$(".ch-modal-foot",form);
    if(foot){const div=document.createElement("div");div.id="ch-trade-risk-preview";div.className="ch-form-group-full";div.style.cssText="padding:12px 14px;border-radius:12px;background:var(--eva-surface-2);border:1px solid var(--eva-border);font-size:.8rem;line-height:1.5;margin-bottom:14px;";foot.parentElement.insertBefore(div,foot);}
    return;
  }
  if(!m){preview.innerHTML="Risk check: select an account first.";return;}
  const over=Number.isFinite(max)&&max>0&&risk>max;
  preview.innerHTML=over
    ?`<strong style="color:var(--ch-danger)">Risk too high.</strong> Planned ${plainMoney(risk)} vs calculated maximum ${plainMoney(max)}.`
    :`<strong style="color:var(--ch-safe)">${risk>0?"Risk within calculated limit.":"Risk check: enter a risk amount."}</strong> Recommended ${plainMoney(m.recommendedRisk)} · Maximum ${Number.isFinite(max)?plainMoney(max):"—"}.`;
}

async function saveTradeFromModal(e){
  e.preventDefault();
  if (!state.uid || !state.activeAccountId) { showToast("Create or select a challenge account first.","warning"); return; }
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const risk=Math.abs(n(data.riskAmount));const max=state.lastMetrics?.maximumRisk ?? Infinity;
  if(Number.isFinite(max)&&risk>max){showToast(`Trade risk is above the calculated maximum of ${plainMoney(max)}.`,"warning");return;}
  if(state.lastMetrics?.stopTrading){showToast("Trading is currently blocked by your configured risk rules.","error");return;}
  const instrument=String(data.instrument||"").trim();
  if(!instrument){showToast("Instrument is required.","error");return;}
  if(!data.date){showToast("Trade date is required.","error");return;}
  const dateTimeStr=data.entryTime?`${data.date}T${data.entryTime}`:`${data.date}T00:00`;
  const tradeDateValue=new Date(dateTimeStr);
  if(Number.isNaN(tradeDateValue.getTime())){showToast("Invalid trade date.","error");return;}
  const balance=state.lastMetrics?.balance||0;
  // Enforce the sign of profitLoss from the selected result — this is the
  // actual source of the "loss becomes positive" bug: the P/L field is a
  // free-typed number (placeholder "e.g. 42.00 or -18.00") and nothing
  // previously stopped a user from selecting "Loss" but typing a plain
  // positive number, or vice versa. Math.abs is used only to read the
  // magnitude the user entered; the sign is then set explicitly and
  // unconditionally from result, never left to trust manual entry.
  const resultVal = data.result || "breakeven";
  const plMagnitude = Math.abs(n(data.plAmount));
  const profitLoss = resultVal === "win" ? plMagnitude
    : resultVal === "loss" ? -plMagnitude
    : 0; // breakeven is always exactly zero, regardless of what was typed
  const trade={
    userID:state.uid, accountID:state.activeAccountId,
    tradeNumber:data.tradeNumber?n(data.tradeNumber):null,
    tradeDate:Timestamp.fromDate(tradeDateValue), date:data.date, entryTime:data.entryTime||null,
    symbol:instrument, instrument, direction:data.direction||"long",
    entryPrice:n(data.entryPrice), stopLoss:n(data.stopLoss), takeProfit:n(data.takeProfit),
    riskAmount:risk, riskPercentage:n(data.riskPercentage)||(balance>0?risk/balance*100:0),
    result:resultVal, profitLoss,
    notes:String(data.notes||"").trim(), createdAt:serverTimestamp(), updatedAt:serverTimestamp()
  };
  try{
    const ref=await addDoc(tradesRef(state.activeAccountId),trade);
    // Keep an optional last-trade pointer on the account document. This uses the
    // already-authorized account update rule and does not require new subcollection rules.
    await updateDoc(accountRef(state.activeAccountId),{lastTradeId:ref.id,lastTradeAt:serverTimestamp()}).catch(()=>{});
    closeTradeModal();showToast("Trade added.","success");
  }catch(err){showToast(friendlyError(err),"error");}
}

function wireAddTrade(){
  document.getElementById("add-trade-btn")?.addEventListener("click",openTradeModal);
  document.getElementById("addTradeForm")?.addEventListener("submit",saveTradeFromModal);
  document.getElementById("addTradeForm")?.elements["riskAmount"]?.addEventListener("input",updateModalRiskPreview);
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="addTradeModal"]'))closeTradeModal();
    if(e.target.id==="addTradeModalOverlay")closeTradeModal();
  });
}

/* ---------------------------------------------------------------
   CREATE ACCOUNT — writes a brand new document to
   users/{uid}/accounts/{auto-id}. Only fields the user actually
   filled in are stored as enforced rules; blank/zero fields are
   read by normalizedRules() as "not configured" so calcMetrics()
   never flags a rule the trader didn't ask to be monitored.
   --------------------------------------------------------------- */
function openCreateAccountModal(){
  if(!state.uid){showToast("Please sign in first.","warning");return;}
  const overlay=document.getElementById("createAccountModalOverlay");const form=document.getElementById("createAccountForm");
  if(!overlay||!form)return;
  form.reset();
  const startDateField=form.elements["startDate"];if(startDateField)startDateField.value=new Date().toISOString().slice(0,10);
  resetPhaseRuleSwitch("ca-phase-rules-switch");
  overlay.classList.add("ch-modal-open");overlay.setAttribute("aria-hidden","false");document.body.style.overflow="hidden";
  document.getElementById("account-selector")?.querySelector(".ch-account-panel")?.classList.remove("ch-open");
  document.getElementById("ch-account-trigger")?.classList.remove("ch-open");
  setTimeout(()=>document.getElementById("ca-name")?.focus(),50);
}
function closeCreateAccountModal(){
  const overlay=document.getElementById("createAccountModalOverlay");if(!overlay)return;
  overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  if(!document.querySelector(".ch-modal-overlay.ch-modal-open"))document.body.style.overflow="";
  document.getElementById("create-account-btn")?.focus();
}

function readPhaseRulesFromData(data, prefix){
  return {
    profitTargetPct: n(data[`${prefix}_profitTargetPct`],0),
    dailyDrawdownPct: n(data[`${prefix}_dailyDrawdownPct`],0),
    overallDrawdownPct: n(data[`${prefix}_overallDrawdownPct`],0),
    trailingDrawdownPct: n(data[`${prefix}_trailingDrawdownPct`],0),
    consistencyPct: n(data[`${prefix}_consistencyPct`],0),
    minimumTradingDays: n(data[`${prefix}_minimumTradingDays`],0),
    maximumTradingDays: n(data[`${prefix}_maximumTradingDays`],0),
    maxTradesPerDay: n(data[`${prefix}_maxTradesPerDay`],0),
    maxLossesPerDay: n(data[`${prefix}_maxLossesPerDay`],0),
    riskPerTradePct: n(data[`${prefix}_riskPerTradePct`],0),
    riskPerDayPct: n(data[`${prefix}_riskPerDayPct`],0),
    payoutSplit: String(data[`${prefix}_payoutSplit`]||"").trim() || null,
    customRuleNote: String(data[`${prefix}_customRuleNote`]||"").trim() || null
  };
}

function readAllPhaseRulesFromData(data){
  return {
    phase1: readPhaseRulesFromData(data,"p1"),
    phase2: readPhaseRulesFromData(data,"p2"),
    phase3: readPhaseRulesFromData(data,"p3")
  };
}

function fillPhaseRuleForm(form, prefix, rules){
  const r = rules || {};
  const set=(name,val)=>{ if(form.elements[`${prefix}_${name}`]) form.elements[`${prefix}_${name}`].value = val ?? ""; };
  set("profitTargetPct", r.profitTargetPct);
  set("dailyDrawdownPct", r.dailyDrawdownPct);
  set("overallDrawdownPct", r.overallDrawdownPct);
  set("trailingDrawdownPct", r.trailingDrawdownPct);
  set("consistencyPct", r.consistencyPct);
  set("minimumTradingDays", r.minimumTradingDays);
  set("maximumTradingDays", r.maximumTradingDays);
  set("maxTradesPerDay", r.maxTradesPerDay);
  set("maxLossesPerDay", r.maxLossesPerDay);
  set("riskPerTradePct", r.riskPerTradePct);
  set("riskPerDayPct", r.riskPerDayPct);
  set("payoutSplit", r.payoutSplit);
  set("customRuleNote", r.customRuleNote);
}

function resetPhaseRuleSwitch(switchId){
  const sw=document.getElementById(switchId);if(!sw)return;
  const form=sw.closest("form");
  $$("button",sw).forEach(b=>b.classList.toggle("ch-active", b.dataset.phasePanel==="1"));
  if(form) $$("[data-phase-rules-panel]",form).forEach(p=>{p.style.display = p.dataset.phaseRulesPanel==="1" ? "" : "none";});
}

function wirePhaseRuleSwitch(switchId){
  const sw=document.getElementById(switchId);if(!sw)return;
  sw.addEventListener("click",e=>{
    const btn=e.target.closest("button[data-phase-panel]");if(!btn)return;
    const form=sw.closest("form");
    $$("button",sw).forEach(b=>b.classList.toggle("ch-active",b===btn));
    const phase=btn.dataset.phasePanel;
    if(form) $$("[data-phase-rules-panel]",form).forEach(p=>{p.style.display = p.dataset.phaseRulesPanel===phase ? "" : "none";});
  });
}

async function saveAccountFromModal(e){
  e.preventDefault();
  if(!state.uid){showToast("Please sign in first.","warning");return;}
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const name=String(data.accountName||"").trim();
  const size=n(data.accountSize);
  if(!name){showToast("Account name is required.","error");return;}
  if(!(size>0)){showToast("Account size must be greater than zero.","error");return;}
  const startingBalance=data.startingBalance!==""&&data.startingBalance!==undefined?n(data.startingBalance):size;

  const account={
    name, accountName:name, firmName:String(data.firmName||"").trim(),
    accountType:data.accountType||"Custom", status:data.status||"active",
    accountSize:size, startingBalance,
    currentPhase:n(data.currentPhase,1),
    startDate:data.startDate?Timestamp.fromDate(new Date(`${data.startDate}T00:00:00`)):serverTimestamp(),
    deadline:data.deadline?Timestamp.fromDate(new Date(`${data.deadline}T23:59:59`)):null,
    phasesEnabled:{
      phase1: form.elements["phase1Enabled"]?.checked ?? true,
      phase2: form.elements["phase2Enabled"]?.checked ?? false,
      phase3: form.elements["phase3Enabled"]?.checked ?? false
    },
    phaseRules: readAllPhaseRulesFromData(data),
    rules: readPhaseRulesFromData(data,"p1"),
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };

  try{
    const ref=await addDoc(collection(db,"users",state.uid,ACCOUNTS),account);
    closeCreateAccountModal();
    showToast("Account created.","success");
    await loadAccounts();
    await switchAccount(ref.id,false);
  }catch(err){showToast(friendlyError(err),"error");}
}

function wireCreateAccount(){
  document.getElementById("create-account-btn")?.addEventListener("click",openCreateAccountModal);
  wirePhaseRuleSwitch("ca-phase-rules-switch");
  document.getElementById("createAccountForm")?.addEventListener("submit",saveAccountFromModal);
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="createAccountModal"]'))closeCreateAccountModal();
    if(e.target.id==="createAccountModalOverlay")closeCreateAccountModal();
  });
}

// =====================================================
// GENERIC MODAL HELPERS (used by edit/delete/day/risk modals)
// =====================================================
function openGenericModal(overlayId){
  const overlay=document.getElementById(overlayId);if(!overlay)return;
  overlay.classList.add("ch-modal-open");overlay.setAttribute("aria-hidden","false");
  document.getElementById("account-selector")?.querySelector(".ch-account-panel")?.classList.remove("ch-open");
  document.getElementById("ch-account-trigger")?.classList.remove("ch-open");
  document.body.style.overflow="hidden";
}
function closeGenericModal(overlayId){
  const overlay=document.getElementById(overlayId);if(!overlay)return;
  overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  const anyOpen=$$(".ch-modal-overlay.ch-modal-open").length>0;
  if(!anyOpen)document.body.style.overflow="";
}

// =====================================================
// EDIT ACCOUNT
// =====================================================
function activeAccountOrToast(){
  const a=state.accounts.find(x=>x.id===state.activeAccountId);
  if(!a){showToast("Select an account first.","warning");return null;}
  return a;
}

function openEditAccountModal(){
  const a=activeAccountOrToast();if(!a)return;
  const form=document.getElementById("editAccountForm");if(!form)return;
  form.reset();
  const phases=a.phasesEnabled||{};
  const pr=a.phaseRules||{};
  form.elements["accountName"].value=a.name||a.accountName||"";
  form.elements["firmName"].value=a.firmName||"";
  form.elements["accountType"].value=a.accountType||"Custom";
  form.elements["status"].value=a.status||"active";
  form.elements["accountSize"].value=accountStartingBalance(a) || n(a.accountSize,0);
  form.elements["startingBalance"].value=accountStartingBalance(a);
  form.elements["currentPhase"].value=String(currentPhase(a));
  const sd=toDate(a.startDate);if(sd)form.elements["startDate"].value=isoDay(sd);
  const dl=toDate(a.deadline);if(dl)form.elements["deadline"].value=isoDay(dl);
  if(form.elements["phase1Enabled"])form.elements["phase1Enabled"].checked=phases.phase1??true;
  if(form.elements["phase2Enabled"])form.elements["phase2Enabled"].checked=phases.phase2??false;
  if(form.elements["phase3Enabled"])form.elements["phase3Enabled"].checked=phases.phase3??false;
  // Phase 1 falls back to the legacy flat a.rules object for accounts saved before
  // per-phase rules existed, so older accounts don't appear to lose their data.
  fillPhaseRuleForm(form,"p1", pr.phase1 || a.rules || {});
  fillPhaseRuleForm(form,"p2", pr.phase2 || {});
  fillPhaseRuleForm(form,"p3", pr.phase3 || {});
  resetPhaseRuleSwitch("ea-phase-rules-switch");
  openGenericModal("editAccountModalOverlay");
  setTimeout(()=>document.getElementById("ea-name")?.focus(),50);
}
function closeEditAccountModal(){closeGenericModal("editAccountModalOverlay");}

async function saveEditAccountFromModal(e){
  e.preventDefault();
  const a=activeAccountOrToast();if(!a)return;
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const name=String(data.accountName||"").trim();
  const size=n(data.accountSize);
  if(!name){showToast("Account name is required.","error");return;}
  if(!(size>0)){showToast("Account size must be greater than zero.","error");return;}
  const startingBalance=data.startingBalance!==""&&data.startingBalance!==undefined?n(data.startingBalance):size;

  const updates={
    name, accountName:name, firmName:String(data.firmName||"").trim(),
    accountType:data.accountType||"Custom", status:data.status||"active",
    accountSize:size, startingBalance,
    currentPhase:n(data.currentPhase,1),
    startDate:data.startDate?Timestamp.fromDate(new Date(`${data.startDate}T00:00:00`)):a.startDate||null,
    deadline:data.deadline?Timestamp.fromDate(new Date(`${data.deadline}T23:59:59`)):null,
    phasesEnabled:{
      phase1: form.elements["phase1Enabled"]?.checked ?? true,
      phase2: form.elements["phase2Enabled"]?.checked ?? false,
      phase3: form.elements["phase3Enabled"]?.checked ?? false
    },
    phaseRules: readAllPhaseRulesFromData(data),
    rules: readPhaseRulesFromData(data,"p1"),
    updatedAt: serverTimestamp()
  };

  try{
    await updateDoc(accountRef(a.id),updates);
    closeEditAccountModal();
    showToast("Account updated.","success");
  }catch(err){showToast(friendlyError(err),"error");}
}

function wireEditAccount(){
  document.getElementById("edit-account-btn")?.addEventListener("click",openEditAccountModal);
  wirePhaseRuleSwitch("ea-phase-rules-switch");
  document.getElementById("editAccountForm")?.addEventListener("submit",saveEditAccountFromModal);
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="editAccountModal"]'))closeEditAccountModal();
    if(e.target.id==="editAccountModalOverlay")closeEditAccountModal();
  });
}

// =====================================================
// DELETE ACCOUNT
// =====================================================
function openDeleteAccountModal(){
  const a=activeAccountOrToast();if(!a)return;
  document.getElementById("da-account-name").textContent=a.name||a.accountName||a.id;
  document.getElementById("da-account-id").textContent=a.id;
  const input=document.getElementById("da-confirm-input");
  const confirmBtn=document.getElementById("deleteAccountConfirmBtn");
  input.value="";
  confirmBtn.disabled=true;
  confirmBtn.dataset.accountId=a.id;
  confirmBtn.dataset.expectedName=a.name||a.accountName||a.id;
  openGenericModal("deleteAccountModalOverlay");
  setTimeout(()=>input.focus(),50);
}
function closeDeleteAccountModal(){closeGenericModal("deleteAccountModalOverlay");}

async function confirmDeleteAccount(){
  const btn=document.getElementById("deleteAccountConfirmBtn");
  const accountId=btn.dataset.accountId;if(!accountId)return;
  btn.disabled=true;btn.textContent="Deleting…";
  try{
    // delete trades subcollection first
    const tradesSnap=await getDocs(tradesRef(accountId));
    const deletions=[];
    tradesSnap.forEach(docSnap=>deletions.push(deleteDoc(docSnap.ref)));
    await Promise.all(deletions);
    await deleteDoc(accountRef(accountId));
    closeDeleteAccountModal();
    showToast("Account deleted.","success");
    if(state.unsubscribeAccount)state.unsubscribeAccount();
    if(state.unsubscribeTrades)state.unsubscribeTrades();
    state.unsubscribeAccount=null;state.unsubscribeTrades=null;
    if(root())root().dataset.accountId="";
    await loadAccounts(); // handles switching to next account or showing empty state
  }catch(err){
    showToast(friendlyError(err),"error");
    btn.disabled=false;btn.textContent="Delete Account";
  }
}

function wireDeleteAccount(){
  document.getElementById("delete-account-btn")?.addEventListener("click",openDeleteAccountModal);
  document.getElementById("deleteAccountConfirmBtn")?.addEventListener("click",confirmDeleteAccount);
  document.getElementById("da-confirm-input")?.addEventListener("input",e=>{
    const btn=document.getElementById("deleteAccountConfirmBtn");
    btn.disabled = e.target.value.trim() !== (btn.dataset.expectedName||"").trim() || !e.target.value.trim();
  });
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="deleteAccountModal"]'))closeDeleteAccountModal();
    if(e.target.id==="deleteAccountModalOverlay")closeDeleteAccountModal();
  });
}

document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  $$(".ch-modal-overlay.ch-modal-open").forEach(overlay=>{
    overlay.classList.remove("ch-modal-open");overlay.setAttribute("aria-hidden","true");
  });
  if($$(".ch-modal-overlay.ch-modal-open").length===0)document.body.style.overflow="";
});

function wireAccountSelector(){
  const trigger=document.getElementById("ch-account-trigger");const panel=document.getElementById("ch-account-panel");if(!trigger||!panel)return;
  trigger.addEventListener("click",e=>{
    e.stopPropagation();
    const open=panel.classList.toggle("ch-open");
    trigger.classList.toggle("ch-open",open);
    trigger.setAttribute("aria-expanded",String(open));
  });
  document.addEventListener("click",e=>{
    if(!$("#account-selector")?.contains(e.target)){
      panel.classList.remove("ch-open");trigger.classList.remove("ch-open");trigger.setAttribute("aria-expanded","false");
    }
  });
  document.getElementById("account-list")?.addEventListener("click",e=>{
    const item=e.target.closest("[data-account-id]");
    if(item){switchAccount(item.dataset.accountId);panel.classList.remove("ch-open");trigger.classList.remove("ch-open");trigger.setAttribute("aria-expanded","false");}
  });
}

function openCustomRangeModal(target){
  ensureCustomRangeModal(target);
  const form=document.getElementById("ch-custom-range-form");if(!form)return;
  form.dataset.target=target||"performance";form.elements.start.value=state.customRange?.start?isoDay(state.customRange.start):"";form.elements.end.value=state.customRange?.end?isoDay(state.customRange.end):"";openGenericModal("ch-custom-range-overlay");
}
function wirePeriodSwitches(){
  $$(".ch-period-switch").forEach(sw=>sw.addEventListener("click",e=>{const btn=e.target.closest(".ch-period-btn");if(!btn)return;const p=btn.dataset.period;$$('.ch-period-btn',sw).forEach(x=>x.classList.toggle('ch-active',x===btn));const target=sw.dataset.target||'performance-chart';if(p==='custom'){openCustomRangeModal(target);return;}if(target==='equity-chart')state.equityPeriod=p;else if(target==='growth-chart')state.growthPeriod=p;else state.performancePeriod=p;renderAll();}));
  $$(".ch-cal-view-switch button").forEach(btn=>btn.addEventListener("click",()=>{$$(".ch-cal-view-switch button").forEach(x=>x.classList.remove("ch-active"));btn.classList.add("ch-active");state.calendarView=btn.dataset.view||"month";renderAll();}));
}

function navigateCalendar(delta){const d=state.calendarDate;if(state.calendarView==="year")d.setFullYear(d.getFullYear()+delta);else if(state.calendarView==="week")d.setDate(d.getDate()+delta*7);else d.setMonth(d.getMonth()+delta);renderAll();}
function wireCalendar(){
  const section=document.getElementById("performance-calendar");if(!section)return;section.querySelectorAll("button").forEach(btn=>{const label=btn.getAttribute("aria-label");if(label==="Previous month")btn.addEventListener("click",()=>navigateCalendar(-1));if(label==="Next month")btn.addEventListener("click",()=>navigateCalendar(1));});
  section.querySelector(".ch-cal-grid")?.addEventListener("click",e=>{const cell=e.target.closest(".ch-cal-day");if(!cell)return;if(cell.dataset.month!==undefined){state.calendarView="month";state.calendarDate=new Date(state.calendarDate.getFullYear(),n(cell.dataset.month),1);$$(".ch-cal-view-switch button").forEach(x=>x.classList.toggle("ch-active",x.dataset.view==="month"));renderAll();return;}if(cell.dataset.date)showDayModal(cell.dataset.date);});
}

function showDayModal(key){
  const trades=state.trades.filter(t=>isoDay(tradeDate(t))===key);
  if(!trades.length){showToast(`No trades on ${key}.`,"info");return;}
  const pl=trades.reduce((s,t)=>s+tradePL(t),0);
  const title=document.getElementById("dayDetailModalTitle");
  if(title)title.textContent=key;
  const body=document.getElementById("dayDetailModalBody");
  if(body){
    const wins=trades.filter(t=>tradeResult(t)==="win").length;
    const losses=trades.filter(t=>tradeResult(t)==="loss").length;
    const rows=trades.map((t,i)=>{
      const resultCls=tradeResult(t)==="win"?"ch-pos":tradeResult(t)==="loss"?"ch-neg":"";
      return `<div class="ch-day-trade-row"><span>${i+1}. ${escapeHtml(t.symbol||t.instrument||"Trade")} · ${escapeHtml(tradeResult(t))}</span><b class="${resultCls}">${money(tradePL(t))}</b></div>`;
    }).join("");
    body.innerHTML = `
      <div class="ch-form-grid">
        <div class="ch-form-group"><label class="ch-label">Day P/L</label><div class="ch-metric-value ${pl>=0?"ch-pos":"ch-neg"}">${money(pl)}</div></div>
        <div class="ch-form-group"><label class="ch-label">Trades / Wins / Losses</label><div class="ch-metric-value">${trades.length} / ${wins} / ${losses}</div></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
    `;
  }
  openGenericModal("dayDetailModalOverlay");
}

function wireDayDetailModal(){
  document.addEventListener("click",e=>{
    if(e.target.closest && e.target.closest('[data-modal-close="dayDetailModal"]'))closeGenericModal("dayDetailModalOverlay");
    if(e.target.id==="dayDetailModalOverlay")closeGenericModal("dayDetailModalOverlay");
  });
}

function wireExplorer(){
  const sec=document.getElementById("performance-explorer");if(!sec)return;
  sec.addEventListener("click",e=>{const btn=e.target.closest(".ch-explorer-cell");if(!btn)return;const next=btn.dataset.level;if(next==="month"){state.explorerLevel="month";state.explorerValue=btn.dataset.value;}else if(next==="week"){state.explorerLevel="week";state.explorerValue=btn.dataset.value;}else{if(state.explorerLevel==="week")showDayModal(btn.dataset.value);else{state.explorerLevel="day";state.explorerValue=btn.dataset.value;renderAll();}}});
  $$(".ch-explorer-crumbs button",sec).forEach(btn=>btn.addEventListener("click",()=>{state.explorerLevel=btn.dataset.level||"year";renderAll();}));
}

function wireNextTrade(){
  $("#trade-slot-tabs")?.addEventListener("click",e=>{const btn=e.target.closest(".ch-next-trade-tab");if(!btn)return;state.activeTradeSlot=n(btn.dataset.trade,1);renderRisk(state.lastMetrics||calcMetrics(state.account,state.trades));});
  $("#next-trade .ch-btn-icon")?.addEventListener("click",()=>showRiskSettingsModal());
}

function showRiskSettingsModal(){
  const m=state.lastMetrics;if(!m){showToast("Select an account first.","warning");return;}
  const form=document.getElementById("riskSettingsForm");if(!form)return;
  form.elements["riskPerTradePct"].value=m.rules.riskPerTradePct??"";
  form.elements["riskPerDayPct"].value=m.rules.riskPerDayPct??"";
  form.elements["maxTradesDay"].value=m.rules.maxTradesDay??"";
  form.elements["maxLossesDay"].value=m.rules.maxLossesDay??"";
  form.elements["warningThresholdPct"].value=(state.account&&state.account.warningThresholdPct)??"";
  openGenericModal("riskSettingsModalOverlay");
  setTimeout(()=>document.getElementById("rs-risk-trade")?.focus(),50);
}
function closeRiskSettingsModal(){closeGenericModal("riskSettingsModalOverlay");}

async function saveRiskSettingsFromModal(e){
  e.preventDefault();
  if(!state.activeAccountId){showToast("Select an account first.","warning");return;}
  const form=e.currentTarget;const data=Object.fromEntries(new FormData(form).entries());
  const updates={
    riskPerTradePct:n(data.riskPerTradePct),
    riskPerDayPct:n(data.riskPerDayPct),
    maxTradesPerDay:n(data.maxTradesDay),
    maxLossesPerDay:n(data.maxLossesDay),
    warningThresholdPct: data.warningThresholdPct!==""? n(data.warningThresholdPct): null,
    updatedAt:serverTimestamp()
  };
  try{
    await updateDoc(accountRef(state.activeAccountId),updates);
    state.account={...state.account,...updates};
    closeRiskSettingsModal();
    showToast("Risk settings saved.","success");
    renderAll();
  }catch(err){showToast(friendlyError(err),"error");}
}

function wire