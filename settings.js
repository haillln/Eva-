/* =================================================================
   EVA — SETTINGS (settings.js)
   Wires the existing settings.html markup to the existing Firebase
   project (eval-61cd9) using the same init pattern as journal.js:
   never calls initializeApp() a second time for the same app.

   Firestore layout used by this file (extends the existing one):
     users/{uid}                        (profile — same doc journal.js reads)
     users/{uid}/accounts/{accountId}
     users/{uid}/accounts/{accountId}/trades/{tradeId}
     users/{uid}/settings/preferences   (trading prefs + appearance + notifications)
     users/{uid}/settings/journalOptions (all Journal customization lists)

   *** REQUIRED FIRESTORE RULES CHANGE ***
   The security rules supplied only allow read/write on
   `users/{userId}` and its `accounts`/`trades` subcollections. There
   is no rule for `users/{userId}/settings/{settingId}`, so under the
   current rules every read/write this file makes to the "settings"
   subcollection will be rejected with permission-denied by the
   catch-all `match /{document=**} { allow read, write: if false; }`.
   Add this inside the existing `match /users/{userId} { ... }` block
   (as a sibling of the `accounts` match), before the catch-all:

     match /settings/{settingId} {
       allow read, create, update, delete:
         if request.auth != null && request.auth.uid == userId;
     }

   Without this, Settings will load defaults every time and every
   save will show a permission-denied error.

   *** PROFILE PHOTO UPLOAD — CLOUDINARY, NOT FIREBASE STORAGE ***
   settings.html includes a profile-photo uploader that the original
   settings.js did not wire up. This file wires it up using the
   project's existing Cloudinary account, via its own DEDICATED
   unsigned upload preset (separate from the Trading Journal's
   trade-screenshot preset, so the journal uploader is untouched):
     cloud name:     u6sytyyq
     upload preset:  eva_profile_images  (unsigned, images only, 5MB max)
   No Firebase Storage is used or required for this feature. Only the
   cloud name and an *unsigned* preset name are used client-side —
   both are safe to expose; no API secret is ever placed in this file.
   The returned secure_url is saved to the existing `photoURL` field
   on the user's `users/{uid}` profile document, same as before.

   *** THEME ATTRIBUTE FIX ***
   settings.html's own theme bridge (see the CSS comments at the top
   of the page template) keys every themed rule off
   `html[data-eva-theme="light"|"dark"]` — that's the attribute the
   shared site layout actually uses. The original settings.js instead
   wrote `document.documentElement.dataset.theme` (i.e. a `data-theme`
   attribute), which no CSS rule in settings.html ever reads, so theme
   switching silently did nothing visually. This file sets
   `data-eva-theme` instead (see applyThemeMode below), and also
   resolves the HTML's third "System" option to the OS-level
   light/dark preference, since only "light"/"dark" have real rules.
   ================================================================= */

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut, sendPasswordResetEmail, deleteUser
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot,
  collection, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* -----------------------------------------------------------------
   1. FIREBASE INITIALIZATION — reuses the app layout.html already
   initialized (same config as journal.js). Never a second init.
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
   1b. CLOUDINARY (profile pictures only) — a dedicated unsigned
   upload preset, separate from the Trading Journal's existing
   trade-screenshot Cloudinary setup, so that uploader is never
   touched by this file. Unsigned presets are safe to reference
   client-side (no API secret involved).
   ----------------------------------------------------------------- */
const CLOUDINARY_CLOUD_NAME = "u6sytyyq";
const CLOUDINARY_UPLOAD_PRESET = "eva_profile_images";
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

async function uploadProfileImageToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: "POST", body: formData });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || "Cloudinary upload failed. Please try again.";
    throw new Error(message);
  }
  return data.secure_url;
}

/* -----------------------------------------------------------------
   CATEGORY METADATA
   The 10 categories that already have a visible card in
   settings.html, mapped to their existing container IDs.
   ----------------------------------------------------------------- */
const RENDERED_CATEGORIES = {
  strategies:        { containerId: "journal-option-strategies",        label: "Strategy" },
  setups:            { containerId: "journal-option-setups",            label: "Setup" },
  sessions:          { containerId: "journal-option-sessions",          label: "Session" },
  marketConditions:  { containerId: "journal-option-market-conditions", label: "Market Condition" },
  timeframes:        { containerId: "journal-option-timeframes",        label: "Timeframe" },
  lotSizePresets:    { containerId: "journal-option-lot-size-presets",  label: "Lot Size" },
  entryPricePresets: { containerId: "journal-option-entry-price-presets", label: "Entry Price" },
  emotionsBefore:    { containerId: "journal-option-emotions-before",   label: "Emotion Before" },
  emotionsDuring:    { containerId: "journal-option-emotions-during",   label: "Emotion During" },
  emotionsAfter:     { containerId: "journal-option-emotions-after",    label: "Emotion After" }
};

// Fields the "Journal Field" dropdown already knows about but that
// have no dedicated card in settings.html today. A card is created
// dynamically (same markup/classes as the rendered ones) the first
// time the user adds a value to one of these via "Create Custom Option".
const DROPDOWN_ONLY_LABELS = {
  tradeRating: "Trade Rating", followedPlan: "Followed Plan", confidence: "Confidence",
  discipline: "Discipline", closeReason: "Close Reason", result: "Result", direction: "Direction"
};

const ALL_KNOWN_LABELS = { ...Object.fromEntries(Object.entries(RENDERED_CATEGORIES).map(([k, v]) => [k, v.label])), ...DROPDOWN_ONLY_LABELS };

