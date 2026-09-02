/* =================================================================
   EVA — TRADING JOURNAL (journal.js)
   Stage 2: JavaScript + Firebase wiring for the existing
   journal.html markup. No visual/DOM structure is created except
   dynamic trade rows/cards and things explicitly missing (see the
   README block below and the chat summary for the 2 markup tweaks
   that were required).

   Firebase project: eval-61cd9 (EVA)
   Firestore layout:
     users/{uid}
     users/{uid}/accounts/{accountId}
     users/{uid}/accounts/{accountId}/trades/{tradeId}
   ================================================================= */

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch, getDocs
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* -----------------------------------------------------------------
   1. FIREBASE INITIALIZATION
   Reuses the app layout.html already initialized (same config) —
   never calls initializeApp() a second time for the same app.
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
   CLOUDINARY CONFIG (unsigned upload — no API secret used or stored)
   ----------------------------------------------------------------- */
const CLOUDINARY_CLOUD_NAME = "u6sytyyq";
const CLOUDINARY_UPLOAD_PRESET = "eva_trade_images";
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

/* -----------------------------------------------------------------
   STATE
   ----------------------------------------------------------------- */
const state = {
  uid: null,
  username: "Trader",
  accounts: [],              // [{id, name, ...}]
  selectedAccountId: null,
  selectedAccount: null,      // full account doc data for the currently selected account
  unsubAccount: null,         // realtime listener on the selected account doc (keeps balance live)
  trades: [],                 // raw trades for the selected account
  filteredTrades: [],
  view: "card",                // 'list' | 'card'
  timeRange: "monthly",        // 'weekly' | 'monthly' | 'custom' | 'all'
  currentMonthIndex: new Date().getMonth(),
  currentYear: new Date().getFullYear(),
  customStart: null,
  customEnd: null,
  filters: {},
  unsubTrades: null,
  editingTradeId: null,
  deletingTradeId: null,
  activeShareTradeId: null,
  bulkSelected: new Set(),
  images: {
    add: { outlook: null, setup: null, entry: null, exit: null, result: null },
    edit: { outlook: null, setup: null, entry: null, exit: null, result: null }
  },
  editExistingImages: {}, // slot -> {url, path} for the trade currently being edited
  activeImageSlot: { add: "outlook", edit: "outlook" }
};

const IMAGE_SLOTS = ["outlook", "setup", "entry", "exit", "result"];
const SLOT_LABELS = { outlook: "Market Outlook", setup: "Setup", entry: "Entry", exit: "Exit", result: "Result / After" };
const TRADE_GRADES = ["A+", "A", "B", "C"];

/* -----------------------------------------------------------------
   DOM HELPERS
   ----------------------------------------------------------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function byId(id) { return document.getElementById(id); }

/** Waits for a selector to exist in the DOM (handles the fact that
 *  journal.html's content is injected via a <template> by eva-loader.js
 *  at some point after this module's top-level code runs). */
function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
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
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Root fix for the P/L sign bug: the Profit/Loss input is just a plain
 *  number field (type="number"), and the code used to save whatever the
 *  user typed as-is. If the Result toggle was set to "Loss" but the user
 *  typed a plain positive amount (e.g. "20" for a $20 loss), it was saved
 *  as +20 instead of -20. This normalizes the sign to match the selected
 *  Result, using the magnitude of whatever was typed:
 *    Win     -> positive
 *    Loss    -> negative
 *    BE      -> exactly 0
 *    Partial -> sign as typed (not specified/covered by the bug report) */
function computeSignedProfitLoss(rawValue, result) {
  const magnitude = Math.abs(Number(rawValue) || 0);
  if (result === "Loss") return -magnitude;
  if (result === "Win") return magnitude;
  if (result === "BE") return 0;
  return Number(rawValue) || 0;
}

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

function fmtDate(d) {
  if (!d) return "—";
  const date = (d instanceof Date) ? d : (d.toDate ? d.toDate() : new Date(d));
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateShort(d) {
  if (!d) return "—";
  const date = (d instanceof Date) ? d : (d.toDate ? d.toDate() : new Date(d));
  if (isNaN(date.getTime())) return "—";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/* -----------------------------------------------------------------
   TOAST / LOADING / ERROR HANDLING
   ----------------------------------------------------------------- */
function ensureToastHost() {
  let host = byId("jrToastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "jrToastHost";
    host.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
    document.body.appendChild(host);
  }
  return host;
}

function showToast(message, kind = "info") {
  const host = ensureToastHost();
  const colors = { info: "#3B82F6", success: "#22C55E", error: "#EF4444" };
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = `pointer-events:auto;background:${colors[kind] || colors.info};color:#fff;padding:10px 18px;border-radius:10px;font-size:0.86rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.35);max-width:90vw;text-align:center;`;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3200);
}

function setBusy(el, busy) {
  if (!el) return;
  el.disabled = !!busy;
  el.dataset.busyLabel = el.dataset.busyLabel || el.textContent;
  if (busy) {
    el.dataset.prevLabel = el.textContent;
    el.textContent = "Please wait…";
  } else if (el.dataset.prevLabel) {
    el.textContent = el.dataset.prevLabel;
  }
}

function friendlyFirebaseError(err) {
  const code = err && err.code ? err.code : "";
  console.error("Firebase error:", err);
  if (code.includes("permission-denied")) {
    return "This action was rejected by Firestore security rules. Your account may not have permission to do this yet — see the rules note from setup.";
  }
  if (code.includes("unauthenticated")) return "You're not signed in. Please log in again.";
  if (code.includes("unavailable") || code === "network-request-failed") return "Network issue — please check your connection and try again.";
  if (code.includes("not-found")) return "That record no longer exists.";
  if (code.includes("storage/unauthorized")) return "Image upload was rejected.";
  if (code === "cloudinary/upload-failed") return "Image upload to Cloudinary failed. Please check your connection and try again.";
  return err && err.message ? err.message : "Something went wrong. Please try again.";
}

/* -----------------------------------------------------------------
   MODAL CONTROLS (generic — handles every data-modal-target /
   data-modal-close button already present in the markup)
   ----------------------------------------------------------------- */
function openModal(id) {
  const el = byId(id);
  if (el) el.classList.add("jr-open");
}
function closeModal(id) {
  const el = byId(id);
  if (el) el.classList.remove("jr-open");
}
function wireModalTriggers(root) {
  $all("[data-modal-target]", root).forEach(btn => {
    if (btn.dataset.jrWired) return;
    btn.dataset.jrWired = "1";
    btn.addEventListener("click", () => openModal(btn.getAttribute("data-modal-target")));
  });
  $all("[data-modal-close]", root).forEach(btn => {
    if (btn.dataset.jrWired) return;
    btn.dataset.jrWired = "1";
    btn.addEventListener("click", () => closeModal(btn.getAttribute("data-modal-close")));
  });
  $all(".jr-modal-overlay", root).forEach(overlay => {
    if (overlay.dataset.jrOverlayWired) return;
    overlay.dataset.jrOverlayWired = "1";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("jr-open");
    });
  });
}

/* -----------------------------------------------------------------
   TOGGLE-GROUP + CHIP HELPERS (Win/Loss/BE toggle, emotion chips)
   ----------------------------------------------------------------- */
function wireToggleGroup(container) {
  if (!container || container.dataset.jrWired) return;
  container.dataset.jrWired = "1";
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".jr-toggle-btn");
    if (!btn || !container.contains(btn)) return;
    $all(".jr-toggle-btn", container).forEach(b => b.classList.remove("jr-selected", "jr-toggle-win", "jr-toggle-loss"));
    btn.classList.add("jr-selected");
    const label = btn.textContent.trim();
    if (label === "Win") btn.classList.add("jr-toggle-win");
    if (label === "Loss") btn.classList.add("jr-toggle-loss");
  });
}
function getToggleValue(container) {
  const sel = container && container.querySelector(".jr-toggle-btn.jr-selected");
  return sel ? sel.textContent.trim() : "";
}
function setToggleValue(container, value) {
  if (!container) return;
  $all(".jr-toggle-btn", container).forEach(b => {
    const match = b.textContent.trim() === value;
    b.classList.toggle("jr-selected", match);
    b.classList.remove("jr-toggle-win", "jr-toggle-loss");
    if (match && value === "Win") b.classList.add("jr-toggle-win");
    if (match && value === "Loss") b.classList.add("jr-toggle-loss");
  });
}