// Seed values — mirror the demo chips already hardcoded in
// settings.html, used only the very first time a user opens Settings
// (no Firestore doc yet).
const DEFAULT_JOURNAL_OPTIONS = {
  strategies: ["ICT Continuation", "Turtle Soup", "Breakout"],
  setups: ["FVG", "Order Block", "Liquidity Sweep"],
  sessions: ["Asia", "London", "New York"],
  marketConditions: ["Trending", "Ranging", "Volatile"],
  timeframes: ["1m", "5m", "15m", "1H", "4H", "D"],
  lotSizePresets: ["0.05", "0.10", "0.20"],
  entryPricePresets: [],
  emotionsBefore: ["Calm", "Confident", "Nervous", "Excited"],
  emotionsDuring: ["Patient", "Nervous", "Stressed", "FOMO"],
  emotionsAfter: ["Satisfied", "Relieved", "Frustrated", "Regretful"]
};

/* -----------------------------------------------------------------
   STATE
   ----------------------------------------------------------------- */
const state = {
  uid: null,
  authUser: null,
  journalOptions: {},   // category -> [{id, value}]
  customFields: [],     // [{id, name, options:[{id,value}]}] — brand new fields
  optionsUnsub: null,
  prefsUnsub: null,
  deleteContext: null,  // { type: 'option'|'clear-journal-data'|'delete-account', category, optionId }
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function byId(id) { return document.getElementById(id); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`); }

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
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* -----------------------------------------------------------------
   TOAST / BUSY / ERROR HELPERS (same conventions as journal.js)
   ----------------------------------------------------------------- */
function ensureToastHost() {
  let host = byId("stToastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "stToastHost";
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
  if (busy) { el.dataset.prevLabel = el.dataset.prevLabel || el.textContent; el.textContent = "Please wait…"; }
  else if (el.dataset.prevLabel) { el.textContent = el.dataset.prevLabel; delete el.dataset.prevLabel; }
}
function friendlyFirebaseError(err) {
  const code = err && err.code ? err.code : "";
  console.error("Firebase error:", err);
  if (code.includes("permission-denied")) return "This action was rejected by Firestore security rules. See the rules note in settings.js.";
  if (code.includes("unauthenticated")) return "You're not signed in. Please log in again.";
  if (code.includes("unavailable") || code === "network-request-failed") return "Network issue — please check your connection and try again.";
  if (code.includes("not-found")) return "That record no longer exists.";
  if (code === "auth/requires-recent-login") return "This action requires you to have signed in recently. Please log out and back in, then try again.";
  return err && err.message ? err.message : "Something went wrong. Please try again.";
}

/* -----------------------------------------------------------------
   MODAL CONTROLS — settings.html toggles modals via the `hidden`
   attribute (see the comments already in the markup).
   ----------------------------------------------------------------- */
function openModal(id) { const el = byId(id); if (el) el.hidden = false; }
function closeModal(id) { const el = byId(id); if (el) el.hidden = true; }

/* =================================================================
   2 & 3. AUTH + PROFILE
   ================================================================= */
function initAuthAndBoot() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    state.uid = user.uid;
    state.authUser = user;
    setSectionsLoading(true);
    try {
      await loadProfile(user);
      await loadPreferences();
      attachJournalOptionsListener();
    } finally {
      setSectionsLoading(false);
    }
  });
}

function setSectionsLoading(loading) {
  const page = $(".settings-page");
  if (page) page.classList.toggle("st-loading", !!loading);
}

async function loadProfile(authUser) {
  try {
    const snap = await getDoc(doc(db, "users", authUser.uid));
    const data = snap.exists() ? snap.data() : {};
    byId("profile-display-name").value = data.displayName || authUser.displayName || "";
    byId("profile-username").value = data.username || "";
    byId("profile-email").value = data.email || authUser.email || "";
    byId("profile-user-id").textContent = authUser.uid;
    byId("security-email").value = data.email || authUser.email || "";
    renderAvatarPreview(data.photoURL || authUser.photoURL || "");
    if (!snap.exists()) {
      // Safely initialize the default profile doc — must include `uid`
      // to satisfy the security rule (`request.resource.data.uid == userId`).
      await setDoc(doc(db, "users", authUser.uid), {
        uid: authUser.uid,
        email: authUser.email || "",
        displayName: authUser.displayName || "",
        username: "",
        createdAt: serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  }
}

/* -----------------------------------------------------------------
   PROFILE PHOTO — the markup for this (#profile-avatar-preview,
   #profile-upload-photo-btn, #profile-upload-photo-input) already
   exists in settings.html but the original settings.js never wired
   it up. Uploads go straight to Cloudinary (uploadProfileImageToCloudinary,
   defined in section 1b above) using the dedicated eva_profile_images
   unsigned preset — no Firebase Storage involved.
   ----------------------------------------------------------------- */
const DEFAULT_AVATAR_HTML = `<span><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></span>`;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // matches the "max 5MB" hint already in settings.html
const AVATAR_ALLOWED_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }; // matches "JPG, PNG or WebP" hint

function renderAvatarPreview(url) {
  const el = byId("profile-avatar-preview");
  if (!el) return;
  el.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="Profile photo">` : DEFAULT_AVATAR_HTML;
}

function wireProfilePhotoUpload() {
  const btn = byId("profile-upload-photo-btn");
  const input = byId("profile-upload-photo-input");
  if (!btn || !input) return;

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = ""; // allow re-selecting the same file later
    if (!file) return;

    const ext = AVATAR_ALLOWED_TYPES[file.type];
    if (!ext) { showToast("Please choose a JPG, PNG or WebP image.", "error"); return; }
    if (file.size > AVATAR_MAX_BYTES) { showToast("Image must be 5MB or smaller.", "error"); return; }

    const previousHtml = byId("profile-avatar-preview").innerHTML;
    const localUrl = URL.createObjectURL(file);
    renderAvatarPreview(localUrl); // immediate preview, per the required behavior

    setBusy(btn, true);
    input.disabled = true;
    try {
      const downloadUrl = await uploadProfileImageToCloudinary(file);
      await setDoc(doc(db, "users", state.uid), { uid: state.uid, photoURL: downloadUrl }, { merge: true });
      renderAvatarPreview(downloadUrl);
      showToast("Profile photo updated.", "success");
    } catch (err) {
      byId("profile-avatar-preview").innerHTML = previousHtml; // revert on failure
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      URL.revokeObjectURL(localUrl);
      setBusy(btn, false);
      input.disabled = false;
    }
  });
}

function wireProfile() {
  const original = {};
  const snapshotOriginal = () => {
    original.displayName = byId("profile-display-name").value;
    original.username = byId("profile-username").value;
  };
  snapshotOriginal();

  byId("profile-save-btn").addEventListener("click", async () => {
    const btn = byId("profile-save-btn");
    const displayName = byId("profile-display-name").value.trim();
    const username = byId("profile-username").value.trim();
    if (!displayName) { showToast("Display name can't be empty.", "error"); return; }
    setBusy(btn, true);
    try {
      // Always include `uid` — required by the security rule on every write.
      await setDoc(doc(db, "users", state.uid), { uid: state.uid, displayName, username }, { merge: true });
      snapshotOriginal();
      showToast("Profile updated.", "success");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      setBusy(btn, false);
    }
  });

  byId("profile-cancel-btn").addEventListener("click", () => {
    byId("profile-display-name").value = original.displayName;
    byId("profile-username").value = original.username;
  });
}

/* =================================================================
   PREFERENCES DOC — trading preferences + appearance + notifications
   live together in users/{uid}/settings/preferences
   ================================================================= */
function preferencesRef() { return doc(db, "users", state.uid, "settings", "preferences"); }

async function loadPreferences() {
  try {
    const snap = await getDoc(preferencesRef());
    const data = snap.exists() ? snap.data() : {};
    applyPreferencesToUI(data);
    if (!snap.exists()) {
      await setDoc(preferencesRef(), defaultPreferences(), { merge: true });
    }
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
  }
}

function defaultPreferences() {
  return {
    trading: {
      defaultInstrument: "NQ", defaultSession: "newyork", defaultTimeframe: "15m",
      defaultDirection: "long", defaultLotSize: 0.10, defaultRiskPercent: 1.0, accountCurrency: "USD"
    },
    appearance: { mode: "dark" },
    notifications: { enabled: true, tradingReminder: true, journalReminder: true, reminderTime: "20:00" }
  };
}

function applyPreferencesToUI(data) {
  const t = data.trading || {};
  if (t.defaultInstrument) byId("pref-default-instrument").value = t.defaultInstrument;
  if (t.defaultSession) byId("pref-default-session").value = t.defaultSession;
  if (t.defaultTimeframe) byId("pref-default-timeframe").value = t.defaultTimeframe;
  byId(t.defaultDirection === "short" ? "dir-short" : "dir-long").checked = true;
  if (t.defaultLotSize !== undefined) byId("pref-default-lot-size").value = t.defaultLotSize;
  if (t.defaultRiskPercent !== undefined) byId("pref-default-risk").value = t.defaultRiskPercent;
  if (t.accountCurrency) byId("pref-account-currency").value = t.accountCurrency;

  const mode = (data.appearance && data.appearance.mode) || "dark";
  const themeInput = byId(`theme-${mode}`);
  if (themeInput) themeInput.checked = true;
  applyThemeMode(mode);
  watchSystemTheme(mode === "system");

  const n = data.notifications || {};
  byId("notif-enable-toggle").checked = n.enabled !== false;
  byId("notif-trading-toggle").checked = n.tradingReminder !== false;
  byId("notif-journal-toggle").checked = n.journalReminder !== false;
  if (n.reminderTime) byId("notif-reminder-time").value = n.reminderTime;
}

function wireTradingPreferences() {
  byId("preferences-save-btn").addEventListener("click", async () => {
    const btn = byId("preferences-save-btn");
    const lotSize = Number(byId("pref-default-lot-size").value);
    const risk = Number(byId("pref-default-risk").value);
    if (byId("pref-default-lot-size").value !== "" && (isNaN(lotSize) || lotSize < 0)) {
      showToast("Default lot size must be a valid non-negative number.", "error"); return;
    }
    if (byId("pref-default-risk").value !== "" && (isNaN(risk) || risk < 0 || risk > 100)) {
      showToast("Default risk % must be between 0 and 100.", "error"); return;
    }
    setBusy(btn, true);
    try {
      await setDoc(preferencesRef(), {
        trading: {
          defaultInstrument: byId("pref-default-instrument").value,
          defaultSession: byId("pref-default-session").value,
          defaultTimeframe: byId("pref-default-timeframe").value,
          defaultDirection: byId("dir-short").checked ? "short" : "long",
          defaultLotSize: lotSize, defaultRiskPercent: risk,
          accountCurrency: byId("pref-account-currency").value
        }
      }, { merge: true });
      showToast("Trading preferences saved.", "success");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      setBusy(btn, false);
    }
  });
}

/* -----------------------------------------------------------------
   APPEARANCE — connects to the existing site theme system via a
   custom event + a global hook if present. layout.html / eva-loader.js
   were not provided, so verify `window.EVA_setTheme` (or swap the
   listener below) matches whatever the real theme system exposes.
   ----------------------------------------------------------------- */