function wireChipGroup(field) {
  const group = field.querySelector(".jr-chip-group");
  const input = field.querySelector("input[type=text]");
  if (!group || group.dataset.jrWired) return;
  group.dataset.jrWired = "1";
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".jr-chip");
    if (!chip) return;
    chip.classList.toggle("jr-chip-selected");
    syncChipInput(field);
  });
  if (input) input.addEventListener("input", () => {
    const values = input.value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    $all(".jr-chip", group).forEach(c => c.classList.toggle("jr-chip-selected", values.includes(c.textContent.trim().toLowerCase())));
  });
}
function syncChipInput(field) {
  const input = field.querySelector("input[type=text]");
  const selected = $all(".jr-chip.jr-chip-selected", field).map(c => c.textContent.trim());
  if (input) input.value = selected.join(", ");
}
function setChipsFromArray(field, arr) {
  const values = (arr || []).map(v => String(v).trim().toLowerCase());
  $all(".jr-chip", field).forEach(c => c.classList.toggle("jr-chip-selected", values.includes(c.textContent.trim().toLowerCase())));
  syncChipInput(field);
}
function getChipArray(field) {
  return $all(".jr-chip.jr-chip-selected", field).map(c => c.textContent.trim());
}

/* Star rating (Trade Rating / execution grade), 1-5 */
function wireRating(container) {
  if (!container || container.dataset.jrWired) return;
  container.dataset.jrWired = "1";
  container.addEventListener("click", (e) => {
    const star = e.target.closest(".jr-rating-star");
    if (!star) return;
    const stars = $all(".jr-rating-star", container);
    const idx = stars.indexOf(star);
    stars.forEach((s, i) => s.classList.toggle("jr-star-filled", i <= idx));
    container.dataset.value = String(idx + 1);
  });
}
function getRatingValue(container) {
  return container ? Number(container.dataset.value || $all(".jr-rating-star.jr-star-filled", container).length || 0) : 0;
}
function setRatingValue(container, value) {
  if (!container) return;
  const stars = $all(".jr-rating-star", container);
  stars.forEach((s, i) => s.classList.toggle("jr-star-filled", i < value));
  container.dataset.value = String(value);
}

/* -----------------------------------------------------------------
   IMAGE UPLOAD ZONES (Add + Edit) — tabs pick the active slot,
   the zone accepts click-to-browse, drag & drop, and clipboard paste.
   A hidden <input type="file"> is created in JS since the markup
   doesn't include one (see chat summary).
   ----------------------------------------------------------------- */
function setupImageZone(mode, tabsEl, zoneEl, previewEl) {
  if (!tabsEl || !zoneEl || zoneEl.dataset.jrWired) return;
  zoneEl.dataset.jrWired = "1";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg";
  fileInput.style.display = "none";
  zoneEl.appendChild(fileInput);

  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-slot]");
    if (!btn) return;
    $all("button[data-slot]", tabsEl).forEach(b => b.classList.remove("jr-active"));
    btn.classList.add("jr-active");
    state.activeImageSlot[mode] = btn.getAttribute("data-slot");
  });

  zoneEl.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) handleImageFile(mode, fileInput.files[0], previewEl);
    fileInput.value = "";
  });
  zoneEl.addEventListener("dragover", (e) => { e.preventDefault(); zoneEl.style.opacity = "0.7"; });
  zoneEl.addEventListener("dragleave", () => { zoneEl.style.opacity = "1"; });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.style.opacity = "1";
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleImageFile(mode, file, previewEl);
  });
  document.addEventListener("paste", (e) => {
    const modalOpen = mode === "add" ? byId("addTradeModal").classList.contains("jr-open") : byId("editTradeModal").classList.contains("jr-open");
    if (!modalOpen) return;
    const item = Array.from(e.clipboardData.items || []).find(i => i.type.startsWith("image/"));
    if (item) handleImageFile(mode, item.getAsFile(), previewEl);
  });
}

function handleImageFile(mode, file, previewEl) {
  if (!file) return;
  if (!/^image\/(png|jpe?g)$/.test(file.type)) {
    showToast("Only PNG or JPG screenshots are supported.", "error");
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showToast("Image is too large (max 8MB).", "error");
    return;
  }
  const slot = state.activeImageSlot[mode];
  state.images[mode][slot] = file;
  if (mode === "edit") delete state.editExistingImages[slot]; // replaced
  renderImagePreviews(mode, previewEl);
}

function renderImagePreviews(mode, previewEl) {
  if (!previewEl) return;
  previewEl.innerHTML = "";
  IMAGE_SLOTS.forEach(slot => {
    const file = state.images[mode][slot];
    const existing = mode === "edit" ? state.editExistingImages[slot] : null;
    if (!file && !existing) return;
    const url = file ? URL.createObjectURL(file) : existing.url;
    const div = document.createElement("div");
    div.className = "jr-image-preview";
    div.innerHTML = `<img src="${url}" alt="${SLOT_LABELS[slot]}"><span class="jr-image-preview-tag">${SLOT_LABELS[slot]}</span>
      <button type="button" class="jr-image-preview-remove" data-remove-slot="${slot}">
        <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    previewEl.appendChild(div);
  });
  previewEl.querySelectorAll("[data-remove-slot]").forEach(btn => {
    btn.addEventListener("click", () => {
      const slot = btn.getAttribute("data-remove-slot");
      state.images[mode][slot] = null;
      if (mode === "edit") delete state.editExistingImages[slot];
      renderImagePreviews(mode, previewEl);
    });
  });
}

function resetImageState(mode) {
  IMAGE_SLOTS.forEach(s => { state.images[mode][s] = null; });
  if (mode === "edit") state.editExistingImages = {};
  state.activeImageSlot[mode] = "outlook";
}

/* -----------------------------------------------------------------
   CLOUDINARY UPLOAD (unsigned) — replaces Firebase Storage.
   Images are uploaded directly from the browser using only the
   Cloud Name + unsigned Upload Preset (no API secret is ever used).
   ----------------------------------------------------------------- */
async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  let res;
  try {
    res = await fetch(CLOUDINARY_UPLOAD_URL, { method: "POST", body: formData });
  } catch (err) {
    const e = new Error("Network error while uploading to Cloudinary.");
    e.code = "cloudinary/upload-failed";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Cloudinary upload failed (${res.status}).`);
    e.code = "cloudinary/upload-failed";
    throw e;
  }
  const data = await res.json();
  if (!data || !data.secure_url) {
    const e = new Error("Cloudinary did not return an image URL.");
    e.code = "cloudinary/upload-failed";
    throw e;
  }
  return { url: data.secure_url, publicId: data.public_id || null };
}

async function uploadTradeImages(mode) {
  const results = {};
  for (const slot of IMAGE_SLOTS) {
    const file = state.images[mode][slot];
    if (file) {
      results[slot] = await uploadToCloudinary(file);
    } else if (mode === "edit" && state.editExistingImages[slot]) {
      results[slot] = state.editExistingImages[slot]; // untouched, keep existing
    }
  }
  return results;
}

/* Note: unsigned Cloudinary uploads cannot delete remote assets from the
   browser (that requires the API secret, which we intentionally never use
   or expose). Deleting a trade/image only removes the Firestore reference —
   the underlying Cloudinary asset is left in place for manual/admin cleanup. */
function deleteTradeImages(_images) {
  return Promise.resolve();
}

/* -----------------------------------------------------------------
   2 & 3. AUTHENTICATION + USER PROFILE
   ----------------------------------------------------------------- */
function initAuthAndBoot() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }
    state.uid = user.uid;
    await loadUserProfile(user);
    await loadAccounts();
  });
}

async function loadUserProfile(authUser) {
  try {
    const snap = await getDoc(doc(db, "users", authUser.uid));
    const data = snap.exists() ? snap.data() : {};
    state.username = data.username || data.displayName || authUser.displayName || (authUser.email ? authUser.email.split("@")[0] : "Trader");
  } catch (err) {
    console.error("Failed to load user profile:", err);
    state.username = authUser.displayName || "Trader";
  }
  const h1 = $(".jr-welcome h1");
  if (h1) h1.textContent = `Welcome, ${state.username}`;
}

/* -----------------------------------------------------------------
   4 & 5. TRADING ACCOUNTS
   ----------------------------------------------------------------- */
function accountStorageKey() { return `eva-journal-selected-account-${state.uid}`; }

function accountDisplayName(acc) {
  return (acc && (acc.name || acc.accountName)) || "Untitled Account";
}
function accountBroker(acc) {
  return (acc && (acc.broker || acc.brokerName || acc.platform)) || "";
}
function accountStatus(acc) {
  return (acc && (acc.status || acc.accountType)) || "Live";
}
function accountBalanceValue(acc) {
  if (!acc) return null;
  const raw = acc.balance ?? acc.currentBalance ?? acc.accountBalance ?? acc.initialBalance;
  return raw === undefined || raw === null || raw === "" ? null : Number(raw);
}

async function loadAccounts() {
  try {
    const snap = await getDocs(collection(db, "users", state.uid, "accounts"));
    state.accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
    state.accounts = [];
  }

  const header = byId("accountDropdownHeader");
  if (header) header.textContent = `${state.accounts.length} account${state.accounts.length === 1 ? "" : "s"}`;

  renderAccountDropdownList();
  populateFormAccountSelectors();

  // Determine default/selected account
  const saved = localStorage.getItem(accountStorageKey());
  let target = null;
  if (state.accounts.length === 1) {
    target = state.accounts[0].id;
  } else if (saved && state.accounts.some(a => a.id === saved)) {
    target = saved;
  } else if (state.accounts.length > 0) {
    target = state.accounts[0].id;
  }

  if (target) {
    selectAccount(target, { skipReload: false });
  } else {
    state.selectedAccountId = null;
    const triggerName = byId("accountTriggerName");
    if (triggerName) triggerName.textContent = "No accounts yet";
    renderEmptyAccountsState();
  }
}