// settings.html's theme CSS only defines rules for html[data-eva-theme="light"]
// and html[data-eva-theme="dark"] (see the page's own <style> comments) — there
// is no "system" rule, so "system" is resolved to whichever of those two
// matches the OS preference before being written to the DOM.
function resolveSystemTheme() {
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
}

function applyThemeMode(mode) {
  const resolved = mode === "system" ? resolveSystemTheme() : mode;
  // `data-eva-theme` is the attribute settings.html's CSS actually reads.
  document.documentElement.setAttribute("data-eva-theme", resolved);
  if (typeof window.EVA_setTheme === "function") window.EVA_setTheme(resolved);
  document.dispatchEvent(new CustomEvent("eva:theme-change", { detail: { mode, resolved } }));
}

let systemThemeMedia = null;
function watchSystemTheme(enabled) {
  if (!window.matchMedia) return;
  if (!systemThemeMedia) systemThemeMedia = window.matchMedia("(prefers-color-scheme: light)");
  systemThemeMedia.onchange = enabled ? () => applyThemeMode("system") : null;
}

function wireAppearance() {
  $all('input[name="appearanceMode"]').forEach(radio => {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const mode = radio.value;
      applyThemeMode(mode);
      watchSystemTheme(mode === "system");
      try {
        await setDoc(preferencesRef(), { appearance: { mode } }, { merge: true });
      } catch (err) {
        showToast(friendlyFirebaseError(err), "error");
      }
    });
  });
}

function wireNotifications() {
  const save = async (partial) => {
    try { await setDoc(preferencesRef(), { notifications: partial }, { merge: true }); }
    catch (err) { showToast(friendlyFirebaseError(err), "error"); }
  };
  byId("notif-enable-toggle").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  byId("notif-trading-toggle").addEventListener("change", (e) => save({ tradingReminder: e.target.checked }));
  byId("notif-journal-toggle").addEventListener("change", (e) => save({ journalReminder: e.target.checked }));
  byId("notif-reminder-time").addEventListener("change", (e) => save({ reminderTime: e.target.value }));
}

/* =================================================================
   4 & 5. JOURNAL OPTIONS ⭐ — the core of Settings
   Firestore doc shape: users/{uid}/settings/journalOptions =
     { [category]: [{id, value}], customFields: [{id, name, options:[{id,value}]}] }
   ================================================================= */
function journalOptionsRef() { return doc(db, "users", state.uid, "settings", "journalOptions"); }

function attachJournalOptionsListener() {
  if (state.optionsUnsub) state.optionsUnsub();
  state.optionsUnsub = onSnapshot(journalOptionsRef(), async (snap) => {
    if (!snap.exists()) {
      const seeded = {};
      for (const [cat, values] of Object.entries(DEFAULT_JOURNAL_OPTIONS)) {
        seeded[cat] = values.map(v => ({ id: uid(), value: v }));
      }
      seeded.customFields = [];
      try {
        await setDoc(journalOptionsRef(), seeded, { merge: true });
      } catch (err) {
        showToast(friendlyFirebaseError(err), "error");
      }
      return; // onSnapshot will fire again with the seeded data
    }
    const data = snap.data();
    state.journalOptions = {};
    for (const cat of Object.keys(ALL_KNOWN_LABELS)) {
      state.journalOptions[cat] = Array.isArray(data[cat]) ? data[cat] : [];
    }
    state.customFields = Array.isArray(data.customFields) ? data.customFields : [];
    renderAllJournalOptions();
  }, (err) => showToast(friendlyFirebaseError(err), "error"));
}

async function saveJournalOptionsField(fieldPath, value) {
  try {
    await setDoc(journalOptionsRef(), { [fieldPath]: value }, { merge: true });
    return true;
  } catch (err) {
    showToast(friendlyFirebaseError(err), "error");
    return false;
  }
}

function renderAllJournalOptions() {
  for (const cat of Object.keys(RENDERED_CATEGORIES)) renderCategoryChips(cat);
  // Dropdown-only fields: only render a card once they actually have values,
  // so we don't clutter the grid with cards for fields nobody customized.
  for (const cat of Object.keys(DROPDOWN_ONLY_LABELS)) {
    const hasValues = (state.journalOptions[cat] || []).length > 0;
    if (hasValues) { ensureDynamicCategoryCard(cat); renderCategoryChips(cat); }
  }
  renderCustomFieldCards();
}

function categoryContainerId(cat) {
  return (RENDERED_CATEGORIES[cat] && RENDERED_CATEGORIES[cat].containerId) || `journal-option-dyn-${cat}`;
}
function categoryLabel(cat) { return ALL_KNOWN_LABELS[cat] || cat; }

function ensureDynamicCategoryCard(cat) {
  const id = categoryContainerId(cat);
  if (byId(id)) return;
  const grid = $(".journal-options-grid");
  if (!grid) return;
  const card = document.createElement("div");
  card.className = "option-category";
  card.id = id;
  card.dataset.optionCategory = cat;
  card.innerHTML = `
    <div class="option-category-header"><h3>${escapeHtml(categoryLabel(cat))}</h3><span class="option-count">0</span></div>
    <div class="option-list"></div>
    <button type="button" class="btn btn-secondary btn-sm add-option-btn" data-action="add"><span>Add ${escapeHtml(categoryLabel(cat))}</span></button>`;
  grid.appendChild(card);
  wireCategoryAddButton(card, cat);
}

function renderCategoryChips(cat) {
  const container = byId(categoryContainerId(cat));
  if (!container) return;
  const list = $(".option-list", container);
  const count = $(".option-count", container);
  const items = state.journalOptions[cat] || [];
  count.textContent = String(items.length);
  list.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "custom-option-empty-hint";
    empty.textContent = "No options yet.";
    list.appendChild(empty);
    return;
  }
  items.forEach(item => list.appendChild(buildChipEl(cat, item)));
}

function buildChipEl(cat, item) {
  const chip = document.createElement("div");
  chip.className = "option-chip";
  chip.dataset.optionId = item.id;

  const span = document.createElement("span");
  span.textContent = item.value;

  const actions = document.createElement("div");
  actions.className = "option-chip-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button"; editBtn.className = "icon-btn"; editBtn.title = "Edit"; editBtn.setAttribute("aria-label", "Edit option");
  editBtn.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
  editBtn.addEventListener("click", () => beginInlineEdit(cat, item, chip, span));

  const delBtn = document.createElement("button");
  delBtn.type = "button"; delBtn.className = "icon-btn danger"; delBtn.title = "Delete"; delBtn.setAttribute("aria-label", "Delete option");
  delBtn.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
  delBtn.addEventListener("click", () => {
    state.deleteContext = { type: "option", category: cat, optionId: item.id, label: item.value };
    byId("delete-confirm-title").textContent = "Delete this option?";
    byId("delete-confirm-message").textContent = `"${item.value}" will be permanently removed from ${categoryLabel(cat)}. Past trades keep their saved value.`;
    openModal("delete-confirm-modal");
  });

  actions.appendChild(editBtn); actions.appendChild(delBtn);
  chip.appendChild(span); chip.appendChild(actions);
  return chip;
}

function beginInlineEdit(cat, item, chip, span) {
  if (chip.querySelector("input")) return; // already editing
  const input = document.createElement("input");
  input.type = "text"; input.value = item.value;
  input.style.cssText = "flex:1;background:var(--bg-input,#1b1e26);border:1px solid var(--accent,#3b82f6);color:var(--text-primary,#f2f3f5);border-radius:6px;padding:4px 8px;font-size:13px;";
  chip.replaceChild(input, span);
  input.focus(); input.select();

  const commit = async () => {
    const newValue = input.value.trim();
    if (!newValue) { showToast("Option name can't be empty.", "error"); input.focus(); return; }
    const items = state.journalOptions[cat] || [];
    const dup = items.some(i => i.id !== item.id && i.value.toLowerCase() === newValue.toLowerCase());
    if (dup) { showToast("That option already exists.", "error"); input.focus(); return; }
    if (newValue === item.value) { cancel(); return; }
    const updated = items.map(i => i.id === item.id ? { ...i, value: newValue } : i);
    const ok = await saveJournalOptionsField(cat, updated);
    if (ok) showToast("Option updated.", "success");
  };
  const cancel = () => { if (chip.contains(input)) chip.replaceChild(span, input); };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", () => { if (chip.contains(input)) commit(); });
}

function wireCategoryAddButton(container, cat) {
  const btn = $('.add-option-btn[data-action="add"]', container);
  if (!btn || btn.dataset.stWired) return;
  btn.dataset.stWired = "1";
  btn.addEventListener("click", () => openAddValueModal(cat));
}
function wireAllCategoryAddButtons() {
  Object.keys(RENDERED_CATEGORIES).forEach(cat => {
    const container = byId(categoryContainerId(cat));
    if (container) wireCategoryAddButton(container, cat);
  });
}

/* -----------------------------------------------------------------
   ADD / CREATE CUSTOM OPTION MODAL
   Reused for three flows, all via the one modal already in the HTML:
     1. Quick "Add X" on an existing rendered category (field-type
        select is locked to that category).
     2. "Create Custom Option" -> bulk-add values to any known field.
     3. "Create Custom Option" -> "New Field…" -> brand new field.
   ----------------------------------------------------------------- */
let pendingValues = []; // values staged in the modal before Save

function openAddValueModal(lockedCategory) {
  pendingValues = [];
  const select = byId("custom-option-field-type");
  const targetField = byId("field-custom-option-target");
  const nameField = byId("field-custom-option-new-name");

  if (lockedCategory) {
    select.value = lockedCategory;
    targetField.style.display = "none";
    nameField.style.display = "none";
    byId("custom-option-title").textContent = `Add ${categoryLabel(lockedCategory)}`;
  } else {
    targetField.style.display = "";
    byId("custom-option-title").textContent = "Create Custom Option";
    toggleNewNameField();
  }
  renderPendingValues();
  byId("custom-option-new-value-input").value = "";
  openModal("custom-option-modal");
}

function toggleNewNameField() {
  const isNew = byId("custom-option-field-type").value === "custom";
  byId("field-custom-option-new-name").style.display = isNew ? "" : "none";
}

function renderPendingValues() {
  const list = byId("custom-option-values-list");
  const emptyHint = byId("custom-option-values-empty-hint");
  list.innerHTML = "";
  emptyHint.style.display = pendingValues.length ? "none" : "";
  pendingValues.forEach((val, idx) => {
    const row = document.createElement("div");
    row.className = "custom-option-value-row";
    const input = document.createElement("input");
    input.type = "text"; input.value = val;
    input.addEventListener("input", () => { pendingValues[idx] = input.value; });
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "icon-btn danger"; rm.setAttribute("aria-label", "Remove option");
    rm.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>';
    rm.addEventListener("click", () => { pendingValues.splice(idx, 1); renderPendingValues(); });
    row.appendChild(input); row.appendChild(rm);
    list.appendChild(row);
  });
}