/* Builds the account list inside the custom dropdown panel from state.accounts.
   Never shows another user's accounts — state.accounts only ever comes from
   users/{state.uid}/accounts, scoped to the signed-in Firebase user. */
function renderAccountDropdownList() {
  const list = byId("accountDropdownList");
  if (!list) return;
  if (state.accounts.length === 0) {
    list.innerHTML = `<div class="jr-account-empty">No trading accounts yet. Create one to start journaling.</div>`;
    return;
  }
  list.innerHTML = state.accounts.map(acc => {
    const status = accountStatus(acc);
    const broker = accountBroker(acc);
    const isDemo = /demo/i.test(status);
    const active = acc.id === state.selectedAccountId;
    return `
      <button type="button" class="jr-account-item${active ? " jr-active" : ""}" data-account-id="${acc.id}" role="option" aria-selected="${active}">
        <span class="jr-account-item-dot"></span>
        <span class="jr-account-item-info">
          <span class="jr-account-item-name">${escapeHtml(accountDisplayName(acc))}</span>
          <span class="jr-account-item-meta">${broker ? escapeHtml(broker) + " · " : ""}<span class="jr-account-item-status${isDemo ? " jr-status-demo" : ""}">${escapeHtml(status)}</span></span>
        </span>
        ${active ? `<svg class="jr-account-item-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
      </button>`;
  }).join("");
}

function updateAccountTrigger() {
  const nameEl = byId("accountTriggerName");
  const acc = state.accounts.find(a => a.id === state.selectedAccountId);
  if (nameEl) nameEl.textContent = acc ? accountDisplayName(acc) : "Select account";
}

function wireAccountSelector() {
  const trigger = byId("accountDropdownTrigger");
  const panel = byId("accountDropdownPanel");
  const list = byId("accountDropdownList");
  if (!trigger || !panel || !list) return;

  function openPanel() {
    panel.classList.add("jr-open");
    trigger.classList.add("jr-open");
    trigger.setAttribute("aria-expanded", "true");
  }
  function closePanel() {
    panel.classList.remove("jr-open");
    trigger.classList.remove("jr-open");
    trigger.setAttribute("aria-expanded", "false");
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("jr-open")) closePanel(); else openPanel();
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest("[data-account-id]");
    if (!item) return;
    const accountId = item.getAttribute("data-account-id");
    if (accountId) selectAccount(accountId);
    closePanel();
  });

  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("jr-open")) return;
    if (!panel.contains(e.target) && !trigger.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });
}

function populateFormAccountSelectors() {
  ["addAccount", "editAccount"].forEach(id => {
    const sel = byId(id);
    if (!sel) return;
    sel.innerHTML = "";
    state.accounts.forEach(acc => {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = acc.name || acc.accountName || "Untitled Account";
      sel.appendChild(opt);
    });
  });
}

function renderEmptyAccountsState() {
  state.trades = [];
  state.filteredTrades = [];
  if (state.unsubAccount) { state.unsubAccount(); state.unsubAccount = null; }
  state.selectedAccount = null;
  const balanceEl = byId("initialBalanceValue");
  if (balanceEl) balanceEl.textContent = "—";
  renderTrades();
  updateStats();
  showToast("You don't have any trading accounts yet. Create one to start journaling.", "info");
}

function selectAccount(accountId, opts = {}) {
  if (state.selectedAccountId === accountId) return;
  state.selectedAccountId = accountId;
  localStorage.setItem(accountStorageKey(), accountId);

  updateAccountTrigger();
  renderAccountDropdownList();
  attachAccountBalanceListener(accountId);

  if (state.unsubTrades) { state.unsubTrades(); state.unsubTrades = null; }
  attachTradesListener(accountId);
}

/* Keeps the displayed balance live — re-reads the account document any time
   it changes in Firestore (e.g. recalculated elsewhere), instead of a
   hardcoded/static value. Never mixes data from another account: the
   listener is torn down and re-attached every time the selected account
   changes. */
function attachAccountBalanceListener(accountId) {
  if (state.unsubAccount) { state.unsubAccount(); state.unsubAccount = null; }
  const balanceEl = byId("initialBalanceValue");
  if (!accountId) {
    state.selectedAccount = null;
    if (balanceEl) balanceEl.textContent = "—";
    return;
  }
  const accountRef = doc(db, "users", state.uid, "accounts", accountId);
  state.unsubAccount = onSnapshot(accountRef, (snap) => {
    if (!snap.exists()) return;
    const acc = { id: snap.id, ...snap.data() };
    state.selectedAccount = acc;
    // Keep the accounts list + dropdown in sync with any live field changes
    const idx = state.accounts.findIndex(a => a.id === accountId);
    if (idx >= 0) state.accounts[idx] = acc; else state.accounts.push(acc);
    updateAccountTrigger();
    renderAccountDropdownList();

    const balance = accountBalanceValue(acc);
    if (balanceEl) balanceEl.textContent = balance === null ? "—" : fmtBalance(balance);
  }, (err) => {
    showToast(friendlyFirebaseError(err), "error");
  });
}

/* -----------------------------------------------------------------
   6, 11, 26. TRADES — REAL-TIME LISTENER
   ----------------------------------------------------------------- */
function attachTradesListener(accountId) {
  if (!accountId) return;
  const tbody = byId("tradeTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="17" style="text-align:center;padding:24px;color:var(--eva-text-dim);">Loading trades…</td></tr>`;

  const q = query(collection(db, "users", state.uid, "accounts", accountId, "trades"), orderBy("tradeDate", "desc"));
  state.unsubTrades = onSnapshot(q, (snap) => {
    state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    applyFiltersAndRender();
  }, (err) => {
    showToast(friendlyFirebaseError(err), "error");
  });
}

/* -----------------------------------------------------------------
   13/14/15. TIME RANGE + ADVANCED FILTERS + STATS
   ----------------------------------------------------------------- */
function getTradeDate(trade) {
  if (!trade.tradeDate) return null;
  return trade.tradeDate.toDate ? trade.tradeDate.toDate() : new Date(trade.tradeDate);
}

function isInTimeRange(date) {
  if (!date) return state.timeRange === "all";
  const now = new Date();
  if (state.timeRange === "all") return true;
  if (state.timeRange === "weekly") {
    const start = new Date(now);
    const day = (start.getDay() + 6) % 7; // Monday = 0
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return date >= start && date < end;
  }
  if (state.timeRange === "monthly") {
    return date.getMonth() === state.currentMonthIndex && date.getFullYear() === state.currentYear;
  }
  if (state.timeRange === "custom") {
    if (!state.customStart || !state.customEnd) return true;
    const start = new Date(state.customStart); start.setHours(0, 0, 0, 0);
    const end = new Date(state.customEnd); end.setHours(23, 59, 59, 999);
    return date >= start && date <= end;
  }
  return true;
}

function readAdvancedFilters() {
  const val = (id) => { const el = byId(id); return el ? el.value.trim() : ""; };
  return {
    instrument: val("filterInstrument"),
    direction: val("filterDirection"),
    result: val("filterResult"),
    strategy: val("filterStrategy"),
    setup: val("filterSetup"),
    session: val("filterSession"),
    date: val("filterDate"),
    dateFrom: val("filterDateFrom"),
    dateTo: val("filterDateTo"),
    pnlMin: val("filterPnlMin"),
    pnlMax: val("filterPnlMax"),
    tags: val("filterTags"),
    search: val("filterSearch").toLowerCase()
  };
}

function matchesAdvancedFilters(trade, f) {
  if (f.instrument && f.instrument !== "All Pairs" && trade.instrument !== f.instrument) return false;
  if (f.direction && f.direction !== "All" && (trade.direction || "").toLowerCase() !== f.direction.toLowerCase()) return false;
  if (f.result && f.result !== "All Results") {
    const normalized = f.result === "Break Even" ? "BE" : f.result;
    if ((trade.result || "") !== normalized) return false;
  }
  if (f.strategy && f.strategy !== "All Strategies" && trade.strategy !== f.strategy) return false;
  if (f.setup && f.setup !== "All Setups" && trade.setup !== f.setup) return false;
  if (f.session && f.session !== "All" && trade.session !== f.session) return false;

  const tDate = getTradeDate(trade);
  if (f.date && tDate) {
    const d = new Date(f.date);
    if (tDate.toDateString() !== d.toDateString()) return false;
  }
  if (f.dateFrom && tDate && tDate < new Date(f.dateFrom)) return false;
  if (f.dateTo && tDate) {
    const end = new Date(f.dateTo); end.setHours(23, 59, 59, 999);
    if (tDate > end) return false;
  }
  if (f.pnlMin !== "" && Number(trade.profitLoss) < Number(f.pnlMin)) return false;
  if (f.pnlMax !== "" && Number(trade.profitLoss) > Number(f.pnlMax)) return false;

  if (f.tags) {
    const wanted = f.tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    const tradeTags = [...(trade.emotionBefore || []), ...(trade.emotionDuring || []), ...(trade.emotionAfter || [])].map(t => t.toLowerCase());
    if (!wanted.every(w => tradeTags.some(tt => tt.includes(w)))) return false;
  }

  if (f.search) {
    const haystack = [trade.instrument, trade.strategy, trade.setup, trade.notes, trade.mistakes, trade.lessons]
      .filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(f.search)) return false;
  }

  return true;
}

function applyFiltersAndRender() {
  const f = readAdvancedFilters();
  state.filteredTrades = state.trades
    .filter(t => isInTimeRange(getTradeDate(t)))
    .filter(t => matchesAdvancedFilters(t, f));
  renderTrades();
  updateStats();
}

function updateStats() {
  const trades = state.filteredTrades;
  const completed = trades.filter(t => t.result === "Win" || t.result === "Loss");
  const wins = trades.filter(t => t.result === "Win").length;
  const losses = trades.filter(t => t.result === "Loss").length;
  const winRate = completed.length ? (wins / completed.length) * 100 : 0;
  const netPL = trades.reduce((sum, t) => sum + (Number(t.profitLoss) || 0), 0);

  const countLabel = byId("tradeCountLabel");
  if (countLabel) countLabel.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"} recorded`;

  const netCell = byId("tfootNetPL");
  if (netCell) {
    netCell.textContent = fmtMoney(netPL);
    netCell.className = netPL >= 0 ? "jr-profit-pos" : "jr-profit-neg";
  }
  const winRateCell = byId("tfootWinRate");
  if (winRateCell) winRateCell.textContent = `Win Rate: ${winRate.toFixed(1)}%`;

  const bar = byId("bulkSelectionBar");
  if (bar) {
    bar.classList.toggle("jr-visible", state.bulkSelected.size > 0);
    const label = byId("bulkSelectedLabel");
    if (label) label.textContent = `${state.bulkSelected.size} trade${state.bulkSelected.size === 1 ? "" : "s"} selected`;
  }

  const master = byId("selectAllRows");
  if (master) {
    const total = state.filteredTrades.length;
    const selectedCount = state.filteredTrades.filter(t => state.bulkSelected.has(t.id)).length;
    master.checked = total > 0 && selectedCount === total;
    master.indeterminate = selectedCount > 0 && selectedCount < total;
  }
}

/* -----------------------------------------------------------------
   7, 8, 12. TRADE HISTORY RENDERING (list + card views)
   ----------------------------------------------------------------- */
function renderTrades() {
  const tbody = byId("tradeTableBody");
  const grid = byId("tradeCardGrid");
  const empty = byId("journalEmptyState");
  const trades = state.filteredTrades;

  if (empty) empty.classList.toggle("jr-visible", trades.length === 0);

  if (tbody) {
    tbody.innerHTML = trades.map((t, i) => renderRow(t, i)).join("");
  }
  if (grid) {
    grid.innerHTML = trades.map((t, i) => renderCard(t, i)).join("");
  }
}

function pill(kind, text) {
  const map = { long: "jr-pill-long", short: "jr-pill-short", Win: "jr-pill-win", Loss: "jr-pill-loss", BE: "jr-pill-be", Partial: "jr-pill-neutral" };
  return `<span class="jr-pill ${map[kind] || "jr-pill-neutral"}">${escapeHtml(text)}</span>`;
}

function gradePill(rating) {
  if (!rating) return `<span class="jr-pill jr-pill-grade-unrated" title="Trade Rating">Not Rated</span>`;
  const cls = `jr-pill-grade-${rating.replace("+", "plus")}`;
  return `<span class="jr-pill ${cls}" title="Trade Rating">${escapeHtml(rating)}</span>`;
}

function renderRow(t, i) {
  const dirClass = (t.direction || "").toLowerCase().includes("short") ? "short" : "long";
  const plClass = (Number(t.profitLoss) || 0) >= 0 ? "jr-profit-pos" : "jr-profit-neg";
  return `
    <tr class="jr-trade-row" data-trade-id="${t.id}">
      <td><input type="checkbox" class="jr-row-check jr-row-select" data-select-trade="${t.id}" ${state.bulkSelected.has(t.id) ? "checked" : ""}></td>
      <td>#${i + 1}</td>
      <td>${fmtDate(getTradeDate(t))}</td>
      <td><b>${escapeHtml(t.instrument)}</b></td>
      <td>${pill(dirClass, dirClass === "short" ? "SHORT" : "LONG")}</td>
      <td>${t.lotSize ?? "—"}</td>
      <td>${t.entryPrice ?? "—"}</td>
      <td>${t.exitPrice ?? "—"}</td>
      <td>${t.stopLoss ?? "—"}</td>
      <td>${t.takeProfit ?? "—"}</td>
      <td>${escapeHtml(t.riskReward || "—")}</td>
      <td class="${plClass}">${fmtMoney(t.profitLoss)}</td>
      <td>${pill(t.result, t.result === "BE" ? "BE" : t.result || "—")} ${gradePill(t.tradeRating)}</td>
      <td>${escapeHtml(t.strategy || "—")}</td>
      <td>${escapeHtml(t.setup || "—")}</td>
      <td>${escapeHtml(t.session || "—")}</td>
      <td>
        <div class="jr-table-actions">
          <button class="jr-icon-action" data-action="view" data-trade-id="${t.id}" aria-label="View trade">
            <svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="jr-icon-action" data-action="edit" data-trade-id="${t.id}" aria-label="Edit trade">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="jr-icon-action jr-share" data-action="share" data-trade-id="${t.id}" aria-label="Share trade">
            <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
          </button>
          <button class="jr-icon-action jr-danger" data-action="delete" data-trade-id="${t.id}" aria-label="Delete trade">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
}

function renderCard(t, i) {
  const dirClass = (t.direction || "").toLowerCase().includes("short") ? "short" : "long";
  const plClass = (Number(t.profitLoss) || 0) >= 0 ? "jr-profit-pos" : "jr-profit-neg";
  const imageCount = t.images ? Object.keys(t.images).length : 0;
  const tags = [...(t.emotionAfter || [])].slice(0, 2);
  return `
    <article class="jr-card" data-trade-id="${t.id}">
      <div class="jr-card-head">
        <div class="jr-card-head-left">
          <input type="checkbox" class="jr-row-check jr-row-select" data-select-trade="${t.id}" ${state.bulkSelected.has(t.id) ? "checked" : ""}>
          <span class="jr-card-symbol">${escapeHtml(t.instrument)}</span>
          ${pill(dirClass, dirClass === "short" ? "SHORT" : "LONG")}
        </div>
        ${pill(t.result, t.result === "BE" ? "BE" : t.result || "—")}
        ${gradePill(t.tradeRating)}
        <span class="jr-card-id">#${i + 1}</span>
      </div>
      <div class="jr-card-profit-row">
        <span class="jr-card-profit-label">Net Profit</span>
        <span class="jr-card-profit-value ${plClass}">${fmtMoney(t.profitLoss)}</span>
      </div>
      <div class="jr-card-stats">
        <div><div class="jr-card-stat-label">Entry / Exit</div><div class="jr-card-stat-value">${t.entryPrice ?? "—"} → ${t.exitPrice ?? "—"}</div></div>
        <div><div class="jr-card-stat-label">SL / TP</div><div class="jr-card-stat-value">${t.stopLoss ?? "—"} / ${t.takeProfit ?? "—"}</div></div>
        <div><div class="jr-card-stat-label">Lots</div><div class="jr-card-stat-value">${t.lotSize ?? "—"}</div></div>
        <div><div class="jr-card-stat-label">R:R Ratio</div><div class="jr-card-stat-value">${escapeHtml(t.riskReward || "—")}</div></div>
        <div><div class="jr-card-stat-label">Session</div><div class="jr-card-stat-value">${escapeHtml(t.session || "—")}</div></div>
        <div><div class="jr-card-stat-label">Strategy / Setup</div><div class="jr-card-stat-value">${escapeHtml(t.strategy || "—")}</div></div>
      </div>
      <div class="jr-card-tags">${tags.map(tag => `<span class="jr-chip">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="jr-card-foot">
        <div class="jr-card-date">Date<b>${fmtDateShort(getTradeDate(t))}</b></div>
        <a class="jr-card-images-link" data-action="view" data-trade-id="${t.id}" style="cursor:pointer;">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          ${imageCount} image${imageCount === 1 ? "" : "s"}
        </a>
      </div>
      <div class="jr-card-foot" style="border-top:none; padding-top:0;">
        <div class="jr-card-actions" style="margin-left:auto;">
          <button class="jr-icon-action" data-action="view" data-trade-id="${t.id}" aria-label="View trade">
            <svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="jr-icon-action" data-action="edit" data-trade-id="${t.id}" aria-label="Edit trade">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="jr-icon-action jr-share" data-action="share" data-trade-id="${t.id}" aria-label="Share trade">
            <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
          </button>
          <button class="jr-icon-action jr-danger" data-action="delete" data-trade-id="${t.id}" aria-label="Delete trade">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
    </article>`;
}

/* Delegated click handling for view/edit/delete/share on dynamic rows */
function wireTradeActionDelegation() {
  [byId("tradeTableBody"), byId("tradeCardGrid")].forEach(container => {
    if (!container || container.dataset.jrWired) return;
    container.dataset.jrWired = "1";
    container.addEventListener("click", (e) => {
      const checkbox = e.target.closest("[data-select-trade]");
      if (checkbox) {
        const id = checkbox.getAttribute("data-select-trade");
        if (checkbox.checked) state.bulkSelected.add(id); else state.bulkSelected.delete(id);
        updateStats();
        return;
      }
      const actionBtn = e.target.closest("[data-action]");
      if (!actionBtn) return;
      const tradeId = actionBtn.getAttribute("data-trade-id");
      const action = actionBtn.getAttribute("data-action");
      const trade = state.trades.find(t => t.id === tradeId);
      if (!trade) return;
      if (action === "view") openViewModal(trade);
      if (action === "edit") openEditModal(trade);
      if (action === "delete") { state.deletingTradeId = tradeId; openModal("deleteTradeModal"); }
      if (action === "share") openShareModal(trade);
    });
  });
}

/* -----------------------------------------------------------------
   SELECT-ALL ROWS CHECKBOX (list view header)
   ----------------------------------------------------------------- */
function wireSelectAllRows() {
  const master = byId("selectAllRows");
  if (!master || master.dataset.jrWired) return;
  master.dataset.jrWired = "1";
  master.addEventListener("change", () => {
    const trades = state.filteredTrades;
    if (master.checked) {
      trades.forEach(t => state.bulkSelected.add(t.id));
    } else {
      trades.forEach(t => state.bulkSelected.delete(t.id));
    }
    $all("[data-select-trade]").forEach(cb => { cb.checked = master.checked; });
    updateStats();
  });
}

/* -----------------------------------------------------------------
   LIST / CARD VIEW SWITCH
   ----------------------------------------------------------------- */
function wireViewSwitch() {
  const listBtn = byId("listViewBtn");
  const cardBtn = byId("cardViewBtn");
  const listPanel = byId("listViewPanel");
  const cardPanel = byId("cardViewPanel");
  if (!listBtn || !cardBtn) return;

  function setView(v) {
    state.view = v;
    listBtn.classList.toggle("jr-active", v === "list");
    cardBtn.classList.toggle("jr-active", v === "card");
    if (listPanel) listPanel.classList.toggle("jr-active-view", v === "list");
    if (cardPanel) cardPanel.classList.toggle("jr-active-view", v === "card");
  }
  listBtn.addEventListener("click", () => setView("list"));
  cardBtn.addEventListener("click", () => setView("card"));
  setView(state.view);
}

/* -----------------------------------------------------------------
   3. TIME RANGE CONTROLS
   ----------------------------------------------------------------- */
function wireTimeRange() {
  const segment = byId("timeRangeSegment");
  const monthNav = byId("monthNav");
  const customFields = byId("customRangeFields");
  const monthSelect = byId("monthSelect");
  const yearSelect = byId("yearSelect");
  const prevBtn = byId("prevMonthBtn");
  const nextBtn = byId("nextMonthBtn");
  const startInput = byId("customRangeStart");
  const endInput = byId("customRangeEnd");
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function refreshVisibility() {
    if (monthNav) monthNav.style.display = state.timeRange === "monthly" ? "flex" : "none";
    if (customFields) customFields.classList.toggle("jr-visible", state.timeRange === "custom");
  }
  refreshVisibility();

  if (segment) {
    segment.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      $all("button", segment).forEach(b => b.classList.remove("jr-active"));
      btn.classList.add("jr-active");
      state.timeRange = btn.getAttribute("data-range");
      refreshVisibility();
      applyFiltersAndRender();
    });
  }
  if (monthSelect) monthSelect.addEventListener("change", () => {
    state.currentMonthIndex = MONTHS.indexOf(monthSelect.value);
    applyFiltersAndRender();
  });
  if (yearSelect) yearSelect.addEventListener("change", () => {
    state.currentYear = Number(yearSelect.value);
    applyFiltersAndRender();
  });
  if (prevBtn) prevBtn.addEventListener("click", () => {
    state.currentMonthIndex--;
    if (state.currentMonthIndex < 0) { state.currentMonthIndex = 11; state.currentYear--; }
    if (monthSelect) monthSelect.value = MONTHS[state.currentMonthIndex];
    if (yearSelect) yearSelect.value = String(state.currentYear);
    applyFiltersAndRender();
  });
  if (nextBtn) nextBtn.addEventListener("click", () => {
    state.currentMonthIndex++;
    if (state.currentMonthIndex > 11) { state.currentMonthIndex = 0; state.currentYear++; }
    if (monthSelect) monthSelect.value = MONTHS[state.currentMonthIndex];
    if (yearSelect) yearSelect.value = String(state.currentYear);
    applyFiltersAndRender();
  });
  if (startInput) startInput.addEventListener("change", () => { state.customStart = startInput.value; applyFiltersAndRender(); });
  if (endInput) endInput.addEventListener("change", () => { state.customEnd = endInput.value; applyFiltersAndRender(); });
}

/* -----------------------------------------------------------------
   14. ADVANCED FILTERS WIRING
   ----------------------------------------------------------------- */
function wireAdvancedFilters() {
  const applyBtn = byId("applyFiltersBtn");
  const clearBtn = byId("clearFiltersBtn");
  if (applyBtn) applyBtn.addEventListener("click", applyFiltersAndRender);
  ["filterSearch"].forEach(id => {
    const el = byId(id);
    if (el) el.addEventListener("input", debounce(applyFiltersAndRender, 300));
  });
  if (clearBtn) clearBtn.addEventListener("click", () => {
    ["filterInstrument","filterDirection","filterResult","filterStrategy","filterSetup","filterSession"].forEach(id => {
      const el = byId(id); if (el) el.selectedIndex = 0;
    });
    ["filterDate","filterDateFrom","filterDateTo","filterPnlMin","filterPnlMax","filterTags","filterSearch"].forEach(id => {
      const el = byId(id); if (el) el.value = "";
    });
    applyFiltersAndRender();
  });
}
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

/* -----------------------------------------------------------------
   9. FORM VALIDATION
   ----------------------------------------------------------------- */
function validateTradeForm(prefix) {
  const errors = [];
  const get = (id) => byId(id);
  const instrument = get(`${prefix}Instrument`)?.value.trim();
  const lotSize = get(`${prefix}LotSize`)?.value;
  const entryPrice = get(`${prefix}EntryPrice`)?.value;
  const exitPrice = get(`${prefix}ExitPrice`)?.value;
  const stopLoss = get(`${prefix}StopLoss`)?.value;
  const takeProfit = get(`${prefix}TakeProfit`)?.value;
  const dateField = prefix === "add" ? get("addTradeDate")?.value : get("editTradeDate")?.value;
  const netProfit = prefix === "add" ? get("addProfitLoss")?.value : get("editNetProfit")?.value;

  if (!instrument) errors.push("Instrument / Pair is required.");
  if (!dateField) errors.push("Trade date is required.");
  if (lotSize === "" || isNaN(Number(lotSize)) || Number(lotSize) <= 0) errors.push("Lot / position size must be a positive number.");
  if (entryPrice === "" || isNaN(Number(entryPrice))) errors.push("Entry price must be a valid number.");
  if (exitPrice === "" || isNaN(Number(exitPrice))) errors.push("Exit price must be a valid number.");
  if (stopLoss !== "" && isNaN(Number(stopLoss))) errors.push("Stop loss must be a valid number.");
  if (takeProfit !== "" && isNaN(Number(takeProfit))) errors.push("Take profit must be a valid number.");
  if (netProfit === "" || isNaN(Number(netProfit))) errors.push("Net profit/loss must be a valid number.");

  return errors;
}

/* -----------------------------------------------------------------
   7 & 9. ADD TRADE
   ----------------------------------------------------------------- */
function collectTradeFormData(prefix) {
  const get = (id) => byId(id);
  const val = (id) => { const el = get(id); return el ? el.value : ""; };

  let tradeDate;
  if (prefix === "add") {
    const dateStr = val("addTradeDate");
    const timeStr = val("addEntryTime") || "00:00";
    tradeDate = dateStr ? new Date(`${dateStr}T${timeStr}`) : new Date();
  } else {
    const dt = val("editTradeDate");
    tradeDate = dt ? new Date(dt) : new Date();
  }

  const resultToggle = prefix === "add" ? byId("addResultToggle") : $("#editTradeModal .jr-toggle-group");

  const data = {
    accountId: state.selectedAccountId,
    instrument: val(`${prefix}Instrument`).toUpperCase(),
    direction: val(`${prefix}Direction`).includes("SHORT") ? "SHORT" : "LONG",
    tradeDate,
    lotSize: Number(val(`${prefix}LotSize`)) || 0,
    entryPrice: Number(val(`${prefix}EntryPrice`)) || 0,
    exitPrice: Number(val(`${prefix}ExitPrice`)) || 0,
    stopLoss: val(`${prefix}StopLoss`) !== "" ? Number(val(`${prefix}StopLoss`)) : null,
    takeProfit: val(`${prefix}TakeProfit`) !== "" ? Number(val(`${prefix}TakeProfit`)) : null,
    session: val(`${prefix}Session`),
    strategy: val(`${prefix}Strategy`) || null,
    setup: val(`${prefix}Setup`) || null,
    notes: val(`${prefix}Notes`) || val(`${prefix}TradeNotes`) || "",
    tradeRating: getToggleValue(byId(`${prefix}TradeGrade`)) || null,
    updatedAt: serverTimestamp()
  };

  if (prefix === "add") {
    data.entryTime = val("addEntryTime");
    data.exitTime = val("addExitTime");
    data.result = getToggleValue(byId("addResultToggle")) || "Win";
    data.profitLoss = computeSignedProfitLoss(val("addProfitLoss"), data.result);
    data.risk = val("addRisk") !== "" ? Number(val("addRisk")) : null;
    data.riskReward = val("addRiskReward") || "";
    data.marketCondition = val("addMarketCondition");
    data.timeframe = val("addTimeframe");
    data.rating = getRatingValue(byId("addTradeRating"));
    data.emotionBefore = getChipArray($("#addEmotionBefore").closest(".jr-field"));
    data.emotionDuring = getChipArray($("#addEmotionDuring").closest(".jr-field"));
    data.emotionAfter = getChipArray($("#addEmotionAfter").closest(".jr-field"));
    data.confidence = val("addConfidence") !== "" ? Number(val("addConfidence")) : null;
    data.discipline = val("addDiscipline") !== "" ? Number(val("addDiscipline")) : null;
    data.followedPlan = getToggleValue(byId("addFollowedPlan")) || "Yes";
    data.mistakes = val("addMistakes");
    data.lessons = val("addLessons");
    data.createdAt = serverTimestamp();
  } else {
    data.commission = val("editCommission") !== "" ? Number(val("editCommission")) : null;
    data.result = getToggleValue($("#editTradeModal .jr-toggle-group")) || "Win";
    data.profitLoss = computeSignedProfitLoss(val("editNetProfit"), data.result);
    data.closeReason = val("editCloseReason");
    data.emotionBefore = getChipArray($all("#editTradeModal .jr-field").find(f => f.querySelector("label")?.textContent.trim() === "Before Entry"));
    data.emotionDuring = getChipArray($all("#editTradeModal .jr-field").find(f => f.querySelector("label")?.textContent.trim() === "During Trade"));
    data.emotionAfter = getChipArray($all("#editTradeModal .jr-field").find(f => f.querySelector("label")?.textContent.trim() === "After Exit"));
  }

  return data;
}

async function handleAddTrade() {
  const btn = byId("saveNewTradeBtn");
  if (!state.selectedAccountId) { showToast("Select a trading account first.", "error"); return; }
  const errors = validateTradeForm("add");
  if (errors.length) { showToast(errors[0], "error"); return; }

  setBusy(btn, true);
  try {
    const tradeData = collectTradeFormData("add");
    const tradesRef = collection(db, "users", state.uid, "accounts", state.selectedAccountId, "trades");
    const newDocRef = await addDoc(tradesRef, tradeData);

    const hasImages = IMAGE_SLOTS.some(s => state.images.add[s]);
    if (hasImages) {
      const images = await uploadTradeImages("add");
      await updateDoc(newDocRef, { images });
    }

    closeModal("addTradeModal");
    resetAddForm();
    showToast("Trade saved.", "success");
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  } finally {
    setBusy(btn, false);
  }
}

function resetAddForm() {
  ["addInstrument","addLotSize","addEntryTime","addExitTime","addEntryPrice","addExitPrice","addStopLoss",
   "addTakeProfit","addProfitLoss","addRisk","addRiskReward","addStrategy","addSetup","addConfidence",
   "addDiscipline","addMistakes","addLessons","addTradeNotes","addEmotionBefore","addEmotionDuring","addEmotionAfter"]
    .forEach(id => { const el = byId(id); if (el) el.value = ""; });
  const dateEl = byId("addTradeDate"); if (dateEl) dateEl.value = "";
  setToggleValue(byId("addResultToggle"), "Win");
  setToggleValue(byId("addTradeGrade"), "");
  setToggleValue(byId("addFollowedPlan"), "Yes");
  setRatingValue(byId("addTradeRating"), 0);
  $all("#addTradeModal .jr-chip-group .jr-chip").forEach(c => c.classList.remove("jr-chip-selected"));
  resetImageState("add");
  renderImagePreviews("add", byId("addImagePreviewGrid"));
}

/* -----------------------------------------------------------------
   16. VIEW TRADE
   ----------------------------------------------------------------- */
function openViewModal(trade) {
  const modal = byId("viewTradeModal");
  if (!modal) return;
  $(".jr-view-hero-symbol", modal).textContent = trade.instrument || "—";
  const pills = $all(".jr-view-hero-left .jr-pill", modal);
  if (pills[0]) { pills[0].textContent = trade.direction === "SHORT" ? "SHORT" : "LONG"; pills[0].className = `jr-pill ${trade.direction === "SHORT" ? "jr-pill-short" : "jr-pill-long"}`; }
  if (pills[1]) { pills[1].textContent = trade.result === "BE" ? "BE" : (trade.result || "—"); pills[1].className = `jr-pill ${trade.result === "Win" ? "jr-pill-win" : trade.result === "Loss" ? "jr-pill-loss" : "jr-pill-be"}`; }
  const profitEl = $(".jr-view-hero-profit", modal);
  if (profitEl) { profitEl.textContent = fmtMoney(trade.profitLoss); profitEl.className = `jr-view-hero-profit ${(Number(trade.profitLoss)||0) >= 0 ? "jr-profit-pos" : "jr-profit-neg"}`; }

  const groups = $all(".jr-form-group", modal);
  // Group 1: Trade Information
  setDetailRows(groups[0], [
    accountNameById(trade.accountId),
    `${fmtDateShort(getTradeDate(trade))}, ${trade.entryTime || "—"}`,
    trade.entryPrice, trade.exitPrice, trade.stopLoss ?? "—", trade.takeProfit ?? "—", trade.lotSize
  ]);
  // Group 2: Result
  setDetailRows(groups[1], [fmtMoney(trade.profitLoss), trade.riskReward || "—", trade.result || "—"]);
  // Group 3: Strategy
  setDetailRows(groups[2], [trade.strategy || "—", trade.setup || "—", trade.session || "—", `${trade.rating || 0} / 5`]);
  const gradeEl = byId("viewTradeGradeValue");
  if (gradeEl) {
    gradeEl.textContent = trade.tradeRating || "Not Rated";
    gradeEl.className = trade.tradeRating ? `jr-grade-text jr-grade-${trade.tradeRating.replace("+", "plus")}` : "jr-grade-text jr-grade-unrated";
  }

  // Group 4: Psychology chip rows
  if (groups[3]) {
    const chipRows = $all(".jr-card-tags", groups[3]);
    fillChipRow(chipRows[0], trade.emotionBefore);
    fillChipRow(chipRows[1], trade.emotionDuring);
    fillChipRow(chipRows[2], trade.emotionAfter);
  }
  // Group 5: Notes
  if (groups[4]) { const n = $(".jr-view-notes", groups[4]); if (n) n.textContent = trade.notes || "No notes recorded."; }
  // Group 6: Images
  if (groups[5]) {
    const gallery = $(".jr-view-gallery", groups[5]);
    if (gallery) {
      gallery.innerHTML = IMAGE_SLOTS.map(slot => {
        const img = trade.images && trade.images[slot];
        return img
          ? `<a class="jr-view-gallery-item" href="${img.url}" target="_blank" rel="noopener" style="background-image:url('${img.url}');background-size:cover;background-position:center;"><span>${SLOT_LABELS[slot]}</span></a>`
          : `<div class="jr-view-gallery-item">—<span>${SLOT_LABELS[slot]}</span></div>`;
      }).join("");
    }
  }

  const editBtn = $("[data-modal-target=editTradeModal]", modal);
  if (editBtn) editBtn.onclick = () => { closeModal("viewTradeModal"); openEditModal(trade); };

  openModal("viewTradeModal");
}
function setDetailRows(group, values) {
  if (!group) return;
  const rows = $all(".jr-detail-row span:last-child", group);
  rows.forEach((el, i) => { if (values[i] !== undefined) el.textContent = values[i] ?? "—"; });
}
function fillChipRow(row, arr) {
  if (!row) return;
  row.innerHTML = (arr && arr.length ? arr : ["—"]).map(t => `<span class="jr-chip jr-chip-selected">${escapeHtml(t)}</span>`).join("");
}
function accountNameById(id) {
  const acc = state.accounts.find(a => a.id === id);
  return acc ? (acc.name || acc.accountName || "Account") : "—";
}

/* -----------------------------------------------------------------
   17. EDIT TRADE
   ----------------------------------------------------------------- */
function openEditModal(trade) {
  state.editingTradeId = trade.id;
  const modal = byId("editTradeModal");
  if (!modal) return;

  $("h2", modal).textContent = `Edit Trade — ${trade.instrument || ""}`;
  byId("editAccount").value = trade.accountId || state.selectedAccountId;
  byId("editTradeDate").value = toDatetimeLocal(getTradeDate(trade));
  byId("editInstrument").value = trade.instrument || "";
  byId("editDirection").value = trade.direction === "SHORT" ? "SHORT (Sell)" : "LONG (Buy)";
  byId("editLotSize").value = trade.lotSize ?? "";
  byId("editSession").value = trade.session || "Asia";
  byId("editEntryPrice").value = trade.entryPrice ?? "";
  byId("editExitPrice").value = trade.exitPrice ?? "";
  byId("editStopLoss").value = trade.stopLoss ?? "";
  byId("editTakeProfit").value = trade.takeProfit ?? "";
  byId("editNetProfit").value = trade.profitLoss ?? "";
  byId("editCommission").value = trade.commission ?? "";
  byId("editCloseReason").value = trade.closeReason || "None";
  byId("editNotes").value = trade.notes || "";
  setToggleValue($("#editTradeModal .jr-toggle-group"), trade.result === "BE" ? "BE" : (trade.result || "Win"));
  setToggleValue(byId("editTradeGrade"), trade.tradeRating || "");

  const fields = $all("#editTradeModal .jr-field.jr-form-full");
  const beforeField = fields.find(f => f.querySelector("label")?.textContent.trim() === "Before Entry");
  const duringField = fields.find(f => f.querySelector("label")?.textContent.trim() === "During Trade");
  const afterField = fields.find(f => f.querySelector("label")?.textContent.trim() === "After Exit");
  setChipsFromArray(beforeField, trade.emotionBefore);
  setChipsFromArray(duringField, trade.emotionDuring);
  setChipsFromArray(afterField, trade.emotionAfter);

  state.editExistingImages = trade.images ? { ...trade.images } : {};
  resetImageState("edit");
  state.editExistingImages = trade.images ? { ...trade.images } : {};
  renderImagePreviews("edit", $("#editTradeModal .jr-image-preview-grid"));

  openModal("editTradeModal");
}
function toDatetimeLocal(date) {
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function handleSaveEdit() {
  const btn = byId("saveEditTradeBtn");
  const tradeId = state.editingTradeId;
  if (!tradeId) return;
  const errors = validateTradeForm("edit");
  if (errors.length) { showToast(errors[0], "error"); return; }

  setBusy(btn, true);
  try {
    const tradeData = collectTradeFormData("edit");
    const tradeRef = doc(db, "users", state.uid, "accounts", state.selectedAccountId, "trades", tradeId);

    const hasNewImages = IMAGE_SLOTS.some(s => state.images.edit[s]);
    if (hasNewImages) {
      // Note: replaced Cloudinary images are simply overwritten in Firestore —
      // unsigned uploads can't delete the old remote asset without exposing
      // the API secret, so old orphaned images are left for manual cleanup.
      tradeData.images = await uploadTradeImages("edit");
    }

    await updateDoc(tradeRef, tradeData);
    closeModal("editTradeModal");
    showToast("Trade updated.", "success");
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  } finally {
    setBusy(btn, false);
  }
}

/* -----------------------------------------------------------------
   18. DELETE TRADE
   ----------------------------------------------------------------- */
async function handleConfirmDelete() {
  const btn = byId("confirmDeleteTradeBtn");
  const tradeId = state.deletingTradeId;
  if (!tradeId) return;
  setBusy(btn, true);
  try {
    const trade = state.trades.find(t => t.id === tradeId);
    await deleteDoc(doc(db, "users", state.uid, "accounts", state.selectedAccountId, "trades", tradeId));
    if (trade && trade.images) deleteTradeImages(trade.images);
    state.bulkSelected.delete(tradeId);
    closeModal("deleteTradeModal");
    showToast("Trade deleted.", "success");
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  } finally {
    setBusy(btn, false);
    state.deletingTradeId = null;
  }
}

/* Bulk delete (uses the existing bulk selection bar) */
async function handleDeleteSelected() {
  const btn = byId("deleteSelectedBtn");
  if (state.bulkSelected.size === 0) return;
  setBusy(btn, true);
  try {
    const batch = writeBatch(db);
    const idsToClean = [];
    state.bulkSelected.forEach(id => {
      batch.delete(doc(db, "users", state.uid, "accounts", state.selectedAccountId, "trades", id));
      idsToClean.push(id);
    });
    await batch.commit();
    idsToClean.forEach(id => {
      const t = state.trades.find(tr => tr.id === id);
      if (t && t.images) deleteTradeImages(t.images);
    });
    state.bulkSelected.clear();
    showToast("Selected trades deleted.", "success");
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  } finally {
    setBusy(btn, false);
  }
}

/* -----------------------------------------------------------------
   19. CLEAR ALL TRADES (selected account only)
   ----------------------------------------------------------------- */
async function handleConfirmClearAll() {
  const btn = byId("confirmClearAllBtn");
  if (!state.selectedAccountId) return;
  setBusy(btn, true);
  try {
    const tradesRef = collection(db, "users", state.uid, "accounts", state.selectedAccountId, "trades");
    const snap = await getDocs(tradesRef);
    const allImages = snap.docs.map(d => d.data().images).filter(Boolean);

    // Firestore batches are capped at 500 writes — chunk defensively.
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    allImages.forEach(images => deleteTradeImages(images));

    closeModal("clearAllModal");
    showToast("All trades cleared for this account.", "success");
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  } finally {
    setBusy(btn, false);
  }
}

/* -----------------------------------------------------------------
   20 & 21. CSV IMPORT / EXPORT
   ----------------------------------------------------------------- */
const CSV_COLUMNS = ["instrument","direction","date","entryTime","exitTime","lotSize","entryPrice","exitPrice",
  "stopLoss","takeProfit","profitLoss","risk","riskReward","result","strategy","setup","session",
  "marketCondition","timeframe","rating","notes"];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line) => {
    const out = []; let cur = ""; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuotes = !inQuotes; continue; }
      if (c === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(splitLine);
  return { headers, rows };
}

function wireCsvImport() {
  const importBtn = byId("importCsvBtn");
  if (!importBtn) return;
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,text/csv";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);

  importBtn.addEventListener("click", () => {
    if (!state.selectedAccountId) { showToast("Select a trading account first.", "error"); return; }
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    setBusy(importBtn, true);
    try {
      const text = await file.text();
      const { headers, rows } = parseCsv(text);
      const missing = ["instrument","date","entryprice","exitprice","lotsize"].filter(c => !headers.includes(c));
      if (missing.length) {
        showToast(`CSV is missing required column(s): ${missing.join(", ")}`, "error");
        return;
      }
      const idx = (name) => headers.indexOf(name.toLowerCase());
      let imported = 0, skipped = 0;
      const batchSize = 400;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = rows.slice(i, i + batchSize);
        chunk.forEach(row => {
          const instrument = row[idx("instrument")];
          const dateStr = row[idx("date")];
          const entryPrice = Number(row[idx("entryprice")]);
          const exitPrice = Number(row[idx("exitprice")]);
          const lotSize = Number(row[idx("lotsize")]);
          if (!instrument || !dateStr || isNaN(entryPrice) || isNaN(exitPrice) || isNaN(lotSize)) { skipped++; return; }
          const tradeDate = new Date(dateStr);
          if (isNaN(tradeDate.getTime())) { skipped++; return; }
          const docRef = doc(collection(db, "users", state.uid, "accounts", state.selectedAccountId, "trades"));
          batch.set(docRef, {
            instrument: instrument.toUpperCase(),
            direction: (row[idx("direction")] || "LONG").toUpperCase().includes("SHORT") ? "SHORT" : "LONG",
            tradeDate,
            entryTime: idx("entrytime") >= 0 ? row[idx("entrytime")] : "",
            exitTime: idx("exittime") >= 0 ? row[idx("exittime")] : "",
            lotSize, entryPrice, exitPrice,
            stopLoss: idx("stoploss") >= 0 && row[idx("stoploss")] !== "" ? Number(row[idx("stoploss")]) : null,
            takeProfit: idx("takeprofit") >= 0 && row[idx("takeprofit")] !== "" ? Number(row[idx("takeprofit")]) : null,
            profitLoss: idx("profitloss") >= 0 ? Number(row[idx("profitloss")]) || 0 : 0,
            risk: idx("risk") >= 0 && row[idx("risk")] !== "" ? Number(row[idx("risk")]) : null,
            riskReward: idx("riskreward") >= 0 ? row[idx("riskreward")] : "",
            result: idx("result") >= 0 ? row[idx("result")] : "Win",
            strategy: idx("strategy") >= 0 ? row[idx("strategy")] : "",
            setup: idx("setup") >= 0 ? row[idx("setup")] : "",
            session: idx("session") >= 0 ? row[idx("session")] : "",
            marketCondition: idx("marketcondition") >= 0 ? row[idx("marketcondition")] : "",
            timeframe: idx("timeframe") >= 0 ? row[idx("timeframe")] : "",
            rating: idx("rating") >= 0 && row[idx("rating")] !== "" ? Number(row[idx("rating")]) : 0,
            notes: idx("notes") >= 0 ? row[idx("notes")] : "",
            accountId: state.selectedAccountId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          imported++;
        });
        await batch.commit();
      }
      showToast(`Imported ${imported} trade${imported === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} invalid row(s)` : ""}.`, imported ? "success" : "error");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      setBusy(importBtn, false);
    }
  });
}

function wireCsvExport() {
  const exportBtn = byId("exportCsvBtn");
  if (!exportBtn) return;
  exportBtn.addEventListener("click", () => {
    const trades = state.filteredTrades.length ? state.filteredTrades : state.trades;
    if (trades.length === 0) { showToast("No trades to export.", "error"); return; }
    const header = CSV_COLUMNS.join(",");
    const rows = trades.map(t => {
      const rowMap = {
        instrument: t.instrument, direction: t.direction, date: getTradeDate(t)?.toISOString().slice(0,10) || "",
        entryTime: t.entryTime || "", exitTime: t.exitTime || "", lotSize: t.lotSize, entryPrice: t.entryPrice,
        exitPrice: t.exitPrice, stopLoss: t.stopLoss ?? "", takeProfit: t.takeProfit ?? "", profitLoss: t.profitLoss,
        risk: t.risk ?? "", riskReward: t.riskReward || "", result: t.result || "", strategy: t.strategy || "",
        setup: t.setup || "", session: t.session || "", marketCondition: t.marketCondition || "",
        timeframe: t.timeframe || "", rating: t.rating || 0, notes: (t.notes || "").replace(/"/g, '""')
      };
      return CSV_COLUMNS.map(c => `"${rowMap[c] ?? ""}"`).join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `journal-export-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("CSV exported.", "success");
  });
}

/* -----------------------------------------------------------------
   23. SHARE TRADE
   ----------------------------------------------------------------- */
function openShareModal(trade) {
  state.activeShareTradeId = trade.id;
  const modal = byId("shareTradeModal");
  if (!modal) return;

  $(".jr-modal-head p", modal).innerHTML = `Shareable card for ${escapeHtml(trade.instrument)} · <span class="${trade.result === 'Win' ? 'jr-profit-pos' : 'jr-profit-neg'}">${escapeHtml(trade.result || '—')}</span>`;

  const card = byId("shareCardCanvas");
  const winPill = $(".jr-pill", card.querySelector(".jr-share-brand"));
  if (winPill) { winPill.textContent = (trade.result || "").toUpperCase() || "—"; winPill.className = `jr-pill ${trade.result === "Win" ? "jr-pill-win" : "jr-pill-loss"}`; }
  $(".jr-share-symbol", card).textContent = trade.instrument || "—";
  const dirPill = $(".jr-share-symbol-row .jr-pill", card);
  if (dirPill) { dirPill.textContent = trade.direction === "SHORT" ? "SHORT" : "LONG"; dirPill.className = `jr-pill ${trade.direction === "SHORT" ? "jr-pill-short" : "jr-pill-long"}`; }

  const statVals = $all(".jr-share-stat-value", card);
  const statData = [fmtMoney(trade.profitLoss), trade.riskReward || "—", trade.lotSize ?? "—", trade.entryPrice ?? "—", trade.exitPrice ?? "—", trade.session || "—"];
  statVals.forEach((el, i) => { el.textContent = statData[i] ?? "—"; el.className = i === 0 ? `jr-share-stat-value ${(Number(trade.profitLoss)||0) >= 0 ? "jr-profit-pos" : "jr-profit-neg"}` : "jr-share-stat-value"; });

  const detailRows = $all(".jr-share-details .jr-detail-row span:last-child", modal);
  const detailData = [trade.instrument, trade.direction === "SHORT" ? "SHORT" : "LONG", fmtMoney(trade.profitLoss), trade.session || "—", trade.result || "—", fmtDate(getTradeDate(trade))];
  detailRows.forEach((el, i) => { el.textContent = detailData[i] ?? "—"; });

  openModal("shareTradeModal");
}

async function loadHtml2Canvas() {
  if (window.html2canvas) return window.html2canvas;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.html2canvas;
}

function wireShareActions() {
  const downloadBtn = byId("downloadShareImageBtn");
  const copyLinkBtn = byId("copyShareLinkBtn");
  if (downloadBtn) downloadBtn.addEventListener("click", async () => {
    setBusy(downloadBtn, true);
    try {
      const html2canvas = await loadHtml2Canvas();
      const canvas = await html2canvas(byId("shareCardCanvas"), { backgroundColor: null, scale: 2 });
      canvas.toBlob(async (blob) => {
        if (navigator.canShare && navigator.canShare({ files: [new File([blob], "trade.png", { type: "image/png" })] })) {
          try {
            await navigator.share({ files: [new File([blob], "trade.png", { type: "image/png" })], title: "My trade" });
            return;
          } catch (_) { /* fall through to download */ }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `trade-share-${state.activeShareTradeId || "card"}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      showToast("Couldn't generate the share image. Please try again.", "error");
      console.error(err);
    } finally {
      setBusy(downloadBtn, false);
    }
  });
  if (copyLinkBtn) copyLinkBtn.addEventListener("click", async () => {
    const trade = state.trades.find(t => t.id === state.activeShareTradeId);
    const url = trade?.images?.result?.url || trade?.images?.outlook?.url || window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied.", "success");
    } catch {
      showToast("Couldn't copy the link.", "error");
    }
  });
}

/* -----------------------------------------------------------------
   INITIALIZATION
   ----------------------------------------------------------------- */
async function boot() {
  const wrap = await waitForElement(".jr-wrap");
  wireModalTriggers(wrap.parentElement || document);

  wireToggleGroup(byId("addResultToggle"));
  $all("#addTradeModal .jr-toggle-group").forEach(wireToggleGroup);
  $all("#editTradeModal .jr-toggle-group").forEach(wireToggleGroup);
  $all(".jr-field .jr-chip-group", wrap).forEach(group => wireChipGroup(group.closest(".jr-field")));
  wireRating(byId("addTradeRating"));

  setupImageZone("add", byId("addImageTabs"), byId("addImageUploadZone"), byId("addImagePreviewGrid"));
  setupImageZone("edit", byId("editImageTabs"), $("#editTradeModal .jr-upload-zone"), $("#editTradeModal .jr-image-preview-grid"));

  wireAccountSelector();
  wireTimeRange();
  wireAdvancedFilters();
  wireViewSwitch();
  wireTradeActionDelegation();
  wireSelectAllRows();
  wireCsvImport();
  wireCsvExport();
  wireShareActions();

  const saveNewBtn = byId("saveNewTradeBtn");
  if (saveNewBtn) saveNewBtn.addEventListener("click", handleAddTrade);
  const saveEditBtn = byId("saveEditTradeBtn");
  if (saveEditBtn) saveEditBtn.addEventListener("click", handleSaveEdit);
  const confirmDeleteBtn = byId("confirmDeleteTradeBtn");
  if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", handleConfirmDelete);
  const confirmClearBtn = byId("confirmClearAllBtn");
  if (confirmClearBtn) confirmClearBtn.addEventListener("click", handleConfirmClearAll);
  const deleteSelectedBtn = byId("deleteSelectedBtn");
  if (deleteSelectedBtn) deleteSelectedBtn.addEventListener("click", handleDeleteSelected);
  const cancelSelectionBtn = byId("cancelSelectionBtn");
  if (cancelSelectionBtn) cancelSelectionBtn.addEventListener("click", () => {
    state.bulkSelected.clear();
    $all("[data-select-trade]").forEach(cb => cb.checked = false);
    updateStats();
  });
  const addTradeModal = byId("addTradeModal");
  if (addTradeModal) $all("[data-modal-close=addTradeModal]", addTradeModal).forEach(b => b.addEventListener("click", resetAddForm));

  initAuthAndBoot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}