function wireCustomOptionModal() {
  byId("custom-option-field-type").addEventListener("change", toggleNewNameField);

  byId("custom-option-add-value-btn").addEventListener("click", () => {
    const input = byId("custom-option-new-value-input");
    const val = input.value.trim();
    if (!val) return;
    if (pendingValues.some(v => v.toLowerCase() === val.toLowerCase())) {
      showToast("That value is already staged.", "error"); return;
    }
    pendingValues.push(val);
    input.value = "";
    renderPendingValues();
    input.focus();
  });
  byId("custom-option-new-value-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); byId("custom-option-add-value-btn").click(); }
  });

  const closeIt = () => { closeModal("custom-option-modal"); byId("field-custom-option-target").style.display = ""; byId("field-custom-option-new-name").style.display = ""; };
  byId("custom-option-cancel-btn").addEventListener("click", closeIt);
  byId("custom-option-close-btn").addEventListener("click", closeIt);

  byId("custom-option-save-btn").addEventListener("click", async () => {
    const btn = byId("custom-option-save-btn");
    const staged = byId("custom-option-new-value-input").value.trim();
    if (staged) pendingValues.push(staged); // capture anything left in the input box
    if (!pendingValues.length) { showToast("Add at least one option.", "error"); return; }

    const selectedField = byId("custom-option-field-type").value;
    const isNewField = selectedField === "custom" && byId("field-custom-option-target").style.display !== "none";

    setBusy(btn, true);
    try {
      if (isNewField) {
        const name = byId("custom-option-field-name").value.trim();
        if (!name) { showToast("Give the new field a name.", "error"); setBusy(btn, false); return; }
        const dup = state.customFields.some(f => f.name.toLowerCase() === name.toLowerCase());
        if (dup) { showToast("A custom field with that name already exists.", "error"); setBusy(btn, false); return; }
        const newField = { id: uid(), name, options: pendingValues.map(v => ({ id: uid(), value: v })) };
        const updated = [...state.customFields, newField];
        const ok = await saveJournalOptionsField("customFields", updated);
        if (ok) { showToast("Custom field created.", "success"); closeIt(); byId("custom-option-field-name").value = ""; }
      } else {
        const cat = selectedField;
        const existing = state.journalOptions[cat] || [];
        const existingLower = new Set(existing.map(i => i.value.toLowerCase()));
        const toAdd = [...new Set(pendingValues.map(v => v.trim()).filter(Boolean))]
          .filter(v => !existingLower.has(v.toLowerCase()))
          .map(v => ({ id: uid(), value: v }));
        if (!toAdd.length) { showToast("Those options already exist.", "error"); setBusy(btn, false); return; }
        ensureDynamicCategoryCard(cat);
        const ok = await saveJournalOptionsField(cat, [...existing, ...toAdd]);
        if (ok) { showToast("Option(s) added.", "success"); closeIt(); }
      }
    } finally {
      setBusy(btn, false);
    }
  });
}

/* -----------------------------------------------------------------
   BRAND NEW CUSTOM FIELDS — rendered as their own cards, same markup
   pattern as a normal category, appended after the known categories.
   ----------------------------------------------------------------- */
function renderCustomFieldCards() {
  const grid = $(".journal-options-grid");
  if (!grid) return;
  state.customFields.forEach(field => {
    const domId = `journal-option-custom-${field.id}`;
    let card = byId(domId);
    if (!card) {
      card = document.createElement("div");
      card.className = "option-category";
      card.id = domId;
      card.innerHTML = `
        <div class="option-category-header"><h3>${escapeHtml(field.name)}</h3><span class="option-count">0</span></div>
        <div class="option-list"></div>
        <button type="button" class="btn btn-secondary btn-sm add-option-btn" data-action="add"><span>Add ${escapeHtml(field.name)}</span></button>`;
      grid.appendChild(card);
      $(".add-option-btn", card).addEventListener("click", () => openAddValueForCustomField(field.id));
    }
    const list = $(".option-list", card);
    const count = $(".option-count", card);
    const items = field.options || [];
    count.textContent = String(items.length);
    list.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "custom-option-empty-hint";
      empty.textContent = "No options yet.";
      list.appendChild(empty);
      return;
    }
    items.forEach(item => list.appendChild(buildCustomFieldChipEl(field, item)));
  });
}

function buildCustomFieldChipEl(field, item) {
  const chip = document.createElement("div");
  chip.className = "option-chip";
  chip.dataset.optionId = item.id;
  const span = document.createElement("span");
  span.textContent = item.value;
  const actions = document.createElement("div");
  actions.className = "option-chip-actions";
  const delBtn = document.createElement("button");
  delBtn.type = "button"; delBtn.className = "icon-btn danger"; delBtn.title = "Delete"; delBtn.setAttribute("aria-label", "Delete option");
  delBtn.innerHTML = '<svg class="icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
  delBtn.addEventListener("click", () => {
    state.deleteContext = { type: "custom-field-option", fieldId: field.id, optionId: item.id, label: item.value };
    byId("delete-confirm-title").textContent = "Delete this option?";
    byId("delete-confirm-message").textContent = `"${item.value}" will be permanently removed from ${field.name}.`;
    openModal("delete-confirm-modal");
  });
  actions.appendChild(delBtn);
  chip.appendChild(span); chip.appendChild(actions);
  return chip;
}

function openAddValueForCustomField(fieldId) {
  const field = state.customFields.find(f => f.id === fieldId);
  if (!field) return;
  const val = prompt(`Add an option to "${field.name}":`);
  const trimmed = (val || "").trim();
  if (!trimmed) return;
  if ((field.options || []).some(o => o.value.toLowerCase() === trimmed.toLowerCase())) {
    showToast("That option already exists.", "error"); return;
  }
  const updated = state.customFields.map(f => f.id === fieldId
    ? { ...f, options: [...(f.options || []), { id: uid(), value: trimmed }] }
    : f);
  saveJournalOptionsField("customFields", updated).then(ok => { if (ok) showToast("Option added.", "success"); });
}

/* =================================================================
   6 & 7. DELETE CONFIRMATION MODAL — generic, reused for options,
   clearing journal data, and deleting the account.
   ================================================================= */
function wireDeleteConfirmModal() {
  const cancel = () => { closeModal("delete-confirm-modal"); state.deleteContext = null; };
  byId("delete-confirm-cancel-btn").addEventListener("click", cancel);
  byId("delete-confirm-close-btn").addEventListener("click", cancel);

  byId("delete-confirm-btn").addEventListener("click", async () => {
    const ctx = state.deleteContext;
    if (!ctx) return;
    const btn = byId("delete-confirm-btn");
    setBusy(btn, true);
    try {
      if (ctx.type === "option") {
        const items = (state.journalOptions[ctx.category] || []).filter(i => i.id !== ctx.optionId);
        const ok = await saveJournalOptionsField(ctx.category, items);
        if (ok) showToast("Option deleted.", "success");
      } else if (ctx.type === "custom-field-option") {
        const updated = state.customFields.map(f => f.id === ctx.fieldId
          ? { ...f, options: (f.options || []).filter(o => o.id !== ctx.optionId) }
          : f);
        const ok = await saveJournalOptionsField("customFields", updated);
        if (ok) showToast("Option deleted.", "success");
      } else if (ctx.type === "clear-journal-data") {
        await clearAllJournalData();
        showToast("Journal data cleared.", "success");
      } else if (ctx.type === "delete-account") {
        await performAccountDeletion();
      }
      closeModal("delete-confirm-modal");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
    } finally {
      setBusy(btn, false);
      state.deleteContext = null;
    }
  });

  // Danger-zone triggers already in the HTML.
  byId("action-clear-journal-data").querySelector('[data-action="open-delete-confirm"]').addEventListener("click", () => {
    state.deleteContext = { type: "clear-journal-data" };
    byId("delete-confirm-title").textContent = "Clear journal data?";
    byId("delete-confirm-message").textContent = "This permanently deletes every trade in every account. This cannot be undone.";
    openModal("delete-confirm-modal");
  });
  byId("action-delete-account").querySelector('[data-action="open-delete-confirm"]').addEventListener("click", () => {
    state.deleteContext = { type: "delete-account" };
    byId("delete-confirm-title").textContent = "Delete account?";
    byId("delete-confirm-message").textContent = "This permanently deletes your account. This cannot be undone.";
    openModal("delete-confirm-modal");
  });
}

/* Note: historical trades are never touched here — only the option
   *lists* live in users/{uid}/settings/journalOptions. Deleting or
   editing an option never rewrites existing trade documents. */

/* =================================================================
   13. DATA & BACKUP
   ================================================================= */
async function fetchAllAccountsAndTrades() {
  const accountsSnap = await getDocs(collection(db, "users", state.uid, "accounts"));
  const accounts = [];
  for (const accDoc of accountsSnap.docs) {
    const tradesSnap = await getDocs(collection(db, "users", state.uid, "accounts", accDoc.id, "trades"));
    accounts.push({
      id: accDoc.id,
      ...accDoc.data(),
      trades: tradesSnap.docs.map(t => ({ id: t.id, ...t.data() }))
    });
  }
  return accounts;
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function tradesToCsv(trades) {
  const cols = ["instrument", "direction", "tradeDate", "entryTime", "exitTime", "lotSize", "entryPrice", "exitPrice",
    "stopLoss", "takeProfit", "profitLoss", "risk", "riskReward", "result", "strategy", "setup", "session",
    "marketCondition", "timeframe", "rating", "notes"];
  const rows = [cols.join(",")];
  trades.forEach(t => {
    rows.push(cols.map(c => {
      const v = t[c] === undefined || t[c] === null ? "" : String(t[c]).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(","));
  });
  return rows.join("\n");
}

function wireDataBackup() {
  byId("action-export-trades").querySelector('[data-action="export-trades"]').addEventListener("click", async (e) => {
    setBusy(e.target, true);
    try {
      const accounts = await fetchAllAccountsAndTrades();
      const allTrades = accounts.flatMap(a => a.trades);
      downloadFile(`eva-trades-${Date.now()}.csv`, tradesToCsv(allTrades), "text/csv");
      showToast(`Exported ${allTrades.length} trades.`, "success");
    } catch (err) { showToast(friendlyFirebaseError(err), "error"); }
    finally { setBusy(e.target, false); }
  });

  byId("action-export-journal").querySelector('[data-action="export-journal"]').addEventListener("click", async (e) => {
    setBusy(e.target, true);
    try {
      const accounts = await fetchAllAccountsAndTrades();
      downloadFile(`eva-journal-${Date.now()}.json`, JSON.stringify({ accounts }, null, 2), "application/json");
      showToast("Journal data exported.", "success");
    } catch (err) { showToast(friendlyFirebaseError(err), "error"); }
    finally { setBusy(e.target, false); }
  });

  byId("action-download-backup").querySelector('[data-action="download-backup"]').addEventListener("click", async (e) => {
    setBusy(e.target, true);
    try {
      const [accounts, profileSnap, prefsSnap, optionsSnap] = await Promise.all([
        fetchAllAccountsAndTrades(),
        getDoc(doc(db, "users", state.uid)),
        getDoc(preferencesRef()),
        getDoc(journalOptionsRef())
      ]);
      const backup = {
        version: 1, exportedAt: new Date().toISOString(), uid: state.uid,
        profile: profileSnap.exists() ? profileSnap.data() : {},
        preferences: prefsSnap.exists() ? prefsSnap.data() : {},
        journalOptions: optionsSnap.exists() ? optionsSnap.data() : {},
        accounts
      };
      downloadFile(`eva-backup-${Date.now()}.json`, JSON.stringify(backup, null, 2), "application/json");
      showToast("Backup downloaded.", "success");
    } catch (err) { showToast(friendlyFirebaseError(err), "error"); }
    finally { setBusy(e.target, false); }
  });

  let pendingRestoreFile = null;
  const importInput = byId("import-backup-input");
  byId("action-import-backup").querySelector('[data-action="import-backup"]').addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    pendingRestoreFile = importInput.files[0] || null;
    if (pendingRestoreFile) showToast(`Selected ${pendingRestoreFile.name}. Click Restore to apply it.`, "info");
  });

  byId("action-restore-backup").querySelector('[data-action="restore-backup"]').addEventListener("click", async (e) => {
    if (!pendingRestoreFile) { showToast("Choose a backup file with Import first.", "error"); return; }
    if (!confirm("Restoring will overwrite your current preferences and journal options with the backup's data. Continue?")) return;
    setBusy(e.target, true);
    try {
      const text = await pendingRestoreFile.text();
      const backup = JSON.parse(text);
      if (backup.preferences) await setDoc(preferencesRef(), backup.preferences, { merge: false });
      if (backup.journalOptions) await setDoc(journalOptionsRef(), backup.journalOptions, { merge: false });
      showToast("Backup restored (preferences & journal options). Trades are not overwritten automatically.", "success");
    } catch (err) {
      showToast(err instanceof SyntaxError ? "That file isn't a valid backup JSON." : friendlyFirebaseError(err), "error");
    } finally { setBusy(e.target, false); }
  });
}

async function clearAllJournalData() {
  // Deletes every trade in every account. Uses writeBatch semantics via
  // Promise.all of deleteDoc calls to avoid an extra Firestore import
  // beyond what's needed; accounts themselves are preserved.
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js");
  const accountsSnap = await getDocs(collection(db, "users", state.uid, "accounts"));
  for (const accDoc of accountsSnap.docs) {
    const tradesSnap = await getDocs(collection(db, "users", state.uid, "accounts", accDoc.id, "trades"));
    await Promise.all(tradesSnap.docs.map(t => deleteDoc(doc(db, "users", state.uid, "accounts", accDoc.id, "trades", t.id))));
  }
}

/* =================================================================
   15. ACCOUNT & SECURITY
   ================================================================= */
function wireAccountSecurity() {
  byId("action-change-password").querySelector('[data-action="change-password"]').addEventListener("click", async (e) => {
    setBusy(e.target, true);
    try {
      const email = state.authUser.email;
      if (!email) { showToast("No email on this account to send a reset link to.", "error"); return; }
      await sendPasswordResetEmail(auth, email);
      showToast(`Password reset email sent to ${email}.`, "success");
    } catch (err) { showToast(friendlyFirebaseError(err), "error"); }
    finally { setBusy(e.target, false); }
  });

  byId("action-auth-provider").querySelector('[data-action="manage-auth"]').addEventListener("click", () => {
    const providers = (state.authUser.providerData || []).map(p => p.providerId).join(", ") || "unknown";
    showToast(`Signed in via: ${providers}. Manage linked providers from your identity provider.`, "info");
  });
}

// Firestore rules supplied have `allow delete: if false;` on users/{userId},
// so the profile document cannot actually be deleted from the client under
// the current rules — that needs a trusted backend (e.g. a Cloud Function)
// to cascade-delete accounts/trades and the user doc. This performs the
// part that *is* possible from the client: deleting the Auth account.
async function performAccountDeletion() {
  try {
    await deleteUser(state.authUser);
    showToast("Account deleted.", "success");
    window.location.href = "login.html";
  } catch (err) {
    if (err.code === "auth/requires-recent-login") {
      showToast(friendlyFirebaseError(err), "error");
    } else {
      showToast(friendlyFirebaseError(err), "error");
    }
    throw err;
  }
}

/* =================================================================
   14. LOGOUT
   ================================================================= */
function wireLogout() {
  byId("logout-btn").addEventListener("click", () => openModal("logout-confirm-modal"));
  byId("logout-confirm-cancel-btn").addEventListener("click", () => closeModal("logout-confirm-modal"));
  byId("logout-confirm-close-btn").addEventListener("click", () => closeModal("logout-confirm-modal"));
  byId("logout-confirm-btn").addEventListener("click", async () => {
    const btn = byId("logout-confirm-btn");
    setBusy(btn, true);
    try {
      await signOut(auth);
      window.location.href = "login.html"; // same redirect target journal.js uses
    } catch (err) {
      showToast(friendlyFirebaseError(err), "error");
      setBusy(btn, false);
    }
  });
}

/* =================================================================
   INITIALIZATION
   ================================================================= */
async function boot() {
  await waitForElement(".settings-page");

  wireProfile();
  wireProfilePhotoUpload();
  wireTradingPreferences();
  wireAppearance();
  wireNotifications();
  wireAllCategoryAddButtons();
  wireCustomOptionModal();
  wireDeleteConfirmModal();
  wireDataBackup();
  wireAccountSecurity();
  wireLogout();

  byId("journal-create-custom-option-btn").addEventListener("click", () => openAddValueModal(null));

  initAuthAndBoot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}


