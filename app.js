/*
 * Copyright (c) 2026 Kevin Schmitz - voidnexus.de
 * SPDX-License-Identifier: GPL-3.0-only
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmtEUR = (cents) => (cents/100).toLocaleString("de-DE", { style:"currency", currency:"EUR" });
const APP_VERSION = "1.0";
const APP_BUILD = APP_VERSION;
const AUTO_LOGIN_DELAY_MS = 150;
const DEFAULT_APP_NAME = "KassenWart";
let appName = DEFAULT_APP_NAME;

function uuid(){
  // No secure-context required. Good enough for local/offline IDs.
  const r = () => Math.floor(Math.random()*0xFFFFFFFF).toString(16).padStart(8,"0");
  const t = Date.now().toString(16);
  return `${t}-${r()}-${r()}`;
}
function safeUUID(){
  try{ return crypto?.randomUUID?.() || uuid(); }catch(e){ return uuid(); }
}

function setFooter(){
  const el = document.getElementById("appFooterText");
  if (el) el.textContent = "© 2026 Kevin Schmitz · voidnexus.de";
}

function normalizeAppName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name.slice(0, 40) || DEFAULT_APP_NAME;
}

function applyAppName(value) {
  appName = normalizeAppName(value);
  const title = document.getElementById("brandTitle");
  if (title) title.textContent = appName;
  document.title = appName;
}

async function loadAppName() {
  applyAppName(await DB.getSetting("appName", DEFAULT_APP_NAME));
  return appName;
}

let themeScheduleTimer = null;
let batteryUpdateTimer = null;
const appStartedAt = Date.now();

function normalizeTheme(theme) {
  return theme === "light" || theme === "dark" ? theme : "light";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseEuroCents(value) {
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateNoonTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function applyTheme(theme) {
  document.body.classList.remove("theme-dark","theme-light");
  const t = normalizeTheme(theme);
  document.body.classList.add(`theme-${t}`);
}

function timeToMinutes(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

function isValidTime(value) {
  return timeToMinutes(value, -1) >= 0;
}

function scheduledTheme(now, lightTime, darkTime) {
  const lightAt = timeToMinutes(lightTime, 6 * 60);
  const darkAt = timeToMinutes(darkTime, 18 * 60);
  const current = now.getHours() * 60 + now.getMinutes();
  if (lightAt === darkAt) return "dark";
  if (lightAt < darkAt) return current >= lightAt && current < darkAt ? "light" : "dark";
  return current >= lightAt || current < darkAt ? "light" : "dark";
}

async function loadThemeSetting() {
  const theme = normalizeTheme(await DB.getSetting("theme", "light"));
  applyTheme(theme);
  return theme;
}

function nextTimeOccurrence(now, value) {
  const minutes = timeToMinutes(value, -1);
  if (minutes < 0) return null;
  const next = new Date(now);
  next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 250);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleNextThemeChange(autoEnabled, lightTime, darkTime) {
  if (themeScheduleTimer) clearTimeout(themeScheduleTimer);
  themeScheduleTimer = null;
  if (!autoEnabled) return;
  const now = new Date();
  const candidates = [nextTimeOccurrence(now, lightTime), nextTimeOccurrence(now, darkTime)]
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  if (!candidates.length) return;
  themeScheduleTimer = setTimeout(() => loadThemeSetting().catch(console.error), Math.max(250, candidates[0].getTime() - now.getTime()));
}

const session = {
  mode: "idle", // idle | user | admin_login | admin
  userId: null,
  userStartedAt: null,
  lastActivityMs: Date.now(),
  toastTimer: null
};

const userViewState = {
  balanceCents: 0,
  productsById: new Map(),
  todayTxnsExpanded: false
};
const personalReportCache = new Map();
const personalReportState = {
  mode: "month",
  date: new Date(),
  monthDate: new Date(),
  yearDate: new Date()
};
const UNLOCK_CODES = Object.freeze({
  KW3MONAT7X: { id:"monthly", label:"Monatsauswertung" },
  KW8JAHR4QZ: { id:"yearly", label:"Jahresauswertung" },
  KW4THEME8X: { id:"themes", label:"Theme-Auswahl" },
  KW6TEST9UZ: { id:"testUsers", label:"Testnutzer" }
});
const unlockedFeatures = new Set();

async function loadUnlockedFeatures() {
  unlockedFeatures.clear();
  const featureIds = [...new Set(Object.values(UNLOCK_CODES).map(feature => feature.id))];
  const values = await Promise.all(featureIds.map(id => DB.getSetting(`featureUnlocked_${id}`, false)));
  featureIds.forEach((id, index) => {
    if (values[index] === true) unlockedFeatures.add(id);
  });
}

function featureIsUnlocked(id) {
  return unlockedFeatures.has(id);
}
let currentAdminTab = null;
let deviceBatteryState = { available:false, level:null, plugged:false };
let lastRuntimeActivationAt = 0;
let automaticSystemCheckDate = null;
let automaticSystemIssues = null;

const TIMEOUTS = {
  idleInputResetMs: 15000,
  userAutoLogoutMs: 20000,
  adminAutoLogoutMs: 60000
};

let pinBuffer = "";
let adminBuffer = "";

function updateIdleClock(now = new Date()) {
  const timeEl = $("#idleTime");
  const dateEl = $("#idleDate");
  if (!timeEl || !dateEl) return;

  timeEl.textContent = now.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  });
  dateEl.textContent = now.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function batteryLevelClass(level) {
  if (level <= 10) return "critical";
  if (level <= 20) return "low";
  if (level <= 50) return "warning";
  return "normal";
}

function setBatteryFill(element, level) {
  if (!element) return;
  element.style.width = `${Math.max(0, Math.min(100, level))}%`;
}

function renderDeviceBattery() {
  const state = deviceBatteryState;
  const idleBadge = $("#idleBatteryBadge");
  const showIdleWarning = state.available && !state.plugged && state.level <= 50;
  if (idleBadge) {
    idleBadge.classList.toggle("hidden", !showIdleWarning);
    idleBadge.classList.remove("battery--warning", "battery--low", "battery--critical");
    if (showIdleWarning) idleBadge.classList.add(`battery--${batteryLevelClass(state.level)}`);
    if (state.available) {
      $("#idleBatteryValue").textContent = `${state.level}%`;
      setBatteryFill($("#idleBatteryFill"), state.level);
      idleBadge.setAttribute("aria-label", `Akkustand ${state.level} Prozent`);
    }
  }

  const adminCard = $("#adminBatteryCard");
  if (!adminCard) return;
  adminCard.classList.remove("battery--warning", "battery--low", "battery--critical", "battery--charging");
  if (!state.available) {
    $("#adminBatteryValue").textContent = "Nicht verfügbar";
    $("#adminBatteryStatus").textContent = "Akkustand ist auf diesem Gerät nicht verfügbar.";
    setBatteryFill($("#adminBatteryFill"), 0);
    return;
  }

  $("#adminBatteryValue").textContent = `${state.level}%`;
  setBatteryFill($("#adminBatteryFill"), state.level);
  if (state.plugged) {
    adminCard.classList.add("battery--charging");
    $("#adminBatteryStatus").textContent = "Ladekabel angeschlossen";
    return;
  }

  const levelClass = batteryLevelClass(state.level);
  if (levelClass !== "normal") adminCard.classList.add(`battery--${levelClass}`);
  $("#adminBatteryStatus").textContent = levelClass === "critical"
    ? "Kritischer Akkustand – Gerät bitte laden"
    : levelClass === "low"
      ? "Niedriger Akkustand – Laden empfohlen"
      : levelClass === "warning"
        ? "Akkustand beachten"
        : "Akkustand in Ordnung";
}

function updateDeviceBattery() {
  try {
    const fullyInterface = window.fully;
    if (!fullyInterface || typeof fullyInterface.getBatteryLevel !== "function" || typeof fullyInterface.isPlugged !== "function") {
      deviceBatteryState = { available:false, level:null, plugged:false };
    } else {
      const rawLevel = Number(fullyInterface.getBatteryLevel());
      if (!Number.isFinite(rawLevel)) throw new Error("Ungültiger Akkustand");
      deviceBatteryState = {
        available:true,
        level:Math.round(Math.max(0, Math.min(100, rawLevel))),
        plugged:Boolean(fullyInterface.isPlugged())
      };
    }
  } catch (error) {
    console.warn("Fully battery status unavailable", error);
    deviceBatteryState = { available:false, level:null, plugged:false };
  }
  renderDeviceBattery();
  return deviceBatteryState;
}

function startBatteryUpdates() {
  if (batteryUpdateTimer) clearInterval(batteryUpdateTimer);
  updateDeviceBattery();
  batteryUpdateTimer = setInterval(updateDeviceBattery, 15 * 60 * 1000);
}

async function handleRuntimeActivation() {
  const now = Date.now();
  if (now - lastRuntimeActivationAt < 1500) return false;
  lastRuntimeActivationAt = now;
  await loadThemeSetting();
  updateDeviceBattery();
  return true;
}

function setMode(mode) {
  session.mode = mode;
  document.body.dataset.appMode = mode;
  session.lastActivityMs = Date.now();
  $("#btnLogout").classList.toggle("hidden", !(mode === "user" || mode === "admin"));
  $("#btnAdmin").classList.toggle("hidden", mode !== "idle");
  $("#screenIdle").classList.toggle("hidden", mode !== "idle");
  $("#screenUser").classList.toggle("hidden", mode !== "user");
  $("#screenAdminLogin").classList.toggle("hidden", mode !== "admin_login");
  $("#screenAdmin").classList.toggle("hidden", mode !== "admin");
  renderDeviceBattery();
  updateLogoutHint();
}

function enterIdle() {
  pinBuffer = "";
  adminBuffer = "";
  session.userId = null;
  session.userStartedAt = null;
  userViewState.todayTxnsExpanded = false;
  personalReportCache.clear();
  currentAdminTab = null;
  hideToast();
  closeModal();
  setMode("idle");
  updateIdleClock();
  renderPinDots("#pinDots", pinBuffer.length);
}

function enterUser(userId) {
  session.userId = userId;
  session.userStartedAt = Date.now();
  userViewState.todayTxnsExpanded = false;
  personalReportCache.clear();
  hideToast();
  setMode("user");
  updatePersonalReportButtonVisibility();
  refreshUserView();
}

function enterAdminLogin() {
  // Admin is exclusive: drop any user session
  session.userId = null;
  session.userStartedAt = null;
  hideToast();
  adminBuffer = "";
  setMode("admin_login");
  $("#adminLoginError").classList.add("hidden");
  renderPinDots("#adminDots", adminBuffer.length, 6);
}

function enterAdmin() {
  session.userId = null;
  session.userStartedAt = null;
  hideToast();
  setMode("admin");
  currentAdminTab = null;
  renderAdminTabs();
  showAdminTab("overview");
  runDailyAutomaticSystemCheck().catch(console.error);
}

function touch() {
  session.lastActivityMs = Date.now();
  // The logout countdown is only visible in active user/admin sessions.
  // Avoid unnecessary DOM writes while entering a user or admin PIN.
  if (session.mode === "user" || session.mode === "admin") updateLogoutHint();
}

function getActiveLogoutTimeout() {
  if (session.mode === "user") return TIMEOUTS.userAutoLogoutMs;
  if (session.mode === "admin") return TIMEOUTS.adminAutoLogoutMs;
  return 0;
}

function updateLogoutHint(now = Date.now()) {
  const hint = $("#logoutHint");
  if (!hint) return;

  const timeoutMs = getActiveLogoutTimeout();
  if (timeoutMs <= 0) {
    hint.classList.add("hidden");
    hint.setAttribute("aria-hidden", "true");
    return;
  }

  const remainingMs = Math.max(0, timeoutMs - (now - session.lastActivityMs));
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const progress = Math.max(0, Math.min(100, (remainingMs / timeoutMs) * 100));

  $("#logoutCountdown").textContent = `${remainingSeconds} s`;
  $("#logoutProgressBar").style.width = `${progress}%`;
  hint.classList.toggle("attention", remainingSeconds <= 15 && remainingSeconds > 10);
  hint.classList.toggle("warning", remainingSeconds <= 10 && remainingSeconds > 5);
  hint.classList.toggle("urgent", remainingSeconds <= 5);
  hint.classList.remove("hidden");
  hint.setAttribute("aria-hidden", "false");
}

// ---------- Keypad ----------
function buildKeypad(containerId, onDigit) {
  const el = $(containerId);
  el.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","","0",""];
  keys.forEach((k) => {
    const b = document.createElement("div");
    b.className = "key";
    b.textContent = k;
    if (!k) {
      b.style.opacity = "0";
      b.style.pointerEvents = "none";
    } else {
      attachKeypadPress(b, () => { touch(); onDigit(k); });
    }
    el.appendChild(b);
  });
}

function renderPinDots(containerSel, len, count = 4) {
  const el = $(containerSel);
  if (el.children.length !== count) {
    el.innerHTML = "";
    for (let i=0;i<count;i++){
      const d = document.createElement("div");
      d.className = "dot";
      el.appendChild(d);
    }
  }
  Array.from(el.children).forEach((dot, i) => dot.classList.toggle("filled", i < len));
}

function attachKeypadPress(el, fn) {
  let ignoreSyntheticClickUntil = 0;
  const activate = (event) => {
    event?.preventDefault?.();
    showLoginPressFeedback(el);
    fn();
  };

  // Android/Fully: prefer the native touch event. Some WebView versions expose
  // PointerEvent but occasionally omit a pointerdown during very fast taps.
  if ("ontouchstart" in window) {
    el.addEventListener("touchstart", (event) => {
      ignoreSyntheticClickUntil = Date.now() + 700;
      activate(event);
    }, { passive:false });
    el.addEventListener("click", (event) => {
      if (Date.now() < ignoreSyntheticClickUntil) {
        event.preventDefault();
        return;
      }
      activate(event);
    });
    return;
  }

  if (window.PointerEvent) {
    el.addEventListener("pointerdown", activate);
    return;
  }

  el.addEventListener("click", activate);
}

function showLoginPressFeedback(el) {
  if (!el) return;
  clearTimeout(el._loginPressTimer);
  el.classList.remove("loginPressed");
  void el.offsetWidth;
  el.classList.add("loginPressed");
  el._loginPressTimer = setTimeout(() => el.classList.remove("loginPressed"), 170);
}

function enableLoginButtonFeedback() {
  $$("#screenIdle .btn, #screenAdminLogin .btn").forEach((button) => {
    const press = () => showLoginPressFeedback(button);
    if ("ontouchstart" in window) {
      button.addEventListener("touchstart", press, { passive:true });
    } else if (window.PointerEvent) {
      button.addEventListener("pointerdown", press);
    } else {
      button.addEventListener("mousedown", press);
    }
  });
}

function onPinDigit(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d;
  renderPinDots("#pinDots", pinBuffer.length);
  if (pinBuffer.length === 4) {
    // Auto login after last digit (keep OK button as fallback)
    const code = pinBuffer;
    setTimeout(()=>{
      // Only attempt if still on idle and buffer unchanged
      if (session.mode !== "idle") return;
      if (pinBuffer !== code) return;
      handleCredential({ type:"pin", value: code });
    }, AUTO_LOGIN_DELAY_MS);
  }
}

function onAdminDigit(d) {
  if (adminBuffer.length >= 6) return;
  adminBuffer += d;
  renderPinDots("#adminDots", adminBuffer.length, 6);
}

// ---------- Login provider pipeline ----------
async function handleCredential(credential) {
  // Only accept credentials in idle
  if (session.mode !== "idle") return;

  const user = await resolveUser(credential);
  if (!user) {
    // simple feedback: clear
    pinBuffer = "";
    renderPinDots("#pinDots", 0);
    flashError("Anmeldung fehlgeschlagen - PIN falsch");

    return;
  }

  enterUser(user.id);
}

async function resolveUser(credential) {
  if (!credential) return null;

  // PIN login (unchanged)
  if (credential.type === "pin") {
    const id = credential.value;
    if (!/^\d{4}$/.test(id)) return null;
    const user = await DB.get("users", id);
    if (!user || !user.active) return null;
    return user;
  }

  return null;
}
function flashError(msg) {
  showToast(msg, "error");
}

// ---------- User actions ----------
async function bookProduct(productId) {
  if (session.mode !== "user") return;
  touch();
  const txnId = safeUUID();
  const userId = session.userId;
  const result = await DB.bookProductAtomic({ id:txnId, userId, productId, ts:Date.now() });
  if (session.mode !== "user" || session.userId !== userId) return;
  if (!result.ok) {
    if (result.reason === "out") showToast(`${result.product?.name || "Produkt"}: Ausverkauft`, "warning");
    return;
  }

  const { txn, product } = result;
  invalidatePersonalReportCache(txn.ts);
  userViewState.productsById.set(product.id, product);
  userViewState.balanceCents += txn.priceCents;
  const displaySaldo = renderUserBalance(-userViewState.balanceCents);
  updateUserProductTile(product);
  prependSessionTxn(txn, product);
  if (userViewState.todayTxnsExpanded) await renderTodayUserTxnsInline();

  showBookingToast(product.name, product.priceCents, displaySaldo);
}

function isTimestampToday(timestamp, now = new Date()) {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) &&
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate();
}

async function voidTodayUserTxn(txnId) {
  if (session.mode !== "user") return;

  touch();
  const userId = session.userId;
  const txn = await DB.get("txns", txnId);

  if (session.mode !== "user" || session.userId !== userId) return;
  if (!txn || txn.userId !== userId || txn.voidedAt || !isTimestampToday(txn.ts)) {
    await refreshUserView();
    showToast("Buchung kann nicht mehr storniert werden", "warning");
    return;
  }

  const product = await DB.get("products", txn.productId);
  const productName = product ? product.name : txn.productId;
  const when = new Date(txn.ts).toLocaleString("de-DE", { hour:"2-digit", minute:"2-digit" });
  const ok = await confirmModal(
    "Buchung stornieren",
    `${fmtEUR(txn.priceCents)} für "${productName}" von ${when} Uhr wirklich stornieren?`,
    "Stornieren"
  );
  if (!ok) return;

  touch();
  const freshTxn = await DB.get("txns", txnId);
  if (session.mode !== "user" || session.userId !== userId) return;
  if (!freshTxn || freshTxn.userId !== userId || freshTxn.voidedAt || !isTimestampToday(freshTxn.ts)) {
    await refreshUserView();
    showToast("Buchung kann nicht mehr storniert werden", "warning");
    return;
  }

  freshTxn.voidedAt = Date.now();
  await DB.put("txns", freshTxn);
  invalidatePersonalReportCache(freshTxn.ts);

  const freshProduct = await DB.get("products", freshTxn.productId);
  if (freshProduct && freshProduct.trackStock) {
    freshProduct.stock = (freshProduct.stock || 0) + 1;
    await DB.put("products", freshProduct);
  }

  const displaySaldo = await refreshUserView();
  showVoidToast(productName, freshTxn.priceCents, displaySaldo);
}

// ---------- Rendering ----------
async function getUserBalance(userId) {
  const txns = (await DB.getAllByIndex("txns", "userId", userId)).filter(t => !t.voidedAt);
  const payments = (await DB.getAllByIndex("payments", "userId", userId)).filter(payment => !payment.voidedAt);

  const sumTxns = txns.reduce((s,t)=>s+t.priceCents,0);
  const sumPay = payments.reduce((s,p)=>s+p.amountCents,0);
  return sumTxns - sumPay;
}

function tileThemeClassForProduct(p) {
  // maps to CSS classes: tile--coffee / tile--water / tile--cola / tile--other / tile--snack
  return `tile--${p.color || "other"}`;
}

function stockPill(p) {
  if (!p.trackStock) return `<span class="pill">—</span>`;
  if (p.stock <= 0) return `<span class="pill out">Ausverkauft</span>`;
  if (p.lowStockThreshold && p.stock <= p.lowStockThreshold) return `<span class="pill low">Wenig: ${p.stock}</span>`;
  return `<span class="pill">${p.stock} Stk</span>`;
}

function productCategory(p) {
  if (p?.category === "drink" || p?.category === "snack") return p.category;
  return String(p?.id || "").startsWith("snack_") ? "snack" : "drink";
}

function createUserTxnItem(txn, product, onVoid) {
  const item = document.createElement("div");
  item.className = "item";

  const left = document.createElement("div");
  left.className = "itemLeft";

  const title = document.createElement("div");
  title.className = "itemTitle";
  title.appendChild(document.createTextNode(product ? product.name : txn.productId));
  if (txn.voidedAt) {
    title.appendChild(document.createTextNode(" "));
    const badge = document.createElement("span");
    badge.className = "pill out";
    badge.textContent = "storniert";
    title.appendChild(badge);
  }

  const meta = document.createElement("div");
  meta.className = "itemMeta";
  meta.textContent = new Date(txn.ts).toLocaleString("de-DE", { hour:"2-digit", minute:"2-digit" });

  left.appendChild(title);
  left.appendChild(meta);

  const right = document.createElement("div");
  right.className = "itemRight";

  const price = document.createElement("div");
  price.className = "qty";
  price.textContent = fmtEUR(txn.priceCents);
  right.appendChild(price);

  if (!txn.voidedAt && onVoid) {
    const voidButton = document.createElement("button");
    voidButton.type = "button";
    voidButton.className = "btn small danger userTxnVoidButton";
    voidButton.textContent = "Storno";
    voidButton.addEventListener("click", () => onVoid(txn.id));
    right.appendChild(voidButton);
  }

  item.appendChild(left);
  item.appendChild(right);
  return item;
}

function updateTodayTxnsDisclosure(expanded) {
  const button = $("#btnShowTodayTxns");
  const section = $("#todayTxnsSection");
  if (!button || !section) return;
  button.textContent = expanded ? "Buchungen des Tages ausblenden" : "Buchungen des Tages anzeigen";
  button.setAttribute("aria-expanded", String(expanded));
  section.classList.toggle("hidden", !expanded);
}

async function renderTodayUserTxnsInline() {
  if (session.mode !== "user" || !userViewState.todayTxnsExpanded) {
    updateTodayTxnsDisclosure(false);
    return;
  }

  const userId = session.userId;
  const [txnsAll, products] = await Promise.all([
    DB.getAllByIndex("txns", "userId", userId),
    DB.getAll("products")
  ]);
  if (session.mode !== "user" || session.userId !== userId || !userViewState.todayTxnsExpanded) return;

  const list = $("#todayUserTxnsList");
  if (!list) return;
  const productsById = new Map(products.map(product => [product.id, product]));
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const sessionStartedAt = Number.isFinite(session.userStartedAt) ? session.userStartedAt : Date.now();
  const sessionTxnIds = new Set(
    txnsAll
      .filter(txn => txn.ts >= sessionStartedAt)
      .map(txn => txn.id)
  );
  const txns = txnsAll
    .filter(txn => txn.ts >= startOfToday && txn.ts < startOfTomorrow)
    .filter(txn => !sessionTxnIds.has(txn.id))
    .sort((a, b) => b.ts - a.ts);

  list.innerHTML = "";
  updateTodayTxnsDisclosure(true);
  if (!txns.length) {
    const empty = document.createElement("div");
    empty.className = "muted dayTxnsEmpty";
    empty.textContent = "Keine weiteren Buchungen heute.";
    list.appendChild(empty);
    return;
  }

  txns.forEach(txn => {
    list.appendChild(createUserTxnItem(txn, productsById.get(txn.productId), voidTodayUserTxn));
  });
}

async function toggleTodayUserTxns() {
  if (session.mode !== "user") return;
  touch();
  userViewState.todayTxnsExpanded = !userViewState.todayTxnsExpanded;
  if (!userViewState.todayTxnsExpanded) {
    updateTodayTxnsDisclosure(false);
    return;
  }
  await renderTodayUserTxnsInline();
}

function formatSaldo(displaySaldo) {
  const absolute = Math.abs(displaySaldo);
  if (displaySaldo > 0) return `+${fmtEUR(displaySaldo)}`;
  if (displaySaldo < 0) return `-${fmtEUR(absolute)}`;
  return fmtEUR(0);
}

function renderUserBalance(displaySaldo) {
  const balEl = $("#userBalance");
  balEl.textContent = formatSaldo(displaySaldo);
  balEl.classList.toggle("pos", displaySaldo > 0);
  balEl.classList.toggle("neg", displaySaldo < 0);
  return displaySaldo;
}

function personalReportCacheKeys(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return [];
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return [`month:${year}-${month}`, `year:${year}`];
}

function invalidatePersonalReportCache(timestamp) {
  personalReportCacheKeys(timestamp).forEach(key => personalReportCache.delete(key));
}

function personalReportPeriod(mode, date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (mode === "year") {
    return {
      key:`year:${year}`,
      start:new Date(year, 0, 1).getTime(),
      end:new Date(year + 1, 0, 1).getTime(),
      label:String(year)
    };
  }
  return {
    key:`month:${year}-${String(month + 1).padStart(2, "0")}`,
    start:new Date(year, month, 1).getTime(),
    end:new Date(year, month + 1, 1).getTime(),
    label:new Date(year, month, 1).toLocaleDateString("de-DE", { month:"long", year:"numeric" })
  };
}

function personalReportIsCurrentPeriod() {
  const now = new Date();
  const selected = personalReportState.date;
  if (personalReportState.mode === "year") return selected.getFullYear() >= now.getFullYear();
  return selected.getFullYear() > now.getFullYear() ||
    (selected.getFullYear() === now.getFullYear() && selected.getMonth() >= now.getMonth());
}

function shiftPersonalReportPeriod(direction) {
  const selected = personalReportState.date;
  personalReportState.date = personalReportState.mode === "year"
    ? new Date(selected.getFullYear() + direction, 0, 1)
    : new Date(selected.getFullYear(), selected.getMonth() + direction, 1);
  if (personalReportState.mode === "year") personalReportState.yearDate = new Date(personalReportState.date);
  else personalReportState.monthDate = new Date(personalReportState.date);
}

async function loadPersonalReportPeriod(userId, period) {
  if (personalReportCache.has(period.key)) return personalReportCache.get(period.key);
  const [allTxns, allPayments] = await Promise.all([
    DB.getAllByIndexRange("txns", "ts", period.start, period.end - 1),
    DB.getAllByIndexRange("payments", "ts", period.start, period.end - 1)
  ]);
  const report = {
    txns:allTxns.filter(txn => txn.userId === userId && !txn.voidedAt),
    payments:allPayments.filter(payment => payment.userId === userId && !payment.voidedAt)
  };
  personalReportCache.set(period.key, report);
  return report;
}

function personalReportSignedAmount(cents) {
  const className = cents > 0 ? "pos" : cents < 0 ? "neg" : "";
  return `<span class="personalReportSigned ${className}">${escapeHtml(formatSaldo(cents))}</span>`;
}

async function renderPersonalReport() {
  if (session.mode !== "user") return;
  const userId = session.userId;
  const period = personalReportPeriod(personalReportState.mode, personalReportState.date);
  const results = $("#personalReportResults");
  if (!results) return;
  $("#personalReportPeriodLabel").textContent = period.label;
  $("#personalReportPrev").textContent = personalReportState.mode === "year" ? "← Vorheriges Jahr" : "← Vorheriger Monat";
  $("#personalReportNext").textContent = personalReportState.mode === "year" ? "Nächstes Jahr →" : "Nächster Monat →";
  $("#personalReportNext").disabled = personalReportIsCurrentPeriod();
  $$("#personalReportMode .personalReportModeButton").forEach(button => {
    const active = button.dataset.mode === personalReportState.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  results.innerHTML = `<div class="personalReportLoading">Auswertung wird geladen …</div>`;

  const report = await loadPersonalReportPeriod(userId, period);
  const currentPeriod = personalReportPeriod(personalReportState.mode, personalReportState.date);
  if (session.mode !== "user" || session.userId !== userId || currentPeriod.key !== period.key || !$("#personalReportResults")) return;

  const productRows = new Map();
  for (const txn of report.txns) {
    const product = userViewState.productsById.get(txn.productId);
    const name = product?.name || txn.productId || "Unbekanntes Produkt";
    const entry = productRows.get(txn.productId) || { name, count:0, cents:0 };
    entry.count += 1;
    entry.cents += Number(txn.priceCents) || 0;
    productRows.set(txn.productId, entry);
  }
  const products = [...productRows.values()].sort((a, b) => b.count - a.count || b.cents - a.cents || a.name.localeCompare(b.name, "de-DE"));
  const bookingCents = report.txns.reduce((sum, txn) => sum + (Number(txn.priceCents) || 0), 0);
  const paymentCents = report.payments.reduce((sum, payment) => sum + (Number(payment.amountCents) || 0), 0);
  const periodBalance = paymentCents - bookingCents;
  const totalBalance = -userViewState.balanceCents;
  const topProduct = products[0] || null;

  const productBody = products.length
    ? products.map((product, index) => `<tr><td>${escapeHtml(product.name)}${index === 0 ? '<span class="personalReportTop">Meistgekauft</span>' : ""}</td><td>${product.count}</td><td>${fmtEUR(product.cents)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="personalReportEmpty">Keine Buchungen in diesem Zeitraum.</td></tr>`;
  const paymentBody = report.payments.length
    ? [...report.payments].sort((a, b) => b.ts - a.ts).map(payment => {
        const when = new Date(payment.ts).toLocaleDateString("de-DE", { day:"2-digit", month:"2-digit", year:"2-digit" });
        return `<tr><td>${when}</td><td>${escapeHtml(payment.note || "—")}</td><td>${fmtEUR(Number(payment.amountCents) || 0)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="3" class="personalReportEmpty">Keine Zahlungen in diesem Zeitraum.</td></tr>`;

  results.innerHTML = `
    <div class="personalReportKpis">
      <div class="personalReportKpi"><span>Buchungen</span><strong>${report.txns.length}</strong></div>
      <div class="personalReportKpi"><span>Gebucht</span><strong>${fmtEUR(bookingCents)}</strong></div>
      <div class="personalReportKpi"><span>Gezahlt</span><strong>${fmtEUR(paymentCents)}</strong></div>
      <div class="personalReportKpi"><span>Saldo im Zeitraum</span><strong>${personalReportSignedAmount(periodBalance)}</strong></div>
      <div class="personalReportKpi personalReportKpiWide"><span>Aktueller Gesamtsaldo</span><strong>${personalReportSignedAmount(totalBalance)}</strong></div>
    </div>
    <div class="personalReportHighlight">
      <span>Meistgekauft</span>
      <strong>${topProduct ? `${escapeHtml(topProduct.name)} · ${topProduct.count}×` : "Noch keine Buchung"}</strong>
    </div>
    <section class="personalReportSection">
      <h3>Produkte</h3>
      <div class="personalReportTableWrap"><table><thead><tr><th>Produkt</th><th>Anzahl</th><th>Summe</th></tr></thead><tbody>${productBody}</tbody></table></div>
    </section>
    <section class="personalReportSection">
      <h3>Zahlungen</h3>
      <div class="personalReportTableWrap"><table><thead><tr><th>Datum</th><th>Notiz</th><th>Betrag</th></tr></thead><tbody>${paymentBody}</tbody></table></div>
    </section>`;
}

function availablePersonalReportModes() {
  const modes = [];
  if (featureIsUnlocked("monthly")) modes.push("month");
  if (featureIsUnlocked("yearly")) modes.push("year");
  return modes;
}

function updatePersonalReportButtonVisibility() {
  const button = $("#btnPersonalReport");
  if (!button) return;
  button.classList.toggle("hidden", availablePersonalReportModes().length === 0);
}

function openPersonalReport() {
  if (session.mode !== "user") return;
  const availableModes = availablePersonalReportModes();
  if (!availableModes.length) return;
  touch();
  const now = new Date();
  personalReportState.mode = availableModes[0];
  personalReportState.monthDate = new Date(now.getFullYear(), now.getMonth(), 1);
  personalReportState.yearDate = new Date(now.getFullYear(), 0, 1);
  personalReportState.date = new Date(personalReportState.mode === "year"
    ? personalReportState.yearDate
    : personalReportState.monthDate);
  const modeButtons = availableModes.map(mode => {
    const active = mode === personalReportState.mode;
    return `<button class="btn personalReportModeButton${active ? " active" : ""}" type="button" data-mode="${mode}" aria-pressed="${active}">${mode === "year" ? "Jahr" : "Monat"}</button>`;
  }).join("");
  openModal({
    title:"Meine Auswertung",
    modalClass:"personalReportModal",
    bodyHtml:`
      <div id="personalReportMode" class="personalReportMode" role="group" aria-label="Auswertungszeitraum">
        ${modeButtons}
      </div>
      <div class="personalReportPeriodNav">
        <button id="personalReportPrev" class="btn ghost" type="button">← Vorheriger Monat</button>
        <strong id="personalReportPeriodLabel">—</strong>
        <button id="personalReportNext" class="btn ghost" type="button">Nächster Monat →</button>
      </div>
      <div id="personalReportResults" class="personalReportResults"></div>`,
    actions:[{ label:"Schließen", primary:true, onClick:async () => closeModal() }]
  });
  $$("#personalReportMode .personalReportModeButton").forEach(button => {
    button.addEventListener("click", async () => {
      touch();
      const nextMode = button.dataset.mode === "year" ? "year" : "month";
      if (nextMode === personalReportState.mode) return;
      if (personalReportState.mode === "year") personalReportState.yearDate = new Date(personalReportState.date);
      else personalReportState.monthDate = new Date(personalReportState.date);
      personalReportState.mode = nextMode;
      personalReportState.date = new Date(nextMode === "year"
        ? personalReportState.yearDate
        : personalReportState.monthDate);
      await renderPersonalReport();
    });
  });
  $("#personalReportPrev").addEventListener("click", async () => { touch(); shiftPersonalReportPeriod(-1); await renderPersonalReport(); });
  $("#personalReportNext").addEventListener("click", async () => {
    touch();
    if (personalReportIsCurrentPeriod()) return;
    shiftPersonalReportPeriod(1);
    await renderPersonalReport();
  });
  renderPersonalReport().catch(error => {
    console.error(error);
    const results = $("#personalReportResults");
    if (results) results.innerHTML = `<div class="personalReportError">Auswertung konnte nicht geladen werden.</div>`;
  });
}

function updateUserProductTile(product) {
  const tile = document.querySelector(`.tile[data-product-id="${product.id}"]`);
  if (!tile) return;
  const pill = tile.querySelector(".pill");
  if (pill) pill.outerHTML = stockPill(product);
  const disabled = product.trackStock && product.stock <= 0;
  tile.style.opacity = disabled ? "0.55" : "";
  tile.style.pointerEvents = disabled ? "none" : "";
}

function prependSessionTxn(txn, product) {
  const txnsEl = $("#userTxns");
  const section = $("#sessionTxnsSection");
  if (!txnsEl || !section) return;
  section.classList.remove("hidden");
  txnsEl.insertBefore(createUserTxnItem(txn, product, voidTodayUserTxn), txnsEl.firstChild);
}


async function refreshUserView() {
  const user = await DB.get("users", session.userId);
  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 8 ? "Guten Morgen" : "Hallo";
  $("#userName").textContent = user ? `${greeting} ${user.name}!` : `${greeting}!`;

  const balance = await getUserBalance(session.userId);
  userViewState.balanceCents = balance;
  const displaySaldo = renderUserBalance(-balance);

  const allProducts = await DB.getAll("products");
  const products = allProducts.filter(p=>p.active).sort((a,b)=>a.sortOrder-b.sortOrder);
  const productsById = new Map(allProducts.map(p=>[p.id, p]));
  userViewState.productsById = productsById;

  const drinks = products.filter(p => productCategory(p) === "drink");
  const snacks = products.filter(p => productCategory(p) === "snack");

  const gridDrinks = $("#gridDrinks");
  gridDrinks.innerHTML = "";
  drinks.forEach(p => {
    const t = document.createElement("div");
    t.className = "tile " + tileThemeClassForProduct(p);
    t.dataset.productId = p.id;
    t.innerHTML = `
      <div class="tileTitle">${p.name}</div>
      <div class="tileSub">
        <span>${fmtEUR(p.priceCents)}</span>
        ${stockPill(p)}
      </div>`;
    const disabled = p.trackStock && p.stock <= 0;
    if (disabled) {
      t.style.opacity = "0.55";
    } else {
      attachTap(t, () => bookProduct(p.id));
    }
    gridDrinks.appendChild(t);
  });

  const gridSnacks = $("#gridSnacks");
  gridSnacks.innerHTML = "";
  snacks.forEach(p => {
    const t = document.createElement("div");
    t.className = "tile " + tileThemeClassForProduct(p);
    t.dataset.productId = p.id;
    t.innerHTML = `
      <div class="tileTitle">${p.name}</div>
      <div class="tileSub">
        <span>${fmtEUR(p.priceCents)}</span>
        ${stockPill(p)}
      </div>`;
    const disabled = p.trackStock && p.stock <= 0;
    if (disabled) {
      t.style.opacity = "0.55";
    } else {
      attachTap(t, () => bookProduct(p.id));
    }
    gridSnacks.appendChild(t);
  });

  const txnsEl = $("#userTxns");
  const sessionTxnsSection = $("#sessionTxnsSection");
  const txnsAll = await DB.getAllByIndex("txns", "userId", session.userId);
  const sessionStartedAt = Number.isFinite(session.userStartedAt) ? session.userStartedAt : Date.now();
  const txns = txnsAll.filter(t => t.ts >= sessionStartedAt);

  if (!txns.length) {
    txnsEl.innerHTML = "";
    sessionTxnsSection.classList.add("hidden");
  } else {
    sessionTxnsSection.classList.remove("hidden");
    txnsEl.innerHTML = "";
    const items = txns.sort((a,b)=>b.ts-a.ts);
    for (const t of items) {
      const p = productsById.get(t.productId);
      txnsEl.appendChild(createUserTxnItem(t, p, voidTodayUserTxn));
    }
  }

  if (userViewState.todayTxnsExpanded) await renderTodayUserTxnsInline();
  else updateTodayTxnsDisclosure(false);

  return displaySaldo;
}

// ---------- Admin ----------
const adminTabDefs = [
  { id:"overview", label:"Übersicht", group:"Verwaltung" },
  { id:"products", label:"Produkte", group:"Verwaltung" },
  { id:"users", label:"Nutzer", group:"Verwaltung" },
  { id:"payments", label:"Zahlungen", group:"Verwaltung" },
  { id:"settings", label:"Einstellungen", group:"Verwaltung" },
  { id:"audit", label:"Buchungsverlauf", group:"Auswertung" },
];

function visibleAdminTabDefs() {
  const tabs = [...adminTabDefs];
  const auditIndex = tabs.findIndex(tab => tab.id === "audit");
  const reports = [];
  if (featureIsUnlocked("monthly")) reports.push({ id:"monthly", label:"Monatsauswertung", group:"Auswertung" });
  if (featureIsUnlocked("yearly")) reports.push({ id:"yearly", label:"Jahresauswertung", group:"Auswertung" });
  tabs.splice(auditIndex, 0, ...reports);
  return tabs;
}

function renderAdminTabs() {
  const tabs = $("#adminTabs");
  tabs.innerHTML = "";
  let lastGroup = null;
  visibleAdminTabDefs().forEach(t => {
    if (t.group !== lastGroup) {
      const label = document.createElement("div");
      label.className = "adminTabGroupLabel";
      label.textContent = t.group;
      tabs.appendChild(label);
      lastGroup = t.group;
    }
    const b = document.createElement("div");
    b.className = "tab";
    b.textContent = t.label;
    b.dataset.tab = t.id;
    b.addEventListener("click", () => { touch(); showAdminTab(t.id); });
    tabs.appendChild(b);
  });
}

function setAdminTabDateDefaults(tabId) {
  const today = localDateInputValue();
  if (tabId === "audit") {
    $("#auditDateFrom").value = today;
    $("#auditDateTo").value = today;
  }
}

function showAdminTab(tabId, refresh = true) {
  const enteringTab = currentAdminTab !== tabId;
  currentAdminTab = tabId;
  if (enteringTab) setAdminTabDateDefaults(tabId);
  $$("#adminTabs .tab").forEach(el => el.classList.toggle("active", el.dataset.tab === tabId));
  $("#adminOverview").classList.toggle("hidden", tabId !== "overview");
  $("#adminProducts").classList.toggle("hidden", tabId !== "products");
  $("#adminUsers").classList.toggle("hidden", tabId !== "users");
  $("#adminPayments").classList.toggle("hidden", tabId !== "payments");
  $("#adminMonthly")?.classList.toggle("hidden", tabId !== "monthly");
  $("#adminYearly")?.classList.toggle("hidden", tabId !== "yearly");
  $("#adminAudit").classList.toggle("hidden", tabId !== "audit");
  $("#adminSettings").classList.toggle("hidden", tabId !== "settings");

  if (!refresh) return;

  // refresh relevant pane quickly
  if (tabId === "products") refreshAdminProducts();
  if (tabId === "users") refreshAdminUsers();
  if (tabId === "payments") refreshAdminPayments();
  if (tabId === "monthly") refreshAdminMonthly();
  if (tabId === "yearly") refreshAdminYearly();
  if (tabId === "overview") refreshAdminOverview();
  if (tabId === "audit") refreshAdminAudit();
  if (tabId === "settings") refreshAdminSettings();
}

function renderUnlockedFeatureList() {
  const list = $("#unlockedFeatureList");
  if (!list) return;
  const features = [...new Map(Object.values(UNLOCK_CODES).map(feature => [feature.id, feature])).values()]
    .filter(feature => featureIsUnlocked(feature.id));
  if (!features.length) {
    list.innerHTML = '<div class="muted">Noch keine Zusatzinhalte freigeschaltet.</div>';
    return;
  }
  list.innerHTML = features
    .map(feature => `<div class="item"><div class="itemLeft"><div class="itemTitle">${escapeHtml(feature.label)}</div><div class="itemMeta">freigeschaltet</div></div><span class="pill">aktiv</span></div>`)
    .join("");
}

function refreshUnlockPage() {
  const input = $("#unlockCode");
  const message = $("#unlockMessage");
  if (input) input.value = "";
  if (message) message.textContent = "";
  renderUnlockedFeatureList();
}

async function submitUnlockCode() {
  const input = $("#unlockCode");
  const message = $("#unlockMessage");
  const code = String(input?.value || "").trim().toUpperCase();
  if (!/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{10}$/.test(code)) {
    if (message) message.textContent = "Der Code muss aus genau 10 Buchstaben und Zahlen bestehen.";
    showToast("Ungültiges Codeformat", "warning");
    return;
  }
  const feature = UNLOCK_CODES[code];
  if (!feature) {
    if (message) message.textContent = "Dieser Freischaltcode ist nicht gültig.";
    showToast("Freischaltcode nicht erkannt", "error");
    return;
  }
  if (featureIsUnlocked(feature.id)) {
    if (message) message.textContent = `${feature.label} ist bereits freigeschaltet.`;
    showToast("Zusatzinhalt bereits freigeschaltet", "info");
    return;
  }
  await DB.setSetting(`featureUnlocked_${feature.id}`, true);
  unlockedFeatures.add(feature.id);
  renderAdminTabs();
  showAdminTab("settings", false);
  await refreshAdminSettings();
  if (input) input.value = "";
  if (message) message.textContent = `${feature.label} wurde freigeschaltet.`;
  showToast(`${feature.label} freigeschaltet`, "success");
}

function qtyClass(p) {
  if (!p.trackStock) return "";
  if (p.stock <= 0) return "qty zero";
  if (p.lowStockThreshold && p.stock <= p.lowStockThreshold) return "qty low";
  return "qty";
}

function attachLongPress(el, onLong) {
  let timer = null;
  const start = () => {
    timer = setTimeout(() => { timer = null; onLong(); }, 600);
  };
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };

  el.addEventListener("touchstart", (e)=>{ start(); }, {passive:true});
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", cancel);
  el.addEventListener("mousedown", (e)=>{ start(); });
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
}

let copyrightInfoCloseTimer = null;
let soundEnabled = true;

function syncModalOverlayToViewport() {
  const overlay = $("#modalOverlay");
  if (!overlay) return;
  const doc = document.documentElement;
  const body = document.body;
  const viewportTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
  const viewportHeight = window.innerHeight || doc.clientHeight || 600;
  overlay.style.top = `${viewportTop}px`;
  overlay.style.height = `${viewportHeight}px`;
  const modal = $("#modalDialog");
  if (modal) modal.style.maxHeight = `${Math.max(180, viewportHeight - 32)}px`;
}

function syncVisibleModalOverlay() {
  const overlay = $("#modalOverlay");
  if (overlay && !overlay.classList.contains("hidden")) syncModalOverlayToViewport();
}

function openModal({ title, bodyHtml, actions, modalClass = "" }) {
  if (copyrightInfoCloseTimer) {
    clearTimeout(copyrightInfoCloseTimer);
    copyrightInfoCloseTimer = null;
  }
  const modal = $("#modalDialog");
  modal.className = "modal" + (modalClass ? ` ${modalClass}` : "");
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const act = $("#modalActions");
  act.innerHTML = "";
  actions.forEach(a => {
    const b = document.createElement("button");
    b.className = "btn " + (a.primary ? "primary" : "ghost");
    if (a.danger) b.classList.add("danger");
    b.textContent = a.label;
    b.addEventListener("click", async () => { touch(); await a.onClick(); });
    act.appendChild(b);
  });
  syncModalOverlayToViewport();
  $("#modalOverlay").classList.remove("hidden");
  window.requestAnimationFrame(syncModalOverlayToViewport);
}
function closeModal() {
  if (copyrightInfoCloseTimer) {
    clearTimeout(copyrightInfoCloseTimer);
    copyrightInfoCloseTimer = null;
  }
  $("#modalOverlay").classList.add("hidden");
}

window.addEventListener("scroll", syncVisibleModalOverlay, false);
window.addEventListener("resize", syncVisibleModalOverlay, false);

function showCopyrightInfo() {
  openModal({
    title: "Info & GPLv3",
    modalClass: "copyrightInfoModal",
    bodyHtml: `
      <div class="legalDocument">
        <section class="legalSection legalCopyrightSection">
          <h3>KassenWart · ${APP_BUILD}</h3>
          <p><strong>Entwickler</strong><br>Erstellt mit &#x2764;&#xFE0F; von Kevin Schmitz - voidnexus.de</p>
          <p>info@voidnexus.de</p>
          <h3>GNU General Public License Version 3</h3>
          <p>Diese Software ist freie Software. Sie darf unter den Bedingungen der GNU General Public License Version 3 weitergegeben und verändert werden.</p>
          <p>Sie wird ohne Gewährleistung bereitgestellt. Wer eine veränderte oder unveränderte Version weitergibt, muss dabei die Bedingungen der GPLv3 einhalten und den zugehörigen Quelltext verfügbar machen. Der vollständige Lizenztext befindet sich in der Datei <strong>LICENSE</strong>.</p>
        </section>

        <div class="legalVersion">KassenWart · ${APP_BUILD}</div>
      </div>
    `,
    actions: [{
      label:"Schließen",
      primary:true,
      onClick:closeModal
    }]
  });
}

// --- helper: hard delete from IndexedDB store (minimal, no DB-wrapper dependency)
async function deleteFromStore(storeName, key) {
  // Prefer DB wrapper if it exists
  if (typeof DB?.delete === "function") return DB.delete(storeName, key);
  if (typeof DB?.del === "function") return DB.del(storeName, key);
  if (typeof DB?.remove === "function") return DB.remove(storeName, key);

  // Fallback: direct IndexedDB transaction via openDb()
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("delete tx failed"));
      tx.onabort = () => reject(tx.error || new Error("delete tx aborted"));
      tx.objectStore(storeName).delete(key);
    } catch (e) {
      reject(e);
    }
  });
}

async function refreshAdminProducts() {
  const list = $("#productList");
  const products = (await DB.getAll("products")).sort((a,b)=>{
    const sa = (a.sortOrder ?? 999999);
    const sb = (b.sortOrder ?? 999999);
    if (sa !== sb) return sa - sb;
    return String(a.name||"").localeCompare(String(b.name||""), "de-DE");
  });
  list.innerHTML = "";
  const drinks = products.filter(p => productCategory(p) === "drink");
  const snacks = products.filter(p => productCategory(p) === "snack");
  const displayProducts = [...drinks, ...snacks];
  const lowCount = products.filter(p => p.active && p.trackStock && p.stock <= (p.lowStockThreshold || 0)).length;
  $("#productSummary").textContent = `${products.filter(p=>p.active).length} aktiv · ${products.filter(p=>!p.active).length} inaktiv · ${lowCount} niedriger Bestand`;

  // --- Add Product (minimal UI injected, no HTML refactor) ---
  const host = list.parentElement || $("#adminProducts") || list;

  // only create once
  if (!$("#addProductBox")) {
    const box = document.createElement("div");
    box.id = "addProductBox";
    box.className = "item productCreateBox";
    box.innerHTML = `
      <div class="itemTitle">Neues Produkt</div>
      <div class="itemMeta">Kategorie, Darstellung und Bestand können direkt festgelegt werden.</div>
      <div class="productFormGrid">
        <div class="formrow">
          <label for="newProdName">Produktname</label>
          <input id="newProdName" placeholder="z. B. Apfelschorle">
        </div>
        <div class="formrow">
          <label for="newProdPrice">Preis in Euro</label>
          <input id="newProdPrice" inputmode="decimal" placeholder="z. B. 1,20">
        </div>
        <div class="formrow">
          <label for="newProdCategory">Kategorie im Buchungsmenü</label>
          <select id="newProdCategory">
            <option value="drink">Getränk</option>
            <option value="snack">Snack</option>
          </select>
        </div>
        <div class="formrow">
          <label for="newProdColor">Farbe der Produktkachel</label>
          <select id="newProdColor">
            <option value="other">Grau – Neutral</option>
            <option value="water">Blau – Wasser</option>
            <option value="cola">Rot – Cola</option>
            <option value="coffee">Braun – Kaffee</option>
            <option value="snack">Orange – Snack</option>
          </select>
        </div>
        <label class="checkOption" for="newProdActive">
          <input id="newProdActive" type="checkbox">
          <span><strong>Produkt aktiv</strong><small>Im Buchungsmenü anzeigen</small></span>
        </label>
        <label class="checkOption" for="newProdTrack">
          <input id="newProdTrack" type="checkbox">
          <span><strong>Bestand verwalten</strong><small>Buchungen automatisch vom Bestand abziehen</small></span>
        </label>
      </div>
      <div class="productFormActions">
        <button class="btn primary" id="btnCreateProduct">Produkt anlegen</button>
      </div>
    `;

    // insert box before list
    host.insertBefore(box, list);

    $("#btnCreateProduct").addEventListener("click", async () => {
      touch();
      const name = $("#newProdName").value.trim();
      if (!name) { showToast("Bitte einen Produktnamen eingeben.", "warning"); return; }

      const rawPrice = $("#newProdPrice").value.trim();
      const num = parseFloat(rawPrice.replace('.',',').replace(',','.'));
      if (!Number.isFinite(num) || num < 0) { showToast("Bitte einen gültigen Preis eingeben.", "warning"); return; }
      const priceCents = Math.round(num * 100);

      const active = $("#newProdActive").checked;
      const trackStock = $("#newProdTrack").checked;
      const stock = 0;

      const color = $("#newProdColor").value || "other";
      const category = $("#newProdCategory").value === "snack" ? "snack" : "drink";
      const id = `product_${safeUUID()}`;

      // sortOrder: append to end
      const existing = await DB.getAll("products");
      const maxSort = existing.reduce((m,p)=>Math.max(m, (p.sortOrder ?? 0)), 0);
      const sortOrder = maxSort + 1;

      const product = {
        id,
        name,
        priceCents,
        trackStock,
        stock,
        lowStockThreshold: trackStock ? 0 : null,
        active,
        sortOrder,
        color,
        category
      };

      try {
        await DB.put("products", product);
        $("#newProdName").value = "";
        $("#newProdPrice").value = "";
        $("#newProdActive").checked = false;
        $("#newProdTrack").checked = false;
        $("#newProdCategory").value = "drink";
        $("#newProdColor").value = "other";
        await refreshAdminProducts();
        showToast(`${name} wurde als ${category === "drink" ? "Getränk" : "Snack"} angelegt${active ? "" : " (inaktiv)"}.`, "success");
      } catch (e) {
        console.error("Create product failed", e);
        showToast("Produkt konnte nicht angelegt werden: " + (e?.message || String(e)), "error");
      }
    });
  }

  let currentProductGroup = "";
  for (const p of displayProducts) {
    const productGroup = productCategory(p) === "snack" ? "Snacks" : "Getränke";
    if (productGroup !== currentProductGroup) {
      const divider = document.createElement("div");
      divider.className = "adminProductDivider";
      divider.innerHTML = `<span></span><strong>${productGroup}</strong><span></span>`;
      list.appendChild(divider);
      currentProductGroup = productGroup;
    }
    const row = document.createElement("div");
    row.className = "item";
    const price = fmtEUR(p.priceCents);
    row.innerHTML = `
      <div class="itemLeft">
        <div class="itemTitle">${p.name} ${!p.active ? '<span class="pill out">inaktiv</span>' : ''}</div>
        <div class="itemMeta">${price} • ${p.trackStock ? 'Bestand aktiv' : 'kein Bestand'}</div>
      </div>
      <div class="itemRight">
        <div class="iconbtn" data-act="up">↑</div>
        <div class="iconbtn" data-act="down">↓</div>
        ${p.trackStock ? '<div class="iconbtn" data-act="minus">–</div>' : ''}
        <div class="${qtyClass(p)}" title="Bestand">${p.trackStock ? p.stock : '—'}</div>
        ${p.trackStock ? '<div class="iconbtn" data-act="plus">+</div>' : ''}
        <div class="iconbtn" data-act="edit">⚙</div>
      </div>
    `;

    // --- Sort controls: swap sortOrder with neighbor (minimal & stable)
    const upBtn = row.querySelector('[data-act="up"]');
    const downBtn = row.querySelector('[data-act="down"]');

    // disable at edges
    const groupItems = productGroup === "Snacks" ? snacks : drinks;
    if (upBtn) upBtn.style.opacity = (groupItems[0]?.id === p.id) ? "0.35" : "1";
    if (downBtn) downBtn.style.opacity = (groupItems[groupItems.length-1]?.id === p.id) ? "0.35" : "1";

    async function swapSort(aId, bId){
      const a = await DB.get("products", aId);
      const b = await DB.get("products", bId);
      if (!a || !b) return;

      // ensure numeric sortOrder exists
      const aS = (a.sortOrder ?? 0);
      const bS = (b.sortOrder ?? 0);

      a.sortOrder = bS;
      b.sortOrder = aS;

      await DB.put("products", a);
      await DB.put("products", b);
    }

    if (upBtn) upBtn.addEventListener("click", async ()=> {
      touch();
      const idx = groupItems.findIndex(x=>x.id===p.id);
      if (idx <= 0) return;
      await swapSort(groupItems[idx].id, groupItems[idx-1].id);
      await refreshAdminProducts();
    });

    if (downBtn) downBtn.addEventListener("click", async ()=> {
      touch();
      const idx = groupItems.findIndex(x=>x.id===p.id);
      if (idx < 0 || idx >= groupItems.length-1) return;
      await swapSort(groupItems[idx].id, groupItems[idx+1].id);
      await refreshAdminProducts();
    });

    if (p.trackStock) {
      const minus = row.querySelector('[data-act="minus"]');
      const plus = row.querySelector('[data-act="plus"]');

      minus.addEventListener("click", async () => {
        touch();
        const fresh = await DB.get("products", p.id);
        fresh.stock = Math.max(0, (fresh.stock||0) - 1);
        await DB.put("products", fresh);
        await refreshAdminProducts();
      });

      plus.addEventListener("click", async () => {
        touch();
        const fresh = await DB.get("products", p.id);
        fresh.stock = (fresh.stock||0) + 1;
        await DB.put("products", fresh);
        await refreshAdminProducts();
      });

      // Longpress on plus: add N
      attachLongPress(plus, async () => {
        const fresh = await DB.get("products", p.id);
        openModal({
          title: `${fresh.name} – Menge hinzufügen`,
          bodyHtml: `
            <div class="formrow">
              <label>Neuer Bestand (ganze Zahl)</label>
              <input id="lpAmount" inputmode="numeric" placeholder="z.B. 40">
            </div>
            <div class="muted small" style="margin-top:8px;">Aktueller Bestand: ${fresh.stock}</div>
          `,
          actions: [
            { label:"Abbrechen", onClick: async ()=> closeModal() },
            { label:"Übernehmen", primary:true, onClick: async ()=> {
              // Read value BEFORE confirm dialog (confirm replaces the modal)
              const v = parseInt($("#lpAmount")?.value ?? "", 10);
              if (!Number.isFinite(v) || v < 0) { showToast("Bitte Zahl ≥ 0", "warning"); return; }

              const ok = await confirmModal("Bestand setzen", `Bestand wirklich auf ${v} setzen?`, "Übernehmen");
              if (!ok) return;

              fresh.stock = v;
              await DB.put("products", fresh);
              closeModal();
              await refreshAdminProducts();
              showToast(`Bestand = ${v}`, "success");
            } }
          ]
        });
        setTimeout(()=>$("#lpAmount")?.focus(), 50);
      });
    }

    // Edit: price / active / thresholds
    row.querySelector('[data-act="edit"]').addEventListener("click", async () => {
      touch();
      const fresh = await DB.get("products", p.id);
      openModal({
        title: `Produkt bearbeiten – ${fresh.name}`,
        modalClass: "productEditModal",
        bodyHtml: `
          <div class="productFormGrid">
            <div class="formrow">
              <label for="editProdName">Produktname</label>
              <input id="editProdName" value="${fresh.name}">
            </div>
            <div class="formrow">
              <label for="editPrice">Preis in Euro</label>
              <input id="editPrice" inputmode="decimal" value="${(fresh.priceCents/100).toFixed(2).replace('.',',')}">
            </div>
            <div class="formrow">
              <label for="editCategory">Kategorie im Buchungsmenü</label>
              <select id="editCategory">
                <option value="drink" ${productCategory(fresh)==="drink"?"selected":""}>Getränk</option>
                <option value="snack" ${productCategory(fresh)==="snack"?"selected":""}>Snack</option>
              </select>
            </div>
            <div class="formrow">
              <label for="editColor">Farbe der Produktkachel</label>
              <select id="editColor">
                <option value="other"  ${fresh.color==="other"?"selected":""}>Grau – Neutral</option>
                <option value="water"  ${fresh.color==="water"?"selected":""}>Blau – Wasser</option>
                <option value="cola"   ${fresh.color==="cola"?"selected":""}>Rot – Cola</option>
                <option value="coffee" ${fresh.color==="coffee"?"selected":""}>Braun – Kaffee</option>
                <option value="snack"  ${fresh.color==="snack"?"selected":""}>Orange – Snack</option>
              </select>
            </div>
            <label class="checkOption" for="editActive">
              <input id="editActive" type="checkbox" ${fresh.active?'checked':''}>
              <span><strong>Produkt aktiv</strong><small>Im Buchungsmenü anzeigen</small></span>
            </label>
            <label class="checkOption" for="editTrackStock">
              <input id="editTrackStock" type="checkbox" ${fresh.trackStock?'checked':''}>
              <span><strong>Bestand verwalten</strong><small>Buchungen automatisch vom Bestand abziehen</small></span>
            </label>
            <div class="formrow" id="editStockRow">
              <label for="editStock">Aktueller Bestand</label>
              <input id="editStock" inputmode="numeric" value="${fresh.stock ?? 0}">
            </div>
            <div class="formrow" id="editThreshRow">
              <label for="editThresh">Warnung ab Bestand</label>
              <input id="editThresh" inputmode="numeric" value="${fresh.lowStockThreshold ?? 0}">
            </div>
          </div>
        `,
        actions: [
          { label:"Abbrechen", onClick: async ()=> closeModal() },
          { label:"Speichern", primary:true, onClick: async ()=> {
              const nameEl = $("#editProdName");
              if (!nameEl) { showToast("Name-Feld fehlt", "error"); return; }
              const newName = nameEl.value.trim();
              if (!newName) { showToast("Name fehlt", "warning"); return; }
              const priceStr = $("#editPrice").value.trim().replace('.',',');
              const num = parseFloat(priceStr.replace(',','.'));
              if (!Number.isFinite(num) || num < 0) { showToast("Ungültiger Preis", "warning"); return; }
              const oldPrice = fresh.priceCents;
              const newPricePreview = Math.round(num * 100);
              const priceChanged = (newPricePreview !== oldPrice);
              const activeValue = $("#editActive").checked;
              const trackStockValue = $("#editTrackStock").checked;
              let stockValue = fresh.stock ?? 0;
              let threshValue = null;

              fresh.name = newName;
              const colorEl = $("#editColor");
              if (colorEl) fresh.color = colorEl.value;
              fresh.category = $("#editCategory")?.value === "snack" ? "snack" : "drink";

              if (trackStockValue) {
                const stock = parseInt($("#editStock").value, 10);
                if (!Number.isFinite(stock) || stock < 0) { showToast("Bitte einen gültigen Bestand ab 0 eingeben.", "warning"); return; }
                const th = parseInt($("#editThresh").value, 10);
                if (!Number.isFinite(th) || th < 0) { showToast("Bitte eine gültige Bestandswarnung ab 0 eingeben.", "warning"); return; }
                stockValue = stock;
                threshValue = th;
              }
              if (priceChanged) {
                const ok = await confirmModal("Preis ändern", `Preis wirklich ändern von ${fmtEUR(oldPrice)} auf ${fmtEUR(newPricePreview)}?`, "Ändern");
                if (!ok) return;
              }

              fresh.priceCents = newPricePreview;
              if (fresh.priceCents !== oldPrice) {
                await DB.put("price_history", { id: safeUUID(), productId: fresh.id, oldPriceCents: oldPrice, newPriceCents: fresh.priceCents, ts: Date.now() });
              }
              fresh.active = activeValue;
              fresh.trackStock = trackStockValue;
              if (trackStockValue) {
                fresh.stock = stockValue;
                fresh.lowStockThreshold = threshValue;
              }

              await DB.put("products", fresh);
              closeModal();
              await refreshAdminProducts();
              showToast("Gespeichert", "success");
            }
          }
        ]
      });
      const syncEditStockFields = () => {
        const enabled = $("#editTrackStock")?.checked === true;
        const stockInput = $("#editStock");
        const thresholdInput = $("#editThresh");
        if (stockInput) stockInput.disabled = !enabled;
        if (thresholdInput) thresholdInput.disabled = !enabled;
      };
      $("#editTrackStock")?.addEventListener("change", () => { touch(); syncEditStockFields(); });
      syncEditStockFields();
      setTimeout(()=>$("#editPrice")?.focus(), 50);
    });

    list.appendChild(row);
  }
}

async function refreshAdminUsers() {
  const list = $("#userList");
  const users = (await DB.getAll("users")).sort((a,b)=>a.id.localeCompare(b.id));
  list.innerHTML = "";

  for (const u of users) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="itemLeft">
        <div class="itemTitle">${u.name} <span class="pill">${u.id}</span> ${u.isTestUser && featureIsUnlocked("testUsers")?'<span class="pill testUser">Testnutzer</span>':''} ${!u.active?'<span class="pill out">inaktiv</span>':''}</div>
      </div>
      <div class="itemRight">
        <div class="iconbtn" data-act="edit">✎</div>
        <div class="iconbtn" data-act="toggle">${u.active ? "⏸" : "▶"}</div>
      </div>
    `;
    row.querySelector('[data-act="edit"]').addEventListener("click", async ()=> {
      touch();

      const deleteUser = async () => {
        const ok = await confirmModal(
          "Nutzer löschen",
          `Nutzer "${u.name}" (${u.id}) wirklich löschen? Buchungen und Zahlungen bleiben erhalten.`,
          "Nutzer löschen"
        );
        if (!ok) return;
        try {
          await deleteFromStore("users", u.id);
          closeModal();
          await refreshAdminUsers();
          await refreshAdminPayments(false);
          await refreshAdminOverview?.();
          showToast("Nutzer gelöscht", "success");
        } catch (e) {
          console.error("User delete failed", e);
          showToast("Nutzer konnte nicht gelöscht werden: " + (e?.message || String(e)), "error");
        }
      };

      const testUserOption = featureIsUnlocked("testUsers") ? `
            <div class="formrow">
              <label class="checkOption"><input id="editUserIsTestUser" type="checkbox" ${u.isTestUser ? "checked" : ""}> Als Testnutzer markieren</label>
              <div class="muted small">Buchungen dieses Nutzers können später gesammelt zurückgesetzt werden.</div>
            </div>` : "";

      openModal({
        title: `Nutzer bearbeiten – ${u.name}`,
        modalClass: "userEditModal",
        bodyHtml: `
          <div class="formSectionTitle">Nutzerdaten</div>
          <div class="productFormGrid">
            <div class="formrow">
              <label for="editUserName">Name</label>
              <input id="editUserName" value="${u.name}">
            </div>
            <div class="formrow">
              <label>Nutzer-ID</label>
              <input value="${u.id}" disabled>
            </div>
            ${testUserOption}
          </div>

          <div class="dangerZone userDeleteZone">
            <div>
              <div class="formSectionTitle">Gefährliche Aktion</div>
              <div class="dangerText">Der Nutzerzugang wird gelöscht. Frühere Buchungen und Zahlungen bleiben erhalten.</div>
            </div>
            <button id="btnEditUserDelete" class="btn danger" type="button">Nutzer löschen</button>
          </div>
        `,
        actions: [
          { label:"Abbrechen", onClick: async ()=> closeModal() },
          { label:"Speichern", primary:true, onClick: async ()=> {
            try {
              const el = $("#editUserName");
              if (!el) { showToast("Speichern fehlgeschlagen: Feld fehlt", "error"); return; }
              const name = el.value.trim();
              if (!name) { showToast("Name fehlt", "warning"); return; }
              const fresh = await DB.get("users", u.id);
              if (!fresh) { showToast("Speichern fehlgeschlagen: Nutzer fehlt", "error"); return; }
              fresh.name = name;
              if (featureIsUnlocked("testUsers")) fresh.isTestUser = $("#editUserIsTestUser")?.checked === true;
              await DB.put("users", fresh);

              closeModal();
              await refreshAdminUsers();
              await refreshAdminPayments(false); // Dropdown wurde bereits aktualisiert
              showToast("Gespeichert", "success");
            } catch (e) {
              console.error("User save failed", e);
              showToast("Speichern fehlgeschlagen: " + (e?.message || String(e)), "error");
              return;
            }
          } }
        ]
      });
      $("#btnEditUserDelete")?.addEventListener("click", deleteUser);
      setTimeout(()=>$("#editUserName")?.focus(), 50);
    });

    row.querySelector('[data-act="toggle"]').addEventListener("click", async ()=> {
      touch();
      u.active = !u.active;
      await DB.put("users", u);
      await refreshAdminUsers();
      await refreshAdminPayments(false); // Dropdown wurde bereits aktualisiert
    });
    list.appendChild(row);
  }

  fillPaymentUserSelect(users);
}

function fillPaymentUserSelect(users) {
  const sel = $("#payUser");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = "";
  users.filter(u=>u.active).forEach(u=>{
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `${u.name} (${u.id})`;
    sel.appendChild(opt);
  });
  if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

async function loadPaymentUsers() {
  const users = (await DB.getAll("users")).sort((a,b)=>a.id.localeCompare(b.id));
  fillPaymentUserSelect(users);
  return users;
}

async function updatePayOpen() {
  const userId = $("#payUser").value;
  if (!userId) { $("#payOpen").textContent = "Saldo: —"; return 0; }
  const bal = await getUserBalance(userId);
  const displaySaldo = -bal;
  const absDisp = Math.abs(displaySaldo);
  const balText = displaySaldo > 0 ? `+${fmtEUR(displaySaldo)}` : displaySaldo < 0 ? `-${fmtEUR(absDisp)}` : fmtEUR(0);
  const balClass = displaySaldo > 0 ? "pos" : displaySaldo < 0 ? "neg" : "";
  $("#payOpen").innerHTML = `Saldo: <span class="amt ${balClass}">${balText}</span>`;
  const btn = $("#btnFillAll");
  if (btn) btn.disabled = !(bal > 0);
  return bal;
}

async function refreshAdminPayments(refreshUsers = true) {
  const users = refreshUsers ? await loadPaymentUsers() : await DB.getAll("users");
  await updatePayOpen();

  const list = $("#paymentList");
  const payments = await DB.getLastByIndex("payments", "ts", 20);
  const usersById = new Map(users.map(u => [u.id, u]));
  list.innerHTML = "";
  for (const p of payments) {
    const u = usersById.get(p.userId);
    const userName = u ? u.name : p.userId;
    const when = new Date(p.ts).toLocaleString("de-DE", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
    const isVoided = !!p.voidedAt;
    const canVoid = !isVoided && isTimestampToday(p.ts);
    const row = document.createElement("div");
    row.className = `item${isVoided ? " paymentVoided" : ""}`;
    row.innerHTML = `
      <div class="itemLeft">
        <div class="itemTitle">${escapeHtml(userName)} <span class="pill">${escapeHtml(p.userId)}</span>${isVoided ? ' <span class="pill out">storniert</span>' : ""}</div>
        <div class="itemMeta">${when}${p.note ? " • " + escapeHtml(p.note) : ""}</div>
      </div>
      <div class="itemRight">
        <div class="qty">${fmtEUR(p.amountCents)}</div>
        ${canVoid ? '<button class="btn small danger" data-act="void-payment">Storno</button>' : ""}
      </div>
    `;
    row.querySelector('[data-act="void-payment"]')?.addEventListener("click", async () => {
      touch();
      const ok = await confirmModal(
        "Zahlung stornieren",
        `${fmtEUR(p.amountCents)} von "${userName}" am ${when} wirklich stornieren?`,
        "Stornieren"
      );
      if (!ok) return;
      try {
        const current = await DB.get("payments", p.id);
        if (!current || current.voidedAt || !isTimestampToday(current.ts)) {
          await refreshAdminPayments(false);
          showToast("Zahlung kann nicht mehr storniert werden", "warning");
          return;
        }
        current.voidedAt = Date.now();
        await DB.put("payments", current);
        invalidatePersonalReportCache(current.ts);
        const newBalance = await getUserBalance(current.userId);
        await refreshAdminPayments(false);
        showToast(`Zahlung storniert · Neuer Saldo: ${formatSaldo(-newBalance)}`, "success");
      } catch (error) {
        console.error("Payment void failed", error);
        showToast("Zahlung konnte nicht storniert werden: " + (error?.message || String(error)), "error");
      }
    });
    list.appendChild(row);
  }
  if (!payments.length) list.innerHTML = `<div class="muted">Keine Zahlungen.</div>`;
}

async function refreshAdminOverview() {
  updateDeviceBattery();
  const [usersAll, allTxnsRaw, allPayments, products] = await Promise.all([
    DB.getAll("users"),
    DB.getAll("txns"),
    DB.getAll("payments"),
    DB.getAll("products")
  ]);
  const users = usersAll.filter(u=>u.active);
  const activeIds = new Set(users.map(u => u.id));
  const balances = new Map(users.map(u => [u.id, 0]));
  const start = new Date(); start.setHours(0,0,0,0);
  const startMs = start.getTime();
  const todayTxns = [];
  for (const t of allTxnsRaw) {
    if (t.voidedAt) continue;
    if (activeIds.has(t.userId)) balances.set(t.userId, (balances.get(t.userId) || 0) + (t.priceCents || 0));
    if (t.ts >= startMs) todayTxns.push(t);
  }
  for (const p of allPayments) {
    if (p.voidedAt) continue;
    if (activeIds.has(p.userId)) balances.set(p.userId, (balances.get(p.userId) || 0) - (p.amountCents || 0));
  }
  const open = [...balances.values()].reduce((sum, value) => sum + value, 0);
  $("#kpiOpen").textContent = fmtEUR(open);

  // Today's revenue: sum of today's non-void txns across all users
  const todaySum = todayTxns.reduce((s,t)=>s+t.priceCents,0);
  $("#kpiToday").textContent = fmtEUR(todaySum);

  const lowProducts = products.filter(p => p.active && p.trackStock && p.stock <= (p.lowStockThreshold || 0));
  const lowDetails = $("#lowStockDetails");
  lowDetails.classList.toggle("hidden", !lowProducts.length);
  lowDetails.innerHTML = lowProducts.length
    ? `<strong>Bestand prüfen:</strong> ${lowProducts.map(p => `${escapeHtml(p.name)} ${p.stock}`).join(" · ")}`
    : "";
  // Consumption by product today
  const byProd = {};
  for (const t of todayTxns) byProd[t.productId] = (byProd[t.productId]||0)+1;
  const prodList = Object.entries(byProd).sort((a,b)=>b[1]-a[1]);

  const el = $("#todayConsumption");
  el.innerHTML = "";
  if (!prodList.length) { el.innerHTML = `<div class="muted">Heute noch keine Buchungen.</div>`; return; }
  const productsById = new Map(products.map(p => [p.id, p]));
  for (const [pid, count] of prodList) {
    const p = productsById.get(pid);
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="itemLeft">
        <div class="itemTitle">${p ? p.name : pid}</div>
        <div class="itemMeta">Anzahl heute</div>
      </div>
      <div class="itemRight">
        <div class="qty">${count}</div>
      </div>
    `;
    el.appendChild(row);
  }
}

async function refreshAdminAudit() {
  const phEl = $("#priceHistoryList");
  const el = $("#auditList");
  const fromInput = $("#auditDateFrom");
  const toInput = $("#auditDateTo");
  const today = localDateInputValue();
  if (!fromInput.value) fromInput.value = today;
  if (!toInput.value) toInput.value = today;
  const fromValue = fromInput.value;
  const toValue = toInput.value;
  const fromTs = fromValue ? new Date(`${fromValue}T00:00:00`).getTime() : null;
  const toTs = toValue ? new Date(`${toValue}T23:59:59.999`).getTime() : null;
  const [txnsAll, users, products, historyAll] = await Promise.all([
    DB.getAllByIndexRange("txns", "ts", fromTs, toTs),
    DB.getAll("users"),
    DB.getAll("products"),
    DB.getLastByIndex("price_history", "ts", 20)
  ]);
  const usersById = new Map(users.map(u => [u.id, u]));
  const productsById = new Map(products.map(p => [p.id, p]));
  const userFilter = $("#auditUserFilter");
  const previousUser = userFilter.value;
  userFilter.innerHTML = '<option value="all">Alle Nutzer</option>';
  users.sort((a,b)=>(a.name||"").localeCompare(b.name||"", "de-DE")).forEach(u => {
    const option = document.createElement("option");
    option.value = u.id;
    option.textContent = `${u.name} (${u.id})`;
    userFilter.appendChild(option);
  });
  if ([...userFilter.options].some(o => o.value === previousUser)) userFilter.value = previousUser;

  const status = $("#auditStatusFilter").value || "all";
  const txns = txnsAll
    .filter(t => userFilter.value === "all" || t.userId === userFilter.value)
    .filter(t => status === "all" || (status === "voided" ? !!t.voidedAt : !t.voidedAt))
    .sort((a,b)=>b.ts-a.ts)
    .slice(0, 100);
  el.innerHTML = "";
  for (const t of txns) {
    const u = usersById.get(t.userId);
    const p = productsById.get(t.productId);
    const productLabel = p ? p.name : `(Unbekannt: ${t.productId})`;
    const when = new Date(t.ts).toLocaleString("de-DE", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
    const row = document.createElement("div");
    row.className = "item";
    const badge = t.voidedAt ? '<span class="pill out">storniert</span>' : '';
    row.innerHTML = `<div class="itemLeft"><div class="itemTitle">${u ? u.name : t.userId} (${t.userId}) ${badge}</div><div class="itemMeta">${when} &bull; ${productLabel}</div></div><div class="itemRight"><div class="qty">${fmtEUR(t.priceCents)}</div>${t.voidedAt ? "" : "<button class=\"btn small danger\" data-act=\"void\">Storno</button>"}</div>`;
    el.appendChild(row);
    const voidBtn = row.querySelector('[data-act="void"]');
    if (voidBtn) {
      voidBtn.addEventListener("click", async ()=> {
        touch();
        const userLabel = u ? u.name : t.userId;
        const ok = await confirmModal(
          "Buchung stornieren",
          `${fmtEUR(t.priceCents)} für "${productLabel}" von "${userLabel}" wirklich stornieren? Der Bestand wird gegebenenfalls zurückgebucht.`,
          "Stornieren"
        );
        if (!ok) return;
        try{
          const txn = await DB.get("txns", t.id);
          if (!txn || txn.voidedAt) return;
          txn.voidedAt = Date.now();
          await DB.put("txns", txn);
          const prod = await DB.get("products", txn.productId);
          if (prod && prod.trackStock){
            prod.stock = (prod.stock || 0) + 1;
            await DB.put("products", prod);
          }
          await refreshAdminAudit();
        }catch(e){
          console.error("Storno fehlgeschlagen", e);
          showToast("Storno fehlgeschlagen", "error");
        }
      });
    }
  }
  if (!txns.length) el.innerHTML = `<div class="muted">Keine passenden Buchungen.</div>`;

  // Price history (last 20)
  const history = historyAll.sort((a,b)=>b.ts-a.ts).slice(0, 20);
  phEl.innerHTML = "";
  if (!history.length) { phEl.innerHTML = `<div class="muted">Keine Preisänderungen.</div>`; return; }
  for (const h of history) {
    const p = productsById.get(h.productId);
    const when = new Date(h.ts).toLocaleString("de-DE", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="itemLeft">
        <div class="itemTitle">${p ? p.name : h.productId}</div>
        <div class="itemMeta">${when}</div>
      </div>
      <div class="itemRight">
        <div class="qty">${fmtEUR(h.oldPriceCents)} → ${fmtEUR(h.newPriceCents)}</div>
      </div>`;
    phEl.appendChild(row);
  }
}

function formatBytes(bytes){
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B","KB","MB","GB","TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRuntime(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} T`);
  if (days || hours) parts.push(`${hours} Std`);
  parts.push(`${minutes} Min`);
  return parts.join(" ");
}

function safeFullyCall(methodName, fallback = null) {
  try {
    const method = window.fully?.[methodName];
    if (typeof method !== "function") return fallback;
    const value = method.call(window.fully);
    return value == null || value === "" ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

async function refreshAdminDiagnose() {
  const list = $("#diagnoseList");
  if (!list) return;
  list.innerHTML = "";

  const addRow = (label, value) => {
    const row = document.createElement("div");
    row.className = "diagnoseItem";
    row.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    list.appendChild(row);
  };

  let dbOpen = false;
  try{
    await openDb();
    dbOpen = true;
  }catch(e){}

  const storeDefs = [
    { store:"users", label:"Nutzer" },
    { store:"products", label:"Produkte" },
    { store:"txns", label:"Buchungen" },
    { store:"payments", label:"Zahlungen" }
  ];
  const counts = await Promise.all(storeDefs.map(async definition => {
      try { return await DB.count(definition.store); }
      catch (_) { return null; }
    }));

  addRow("Datenspeicher", dbOpen ? "bereit" : "nicht verfügbar");
  addRow("App-Laufzeit", formatRuntime(Date.now() - appStartedAt));
  storeDefs.forEach((definition, index) => {
    const count = counts[index];
    addRow(definition.label, count == null ? "nicht verfügbar" : String(count));
  });

  updateDeviceBattery();
  const fullyAvailable = !!window.fully && ["getDeviceModel", "getAndroidVersion", "getFullyVersion", "getBatteryLevel"]
    .some(methodName => typeof window.fully?.[methodName] === "function");
  if (fullyAvailable) {
    addRow("Gerät", safeFullyCall("getDeviceModel", "nicht verfügbar"));
    addRow("Android", safeFullyCall("getAndroidVersion", "nicht verfügbar"));
    addRow("Fully Kiosk", safeFullyCall("getFullyVersion", "nicht verfügbar"));
    addRow("Akku", deviceBatteryState.available ? `${deviceBatteryState.level}%${deviceBatteryState.plugged ? " · lädt" : ""}` : "nicht verfügbar");
    const displayWidth = Number(safeFullyCall("getDisplayWidth", NaN));
    const displayHeight = Number(safeFullyCall("getDisplayHeight", NaN));
    addRow("Bildschirm", Number.isFinite(displayWidth) && displayWidth > 0 && Number.isFinite(displayHeight) && displayHeight > 0
      ? `${displayWidth} × ${displayHeight} px`
      : "nicht verfügbar");
  } else {
    addRow("Gerät", "Browser");
    addRow("Geräte-App", "nicht verbunden");
  }

  if (navigator.storage && navigator.storage.estimate) {
    try{
      const est = await navigator.storage.estimate();
      const used = formatBytes(est?.usage);
      const quota = formatBytes(est?.quota);
      addRow("Speicher", (used !== "—" && quota !== "—") ? `${used} / ${quota}` : "nicht verfügbar");
    }catch(e){
      addRow("Speicher", "nicht verfügbar");
    }
  } else {
    addRow("Speicher", "nicht verfügbar");
  }
  if (!fullyAvailable) addRow("Betriebsart", location.protocol === "file:" ? "lokal" : location.protocol.replace(":", ""));
}

async function refreshLocalBuildStatus() {
  const list = $("#localBuildStatusList");
  if (!list) return;
  list.innerHTML = "";
  const add = (label, value) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div class="itemLeft"><div class="itemTitle">${escapeHtml(label)}</div><div class="itemMeta">${escapeHtml(value)}</div></div>`;
    list.appendChild(row);
  };
  add("App-Version", APP_BUILD);
}

async function collectSystemIssues() {
  const issues = [];
  const addIssue = (level, text) => issues.push({ level, text });
  const [users, products, txns, payments] = await Promise.all([
    DB.getAll("users"), DB.getAll("products"), DB.getAll("txns"), DB.getAll("payments")
  ]);
  const userIds = new Set(users.map(u => u.id));
  const productIds = new Set(products.map(p => p.id));
  users.forEach(u => {
    if (!/^\d{4}$/.test(String(u.id || "")) || !String(u.name || "").trim()) addIssue("error", `Ungültiger Nutzer: ${u.id || "ohne ID"}`);
  });
  products.forEach(p => {
    if (!p.id || !String(p.name || "").trim() || !Number.isFinite(Number(p.priceCents)) || Number(p.priceCents) < 0) addIssue("error", `Ungültiges Produkt: ${p.id || "ohne ID"}`);
    if (p.trackStock && (!Number.isFinite(Number(p.stock)) || Number(p.stock) < 0)) addIssue("warning", `Ungültiger Bestand bei ${p.name || p.id}.`);
    if (p.trackStock && (!Number.isFinite(Number(p.lowStockThreshold)) || Number(p.lowStockThreshold) < 0)) addIssue("warning", `Ungültige Warnschwelle bei ${p.name || p.id}.`);
  });
  txns.forEach(t => {
    if (!userIds.has(t.userId)) addIssue("warning", `Buchung ${t.id} verweist auf unbekannten Nutzer ${t.userId}.`);
    if (!productIds.has(t.productId)) addIssue("warning", `Buchung ${t.id} verweist auf unbekanntes Produkt ${t.productId}.`);
    if (!Number.isFinite(Number(t.ts)) || !Number.isFinite(Number(t.priceCents))) addIssue("error", `Buchung ${t.id || "ohne ID"} enthält ungültige Werte.`);
  });
  payments.forEach(p => {
    if (!userIds.has(p.userId)) addIssue("warning", `Zahlung ${p.id} verweist auf unbekannten Nutzer ${p.userId}.`);
    if (!Number.isFinite(Number(p.ts)) || !Number.isFinite(Number(p.amountCents)) || Number(p.amountCents) <= 0) addIssue("error", `Zahlung ${p.id || "ohne ID"} enthält ungültige Werte.`);
  });
  return issues;
}

function renderAutomaticSystemNotice() {
  const notice = $("#automaticSystemNotice");
  if (!notice) return;
  const issues = automaticSystemIssues;
  notice.classList.toggle("hidden", !Array.isArray(issues) || issues.length === 0);
  if (!Array.isArray(issues) || !issues.length) return;
  const errors = issues.filter(issue => issue.level === "error").length;
  const warnings = issues.length - errors;
  const parts = [];
  if (errors) parts.push(`${errors} Fehler`);
  if (warnings) parts.push(`${warnings} Warnung${warnings === 1 ? "" : "en"}`);
  $("#automaticSystemNoticeText").textContent = `${parts.join(" und ")} gefunden.`;
}

async function runDailyAutomaticSystemCheck() {
  const today = localDateInputValue();
  if (automaticSystemCheckDate === today) return automaticSystemIssues;
  automaticSystemCheckDate = today;
  try {
    automaticSystemIssues = await collectSystemIssues();
  } catch (error) {
    console.error("Automatic system check failed", error);
    automaticSystemIssues = [{ level:"error", text:`Automatische Systemprüfung fehlgeschlagen: ${error?.message || String(error)}` }];
  }
  renderAutomaticSystemNotice();
  return automaticSystemIssues;
}

async function runSystemCheck() {
  const host = $("#systemCheckResult");
  if (!host) return;
  host.classList.remove("hidden");
  host.innerHTML = '<div class="muted">Systemprüfung läuft…</div>';
  try {
    const issues = await collectSystemIssues();
    automaticSystemCheckDate = localDateInputValue();
    automaticSystemIssues = issues;
    renderAutomaticSystemNotice();

    if (!issues.length) {
      host.innerHTML = '<div class="checkSummary checkOk"><strong>Systemprüfung erfolgreich</strong><span>Keine Auffälligkeiten gefunden. Es wurden keine Daten verändert.</span></div>';
      showToast("Systemprüfung ohne Auffälligkeiten abgeschlossen.", "success");
    } else {
      host.innerHTML = `<div class="checkSummary checkWarn"><strong>${issues.length} Auffälligkeit${issues.length === 1 ? "" : "en"} gefunden</strong><span>Es wurden keine Daten verändert.</span></div>` + issues.map(i => `<div class="checkIssue checkIssue--${i.level}">${escapeHtml(i.text)}</div>`).join("");
      showToast(`Systemprüfung: ${issues.length} Auffälligkeit${issues.length === 1 ? "" : "en"} gefunden.`, "warning");
    }
  } catch (e) {
    host.innerHTML = `<div class="checkIssue checkIssue--error">Systemprüfung fehlgeschlagen: ${escapeHtml(e?.message || String(e))}</div>`;
    showToast("Systemprüfung konnte nicht abgeschlossen werden.", "error");
  }
}

async function refreshAdminMonthly() {
  const select = $("#monthlySelect");
  const toggle = $("#monthlyToggle");
  const results = $("#monthlyResults");
  const summary = $("#monthlySummary");
  const usersHost = $("#monthlyUsers");
  const search = $("#monthlyUserFilter");
  if (!select || !toggle || !results || !summary || !usersHost || !search) return;

  const [firstTxn, firstPayment] = await Promise.all([
    DB.getFirstByIndex("txns", "ts"),
    DB.getFirstByIndex("payments", "ts")
  ]);

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const firstTimestamps = [firstTxn?.ts, firstPayment?.ts].filter(Number.isFinite);
  const firstTimestamp = firstTimestamps.length ? Math.min(...firstTimestamps) : null;
  let startDate = firstTimestamp != null ? new Date(firstTimestamp) : new Date(curY, curM, 1);
  let y = startDate.getFullYear();
  let m = startDate.getMonth();

  const months = [];
  while (y < curY || (y === curY && m <= curM)) {
    months.push(`${y}-${String(m+1).padStart(2,"0")}`);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  const currentKey = `${curY}-${String(curM+1).padStart(2,"0")}`;
  let selected = select.value || currentKey;

  select.innerHTML = "";
  months.forEach(k => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    if (k === selected) opt.selected = true;
    select.appendChild(opt);
  });
  if (!months.includes(selected)) {
    selected = currentKey;
    select.value = currentKey;
  }

  let users = [];
  let products = [];
  let productsById = new Map();
  let referenceDataLoaded = false;
  let loadedKey = null;
  let loading = false;
  let summaryLoading = false;
  let summaryLoadedKey = null;
  let selectedTxns = [];
  let selectedPayments = [];

  const renderFor = (key) => {
    const txns = selectedTxns;
    const payments = selectedPayments;

    const txnsByUser = new Map();
    const revenueByUser = new Map();
    for (const t of txns) {
      if (!txnsByUser.has(t.userId)) txnsByUser.set(t.userId, []);
      txnsByUser.get(t.userId).push(t);
      revenueByUser.set(t.userId, (revenueByUser.get(t.userId) || 0) + (t.priceCents || 0));
    }
    const paymentsByUser = new Map();
    for (const p of payments) {
      if (!paymentsByUser.has(p.userId)) paymentsByUser.set(p.userId, []);
      paymentsByUser.get(p.userId).push(p);
    }
    for (const list of paymentsByUser.values()) {
      list.sort((a,b)=>b.ts-a.ts);
    }

    const query = search.value.trim().toLocaleLowerCase("de-DE");
    const visibleUsers = users.filter(u => {
      const hasActivity = (txnsByUser.get(u.id)?.length || 0) + (paymentsByUser.get(u.id)?.length || 0) > 0;
      const matches = !query || `${u.name || ""} ${u.id}`.toLocaleLowerCase("de-DE").includes(query);
      return hasActivity && matches;
    }).sort((a,b) =>
      (revenueByUser.get(b.id) || 0) - (revenueByUser.get(a.id) || 0)
      || (a.name || a.id).localeCompare(b.name || b.id, "de-DE")
    );

    usersHost.innerHTML = "";
    if (!visibleUsers.length) {
      usersHost.innerHTML = `<div class="card muted">Keine passenden Monatsdaten.</div>`;
      return;
    }

    const buildUserDetails = (u, userTxns, userPayments) => {
      let totalCount = 0;
      let totalSum = 0;
      let bookingsBody = "";
      if (!userTxns.length) {
        bookingsBody = `<tr><td colspan="3">Keine Buchungen im Monat</td></tr>`;
      } else {
        const prodAgg = new Map();
        for (const t of userTxns) {
          if (!prodAgg.has(t.productId)) prodAgg.set(t.productId, { count: 0, sum: 0 });
          const a = prodAgg.get(t.productId);
          a.count += 1;
          a.sum += t.priceCents || 0;
        }

        for (const p of products) {
          const agg = prodAgg.get(p.id);
          if (!agg) continue;
          totalCount += agg.count;
          totalSum += agg.sum;
          bookingsBody += `<tr><td>${p.name}</td><td>${agg.count}</td><td>${fmtEUR(agg.sum)}</td></tr>`;
        }
        for (const [pid, agg] of prodAgg.entries()) {
          if (productsById.has(pid)) continue;
          totalCount += agg.count;
          totalSum += agg.sum;
          bookingsBody += `<tr><td>${pid}</td><td>${agg.count}</td><td>${fmtEUR(agg.sum)}</td></tr>`;
        }
      }
      let totalPay = 0;
      let paymentsBody = "";
      if (!userPayments.length) {
        paymentsBody = `<tr><td colspan="3">Keine Zahlungen im Monat</td></tr>`;
      } else {
        for (const p of userPayments) {
          const when = new Date(p.ts).toLocaleString("de-DE");
          const note = p.note ? p.note : "—";
          const amount = p.amountCents || 0;
          totalPay += amount;
          paymentsBody += `<tr><td>${when}</td><td>${note}</td><td>${fmtEUR(amount)}</td></tr>`;
        }
      }
      return `
        <table><thead><tr><th>Produkt</th><th>Anzahl</th><th>Summe</th></tr></thead><tbody>${bookingsBody}</tbody>
          <tfoot><tr><td><b>Summe Buchungen</b></td><td><b>${totalCount}</b></td><td><b>${fmtEUR(totalSum)}</b></td></tr></tfoot></table>
        <table><thead><tr><th>Datum</th><th>Notiz</th><th>Betrag</th></tr></thead><tbody>${paymentsBody}</tbody>
          <tfoot><tr><td colspan="2"><b>Summe Zahlungen</b></td><td><b>${fmtEUR(totalPay)}</b></td></tr></tfoot></table>`;
    };

    for (const u of visibleUsers) {
      const userTxns = txnsByUser.get(u.id) || [];
      const userPayments = paymentsByUser.get(u.id) || [];
      const purchases = revenueByUser.get(u.id) || 0;
      const details = document.createElement("details");
      details.className = "monthlyUser card compact";
      details.innerHTML = `
        <summary><span><strong>${u.name || u.id}</strong><small>${u.id} · ${userTxns.length} Buchungen</small></span><b>${fmtEUR(purchases)}</b></summary>
        <div class="monthlyUserDetails"></div>`;
      details.addEventListener("toggle", () => {
        const body = details.querySelector(".monthlyUserDetails");
        if (details.open && !body.dataset.loaded) {
          body.innerHTML = buildUserDetails(u, userTxns, userPayments);
          body.dataset.loaded = "true";
        }
      });
      usersHost.appendChild(details);
    }
  };

  const loadMonthSummary = async (key) => {
    if (summaryLoading || loadedKey !== key) return;
    summaryLoading = true;
    toggle.disabled = true;
    toggle.textContent = "Gesamtübersicht wird geladen …";
    const [year, month] = key.split("-").map(Number);
    const periodStart = new Date(year, month - 1, 1).getTime();
    const periodEnd = new Date(year, month, 1).getTime();
    try {
      if (loadedKey !== key || select.value !== key) return;
      const totalBookings = selectedTxns.length;
      const totalPurchases = selectedTxns.reduce((sum,t)=>sum+(t.priceCents||0),0);
      const totalPayments = selectedPayments.reduce((sum,p)=>sum+(p.amountCents||0),0);
      summary.innerHTML = `
        <div class="card compact"><div class="muted">Buchungen</div><div class="kpi">${totalBookings}</div></div>
        <div class="card compact"><div class="muted">Produktumsatz</div><div class="kpi">${fmtEUR(totalPurchases)}</div></div>
        <div class="card compact"><div class="muted">Nutzerzahlungen</div><div class="kpi">${fmtEUR(totalPayments)}</div></div>`;
      summaryLoadedKey = key;
    } finally {
      summaryLoading = false;
      toggle.disabled = false;
      toggle.textContent = summary.classList.contains("hidden")
        ? "Gesamtübersicht anzeigen"
        : "Gesamtübersicht ausblenden";
    }
  };

  const loadMonth = async (key) => {
    if (loading) return;
    loading = true;
    toggle.disabled = true;
    select.disabled = true;
    usersHost.innerHTML = `<div class="card muted">Nutzerliste wird geladen …</div>`;
    const parts = key.split("-");
    const yy = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10) - 1;
    const start = new Date(yy, mm, 1).getTime();
    const end = new Date(yy, mm + 1, 1).getTime() - 1;
    try {
      const referencePromise = referenceDataLoaded
        ? Promise.resolve([users, products])
        : Promise.all([DB.getAll("users"), DB.getAll("products")]);
      const [txns, payments, referenceData] = await Promise.all([
        DB.getAllByIndexRange("txns", "ts", start, end),
        DB.getAllByIndexRange("payments", "ts", start, end),
        referencePromise
      ]);
      [users, products] = referenceData;
      if (!referenceDataLoaded) {
        users.sort((a,b)=> (a.name||"").localeCompare(b.name||"", "de-DE"));
        products.sort((a,b)=> (a.sortOrder||0) - (b.sortOrder||0));
        productsById = new Map(products.map(p => [p.id, p]));
        referenceDataLoaded = true;
      }
      selectedTxns = txns.filter(t => !t.voidedAt);
      selectedPayments = payments.filter(payment => !payment.voidedAt);
      loadedKey = key;
      renderFor(key);
    } finally {
      loading = false;
      toggle.disabled = false;
      select.disabled = false;
      toggle.textContent = summary.classList.contains("hidden")
        ? "Gesamtübersicht anzeigen"
        : "Gesamtübersicht ausblenden";
    }
  };

  results.classList.remove("hidden");
  summary.classList.add("hidden");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Gesamtübersicht anzeigen";
  summary.innerHTML = "";
  usersHost.innerHTML = "";
  search.value = "";
  toggle.onclick = async () => {
    touch();
    const opening = summary.classList.contains("hidden");
    summary.classList.toggle("hidden", !opening);
    toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    toggle.textContent = opening ? "Gesamtübersicht ausblenden" : "Gesamtübersicht anzeigen";
    if (opening && summaryLoadedKey !== select.value) await loadMonthSummary(select.value);
  };
  select.onchange = async () => {
    touch();
    summary.classList.add("hidden");
    summary.innerHTML = "";
    summaryLoadedKey = null;
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Gesamtübersicht anzeigen";
    await loadMonth(select.value);
  };
  search.oninput = () => {
    if (loadedKey === select.value) renderFor(select.value);
  };
  await loadMonth(select.value);
}

async function resetAdminAuditToToday() {
  const today = localDateInputValue();
  $("#auditUserFilter").value = "all";
  $("#auditStatusFilter").value = "all";
  $("#auditDateFrom").value = today;
  $("#auditDateTo").value = today;
  await refreshAdminAudit();
}

async function refreshAdminYearly() {
  const select = $("#yearlySelect");
  const toggle = $("#yearlyToggle");
  const results = $("#yearlyResults");
  const summary = $("#yearlySummary");
  const usersHost = $("#yearlyUsers");
  const search = $("#yearlyUserFilter");
  if (!select || !toggle || !results || !summary || !usersHost || !search) return;

  const [firstTxn, firstPayment] = await Promise.all([
    DB.getFirstByIndex("txns", "ts"),
    DB.getFirstByIndex("payments", "ts")
  ]);

  const now = new Date();
  const currentYear = now.getFullYear();
  const firstTimestamps = [firstTxn?.ts, firstPayment?.ts].filter(Number.isFinite);
  const firstYear = firstTimestamps.length
    ? new Date(Math.min(...firstTimestamps)).getFullYear()
    : currentYear;
  const years = [];
  for (let year = firstYear; year <= currentYear; year++) years.push(String(year));

  let selected = select.value || String(currentYear);
  select.innerHTML = "";
  years.forEach(year => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    if (year === selected) option.selected = true;
    select.appendChild(option);
  });
  if (!years.includes(selected)) {
    selected = String(currentYear);
    select.value = selected;
  }

  let users = [];
  let products = [];
  let productsById = new Map();
  let referenceDataLoaded = false;
  let loadedYear = null;
  let loading = false;
  let summaryLoading = false;
  let summaryLoadedYear = null;
  let selectedTxns = [];
  let selectedPayments = [];

  const renderYear = () => {
    const txnsByUser = new Map();
    const revenueByUser = new Map();
    for (const t of selectedTxns) {
      if (!txnsByUser.has(t.userId)) txnsByUser.set(t.userId, []);
      txnsByUser.get(t.userId).push(t);
      revenueByUser.set(t.userId, (revenueByUser.get(t.userId) || 0) + (t.priceCents || 0));
    }
    const paymentsByUser = new Map();
    for (const p of selectedPayments) {
      if (!paymentsByUser.has(p.userId)) paymentsByUser.set(p.userId, []);
      paymentsByUser.get(p.userId).push(p);
    }
    for (const list of paymentsByUser.values()) {
      list.sort((a,b)=>b.ts-a.ts);
    }

    const query = search.value.trim().toLocaleLowerCase("de-DE");
    const visibleUsers = users.filter(u => {
      const hasActivity = (txnsByUser.get(u.id)?.length || 0) + (paymentsByUser.get(u.id)?.length || 0) > 0;
      const matches = !query || `${u.name || ""} ${u.id}`.toLocaleLowerCase("de-DE").includes(query);
      return hasActivity && matches;
    }).sort((a,b) =>
      (revenueByUser.get(b.id) || 0) - (revenueByUser.get(a.id) || 0)
      || (a.name || a.id).localeCompare(b.name || b.id, "de-DE")
    );

    usersHost.innerHTML = "";
    if (!visibleUsers.length) {
      usersHost.innerHTML = `<div class="card muted">Keine passenden Jahresdaten.</div>`;
      return;
    }

    const buildUserDetails = (userTxns, userPayments) => {
      let totalCount = 0;
      let totalSum = 0;
      let bookingsBody = "";
      if (!userTxns.length) {
        bookingsBody = `<tr><td colspan="3">Keine Buchungen im Jahr</td></tr>`;
      } else {
        const prodAgg = new Map();
        for (const t of userTxns) {
          if (!prodAgg.has(t.productId)) prodAgg.set(t.productId, { count: 0, sum: 0 });
          const aggregate = prodAgg.get(t.productId);
          aggregate.count += 1;
          aggregate.sum += t.priceCents || 0;
        }

        for (const product of products) {
          const aggregate = prodAgg.get(product.id);
          if (!aggregate) continue;
          totalCount += aggregate.count;
          totalSum += aggregate.sum;
          bookingsBody += `<tr><td>${product.name}</td><td>${aggregate.count}</td><td>${fmtEUR(aggregate.sum)}</td></tr>`;
        }
        for (const [productId, aggregate] of prodAgg.entries()) {
          if (productsById.has(productId)) continue;
          totalCount += aggregate.count;
          totalSum += aggregate.sum;
          bookingsBody += `<tr><td>${productId}</td><td>${aggregate.count}</td><td>${fmtEUR(aggregate.sum)}</td></tr>`;
        }
      }

      let totalPay = 0;
      let paymentsBody = "";
      if (!userPayments.length) {
        paymentsBody = `<tr><td colspan="3">Keine Zahlungen im Jahr</td></tr>`;
      } else {
        for (const payment of userPayments) {
          const when = new Date(payment.ts).toLocaleString("de-DE");
          const note = payment.note ? payment.note : "—";
          const amount = payment.amountCents || 0;
          totalPay += amount;
          paymentsBody += `<tr><td>${when}</td><td>${note}</td><td>${fmtEUR(amount)}</td></tr>`;
        }
      }

      return `
        <table><thead><tr><th>Produkt</th><th>Anzahl</th><th>Summe</th></tr></thead><tbody>${bookingsBody}</tbody>
          <tfoot><tr><td><b>Summe Buchungen</b></td><td><b>${totalCount}</b></td><td><b>${fmtEUR(totalSum)}</b></td></tr></tfoot></table>
        <table><thead><tr><th>Datum</th><th>Notiz</th><th>Betrag</th></tr></thead><tbody>${paymentsBody}</tbody>
          <tfoot><tr><td colspan="2"><b>Summe Zahlungen</b></td><td><b>${fmtEUR(totalPay)}</b></td></tr></tfoot></table>`;
    };

    for (const user of visibleUsers) {
      const userTxns = txnsByUser.get(user.id) || [];
      const userPayments = paymentsByUser.get(user.id) || [];
      const purchases = revenueByUser.get(user.id) || 0;
      const details = document.createElement("details");
      details.className = "monthlyUser card compact";
      details.innerHTML = `
        <summary><span><strong>${user.name || user.id}</strong><small>${user.id} · ${userTxns.length} Buchungen</small></span><b>${fmtEUR(purchases)}</b></summary>
        <div class="monthlyUserDetails"></div>`;
      details.addEventListener("toggle", () => {
        const body = details.querySelector(".monthlyUserDetails");
        if (details.open && !body.dataset.loaded) {
          body.innerHTML = buildUserDetails(userTxns, userPayments);
          body.dataset.loaded = "true";
        }
      });
      usersHost.appendChild(details);
    }
  };

  const loadYearSummary = async (yearValue) => {
    if (summaryLoading || loadedYear !== yearValue) return;
    summaryLoading = true;
    toggle.disabled = true;
    toggle.textContent = "Gesamtübersicht wird geladen …";
    const year = parseInt(yearValue, 10);
    const periodStart = new Date(year, 0, 1).getTime();
    const periodEnd = new Date(year + 1, 0, 1).getTime();
    try {
      if (loadedYear !== yearValue || select.value !== key) return;
      const totalBookings = selectedTxns.length;
      const totalPurchases = selectedTxns.reduce((sum,t)=>sum+(t.priceCents||0),0);
      const totalPayments = selectedPayments.reduce((sum,p)=>sum+(p.amountCents||0),0);
      summary.innerHTML = `
        <div class="card compact"><div class="muted">Buchungen</div><div class="kpi">${totalBookings}</div></div>
        <div class="card compact"><div class="muted">Produktumsatz</div><div class="kpi">${fmtEUR(totalPurchases)}</div></div>
        <div class="card compact"><div class="muted">Nutzerzahlungen</div><div class="kpi">${fmtEUR(totalPayments)}</div></div>`;
      summaryLoadedYear = yearValue;
    } finally {
      summaryLoading = false;
      toggle.disabled = false;
      toggle.textContent = summary.classList.contains("hidden")
        ? "Gesamtübersicht anzeigen"
        : "Gesamtübersicht ausblenden";
    }
  };

  const loadYear = async (yearValue) => {
    if (loading) return;
    loading = true;
    toggle.disabled = true;
    select.disabled = true;
    usersHost.innerHTML = `<div class="card muted">Nutzerliste wird geladen …</div>`;
    const year = parseInt(yearValue, 10);
    const start = new Date(year, 0, 1).getTime();
    const end = new Date(year + 1, 0, 1).getTime() - 1;
    try {
      const referencePromise = referenceDataLoaded
        ? Promise.resolve([users, products])
        : Promise.all([DB.getAll("users"), DB.getAll("products")]);
      const [txns, payments, referenceData] = await Promise.all([
        DB.getAllByIndexRange("txns", "ts", start, end),
        DB.getAllByIndexRange("payments", "ts", start, end),
        referencePromise
      ]);
      [users, products] = referenceData;
      if (!referenceDataLoaded) {
        users.sort((a,b)=> (a.name||"").localeCompare(b.name||"", "de-DE"));
        products.sort((a,b)=> (a.sortOrder||0) - (b.sortOrder||0));
        productsById = new Map(products.map(p => [p.id, p]));
        referenceDataLoaded = true;
      }
      selectedTxns = txns.filter(t => !t.voidedAt);
      selectedPayments = payments.filter(payment => !payment.voidedAt);
      loadedYear = yearValue;
      renderYear();
    } finally {
      loading = false;
      toggle.disabled = false;
      select.disabled = false;
      toggle.textContent = summary.classList.contains("hidden")
        ? "Gesamtübersicht anzeigen"
        : "Gesamtübersicht ausblenden";
    }
  };

  results.classList.remove("hidden");
  summary.classList.add("hidden");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Gesamtübersicht anzeigen";
  summary.innerHTML = "";
  usersHost.innerHTML = "";
  search.value = "";
  toggle.onclick = async () => {
    touch();
    const opening = summary.classList.contains("hidden");
    summary.classList.toggle("hidden", !opening);
    toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    toggle.textContent = opening ? "Gesamtübersicht ausblenden" : "Gesamtübersicht anzeigen";
    if (opening && summaryLoadedYear !== select.value) await loadYearSummary(select.value);
  };
  select.onchange = async () => {
    touch();
    summary.classList.add("hidden");
    summary.innerHTML = "";
    summaryLoadedYear = null;
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Gesamtübersicht anzeigen";
    await loadYear(select.value);
  };
  search.oninput = () => {
    if (loadedYear === select.value) renderYear();
  };
  await loadYear(select.value);
}


async function getTestUserResetPreview(userId) {
  if (!userId) return null;
  const user = await DB.get("users", userId);
  if (!user?.isTestUser) return null;
  const [txns, payments] = await Promise.all([
    DB.getAllByIndex("txns", "userId", userId),
    DB.getAllByIndex("payments", "userId", userId)
  ]);
  const activeTxns = txns.filter(txn => !txn.voidedAt);
  const activePayments = payments.filter(payment => !payment.voidedAt);
  return {
    user,
    txnCount: txns.length,
    activeTxnCount: activeTxns.length,
    revenueCents: activeTxns.reduce((sum, txn) => sum + (Number(txn.priceCents) || 0), 0),
    paymentCount: payments.length,
    paymentCents: activePayments.reduce((sum, payment) => sum + (Number(payment.amountCents) || 0), 0)
  };
}

async function updateTestUserResetSummary() {
  const select = $("#testUserResetSelect");
  const summary = $("#testUserResetSummary");
  const button = $("#btnResetTestUser");
  if (!select || !summary || !button || !select.value) return;
  const preview = await getTestUserResetPreview(select.value);
  if (!preview) {
    summary.textContent = "Der ausgewählte Nutzer ist nicht mehr als Testnutzer markiert.";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  summary.textContent = `${preview.txnCount} Buchungen (${preview.activeTxnCount} aktiv) · ${fmtEUR(preview.revenueCents)} Umsatz · ${preview.paymentCount} Zahlungen (${fmtEUR(preview.paymentCents)})`;
}

async function refreshTestUserReset() {
  const panel = $("#testUserResetPanel");
  const select = $("#testUserResetSelect");
  const summary = $("#testUserResetSummary");
  const button = $("#btnResetTestUser");
  if (!panel || !select || !summary || !button) return;
  const unlocked = featureIsUnlocked("testUsers");
  panel.classList.toggle("hidden", !unlocked);
  if (!unlocked) return;

  const previous = select.value;
  const users = (await DB.getAll("users"))
    .filter(user => user.isTestUser)
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "de-DE"));
  select.innerHTML = "";
  if (!users.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Kein Testnutzer markiert";
    select.appendChild(option);
    select.disabled = true;
    button.disabled = true;
    summary.textContent = "Testnutzer werden in der Nutzerverwaltung beim Bearbeiten eines Nutzers markiert.";
    return;
  }
  for (const user of users) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.name} (${user.id})`;
    select.appendChild(option);
  }
  if (users.some(user => user.id === previous)) select.value = previous;
  select.disabled = false;
  button.disabled = false;
  await updateTestUserResetSummary();
}

function fillSelect(el, options, value) {
  el.innerHTML = "";
  options.forEach(o => {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.label;
    if (String(o.value) === String(value)) opt.selected = true;
    el.appendChild(opt);
  });
}

async function refreshAdminSettings() {
  await loadTimeoutSettings();
  await loadAppName();
  setFooter();
  $("#setAppName").value = appName;

  const userOpts = [];
  for (let s=10; s<=120; s+=5) userOpts.push({ value: s*1000, label: `${s} Sekunden` });
  fillSelect($("#setUserTimeout"), userOpts, TIMEOUTS.userAutoLogoutMs);
  const adminOpts = [
    { value: 0, label: "deaktiviert" },
    { value: 60000, label: "1 Minute" },
    { value: 180000, label: "3 Minuten" },
    { value: 300000, label: "5 Minuten" },
    { value: 600000, label: "10 Minuten" },
    { value: 1800000, label: "30 Minuten" }
  ];
  fillSelect($("#setAdminTimeout"), adminOpts, await DB.getSetting("adminTimeoutMs", 60000));
  const idleOpts = [
    { value: 10000, label: "10 Sekunden" },
    { value: 15000, label: "15 Sekunden" },
    { value: 20000, label: "20 Sekunden" },
    { value: 30000, label: "30 Sekunden" },
    { value: 60000, label: "60 Sekunden" }
  ];
  fillSelect($("#setIdleReset"), idleOpts, await DB.getSetting("idleInputResetMs", TIMEOUTS.idleInputResetMs));
  // Sound
  const soundVal = String(await DB.getSetting("soundEnabled", true));
  $("#setSound").value = (soundVal === "false") ? "false" : "true";
  const themeRow = $("#themeSettingRow");
  themeRow?.classList.toggle("hidden", !featureIsUnlocked("themes"));
  if (featureIsUnlocked("themes") && $("#setTheme")) {
    $("#setTheme").value = normalizeTheme(await DB.getSetting("theme", "light"));
  }
  $("#settingsMsg").textContent = "";
  refreshUnlockPage();
  await refreshAdminNotifications();
  await refreshAdminMaintenance();
}

async function refreshAdminNotifications() {
  const options = [];
  for (let seconds = 1; seconds <= 10; seconds += 1) {
    options.push({ value: seconds * 1000, label: `${seconds} ${seconds === 1 ? "Sekunde" : "Sekunden"}` });
  }
  fillSelect($("#setToastSuccess"), options, toastDurations.success);
  fillSelect($("#setToastInfo"), options, toastDurations.info);
  fillSelect($("#setToastWarning"), options, toastDurations.warning);
  fillSelect($("#setToastError"), options, toastDurations.error);
  $("#notificationsMsg").textContent = "";
}

async function refreshAdminMaintenance() {
  await Promise.all([
    refreshAdminDiagnose(),
    refreshTestUserReset(),
    refreshLocalBuildStatus()
  ]);
}

// ---------- Benachrichtigungen ----------
const TOAST_TYPES = {
  success: { icon:"✓" },
  info: { icon:"i" },
  warning: { icon:"!" },
  error: { icon:"×" }
};

const TOAST_DEFAULT_DURATIONS = {
  success: 3000,
  info: 3000,
  warning: 4000,
  error: 5000
};

const toastDurations = { ...TOAST_DEFAULT_DURATIONS };

function normalizeToastDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1000 && duration <= 10000 ? duration : fallback;
}

async function loadToastSettings() {
  const keys = {
    success: "toastSuccessMs",
    info: "toastInfoMs",
    warning: "toastWarningMs",
    error: "toastErrorMs"
  };
  const values = await Promise.all(Object.entries(keys).map(async ([type, key]) => [
    type,
    await DB.getSetting(key, TOAST_DEFAULT_DURATIONS[type])
  ]));
  for (const [type, value] of values) {
    toastDurations[type] = normalizeToastDuration(value, TOAST_DEFAULT_DURATIONS[type]);
  }
}

function updateToastPosition() {
  const toast = $("#toast");
  const topbar = document.querySelector(".topbar");
  const logoutHint = $("#logoutHint");
  if (!toast || !topbar) return;

  let anchorBottom = topbar.getBoundingClientRect().bottom;
  if (logoutHint && !logoutHint.classList.contains("hidden")) {
    anchorBottom = Math.max(anchorBottom, logoutHint.getBoundingClientRect().bottom);
  }
  toast.style.setProperty("--toast-top", `${Math.max(10, Math.round(anchorBottom + 10))}px`);
}

function displayToast(type, textLength = 0) {
  const toast = $("#toast");
  const config = TOAST_TYPES[type] || TOAST_TYPES.info;
  const baseDurationMs = toastDurations[type] || toastDurations.info;
  const durationMs = type === "error" && textLength > 60 ? Math.min(10000, baseDurationMs + 1000) : baseDurationMs;

  toast.classList.remove("toast--success", "toast--info", "toast--warning", "toast--error");
  toast.classList.add(`toast--${TOAST_TYPES[type] ? type : "info"}`);
  toast.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
  $("#toastIcon").textContent = config.icon;

  updateToastPosition();
  toast.classList.remove("hidden");
  toast.style.animation = "none";
  void toast.offsetWidth;
  toast.style.animation = "";

  if (session.toastTimer) clearTimeout(session.toastTimer);
  session.toastTimer = setTimeout(hideToast, durationMs);
}

function showToast(text, type = "info") {
  $("#toastText").textContent = text;
  displayToast(type, String(text || "").length);
}

function hideToast() {
  $("#toast").classList.add("hidden");
  if (session.toastTimer) clearTimeout(session.toastTimer);
  session.toastTimer = null;
}

function showBookingToast(productName, priceCents, displaySaldo) {
  const textEl = $("#toastText");
  textEl.textContent = "";

  const title = document.createElement("div");
  title.className = "bookingToastTitle";
  title.textContent = `${productName} für ${fmtEUR(priceCents)} gebucht`;

  const meta = document.createElement("div");
  meta.className = "bookingToastMeta";
  meta.appendChild(document.createTextNode("Neuer Saldo: "));

  const saldo = document.createElement("span");
  saldo.className = "toastBalance";
  saldo.classList.toggle("pos", displaySaldo > 0);
  saldo.classList.toggle("neg", displaySaldo < 0);
  saldo.textContent = formatSaldo(displaySaldo);
  meta.appendChild(saldo);

  textEl.appendChild(title);
  textEl.appendChild(meta);
  displayToast("success", title.textContent.length + meta.textContent.length);
}

function showVoidToast(productName, priceCents, displaySaldo) {
  const textEl = $("#toastText");
  textEl.textContent = "";

  const title = document.createElement("div");
  title.className = "bookingToastTitle";
  title.textContent = `${productName} für ${fmtEUR(priceCents)} storniert`;

  const meta = document.createElement("div");
  meta.className = "bookingToastMeta";
  meta.appendChild(document.createTextNode("Neuer Saldo: "));

  const saldo = document.createElement("span");
  saldo.className = "toastBalance";
  saldo.classList.toggle("pos", displaySaldo > 0);
  saldo.classList.toggle("neg", displaySaldo < 0);
  saldo.textContent = formatSaldo(displaySaldo);
  meta.appendChild(saldo);

  textEl.appendChild(title);
  textEl.appendChild(meta);
  displayToast("success", title.textContent.length + meta.textContent.length);
}

window.addEventListener("resize", updateToastPosition);
window.addEventListener("scroll", () => {
  if (!$("#toast")?.classList.contains("hidden")) updateToastPosition();
}, { passive:true });

async function loadTimeoutSettings() {
  TIMEOUTS.userAutoLogoutMs = await DB.getSetting("userTimeoutMs", TIMEOUTS.userAutoLogoutMs);
  const adminMs = await DB.getSetting("adminTimeoutMs", 60000);
  TIMEOUTS.adminAutoLogoutMs = adminMs === 0 ? 0 : adminMs;
  TIMEOUTS.idleInputResetMs = await DB.getSetting("idleInputResetMs", TIMEOUTS.idleInputResetMs);
}

let __audioCtx = null;
function prepareAudioContext(){
  if (!soundEnabled) return Promise.resolve();
  try {
    __audioCtx = __audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (__audioCtx.state === "suspended") return __audioCtx.resume().catch(() => {});
  } catch (e) {}
  return Promise.resolve();
}

async function beep(kind="ok"){
  if (!soundEnabled) return;
  try{
    await prepareAudioContext();
    const ctx = __audioCtx;
    if (!ctx || ctx.state !== "running") return;
    if (kind === "err") {
      const now = ctx.currentTime;
      const warningBursts = [
        { start: now, frequency: 880 },
        { start: now + 0.34, frequency: 740 }
      ];
      warningBursts.forEach(({ start, frequency }) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.setValueAtTime(frequency, start);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.42, start + 0.012);
        g.gain.setValueAtTime(0.42, start + 0.18);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        o.connect(g); g.connect(ctx.destination);
        o.start(start);
        o.stop(start + 0.23);
      });
      return;
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 520;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.20, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.10);
    o.start(now);
    o.stop(now + 0.12);
  }catch(e){}
}

function confirmModal(title, body, okLabel="OK"){
  return new Promise((resolve)=>{
    const dangerousAction = /lösch|entfern|zurücksetz|storn|cache (?:leeren|erneuern)/i.test(okLabel);
    const formattedBody = escapeHtml(body)
      .replace(/([+-]?\d{1,3}(?:\.\d{3})*,\d{2}\s*€)/g, '<strong class="confirmAmount">$1</strong>')
      .replace(/&quot;([^&]+)&quot;/g, '<strong class="confirmSubject">$1</strong>');
    openModal({
      title,
      modalClass: "confirmModal",
      bodyHtml: `<div class="confirmText">${formattedBody}</div>`,
      actions: [
        { label:"Abbrechen", onClick: async ()=>{ closeModal(); resolve(false); } },
        { label: okLabel, primary:!dangerousAction, danger:dangerousAction, onClick: async ()=>{ closeModal(); resolve(true); } }
      ]
    });
  });
}

function showProductPressFeedback(el) {
  if (!el) return;
  clearTimeout(el._productPressTimer);
  el.classList.remove("productPressed");
  void el.offsetWidth;
  el.classList.add("productPressed");
  el._productPressTimer = setTimeout(() => el.classList.remove("productPressed"), 180);
}

function attachTap(el, fn){
  // Each tile handles its own input. A global debounce would swallow a valid
  // fast tap on a different product.
  const handler = (event)=>{
    event?.preventDefault?.();
    showProductPressFeedback(el);
    fn();
  };
  if (window.PointerEvent){
    el.addEventListener("pointerdown", () => showProductPressFeedback(el));
    el.addEventListener("pointerup", handler);
  } else {
    el.addEventListener("touchstart", () => showProductPressFeedback(el), { passive:true });
    el.addEventListener("click", handler);
  }
}


// ---------------------------
// Reconnect trigger when Fully wakes up / tab returns
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    handleRuntimeActivation().catch(console.error);
  }
});
window.addEventListener("focus", () => {
  handleRuntimeActivation().catch(console.error);
});


// ---------- Wiring ----------
async function init() {
  await ensureSeed();
  await loadUnlockedFeatures();
  await loadTimeoutSettings();
  await loadToastSettings();
  await loadThemeSetting();
  await loadAppName();
  soundEnabled = String(await DB.getSetting("soundEnabled", true)) !== "false";
  startBatteryUpdates();
  setFooter();

  // Build keypads
  buildKeypad("#keypad", onPinDigit);
  buildKeypad("#adminKeypad", onAdminDigit);
  enableLoginButtonFeedback();

  // Buttons
  $("#appFooterText").addEventListener("click", ()=>{ touch(); showCopyrightInfo(); });
  $("#btnClear").addEventListener("click", ()=>{ touch(); pinBuffer=""; renderPinDots("#pinDots",0); });
  $("#btnOk").addEventListener("click", async ()=> {
    touch();
    const id = pinBuffer;
    pinBuffer = "";
    renderPinDots("#pinDots",0);
    await handleCredential({ type:"pin", value:id });
  });
  $("#btnAdmin").addEventListener("click", ()=>{ touch(); enterAdminLogin(); });
  $("#btnConfirmUnlock").addEventListener("click", async ()=>{ touch(); await submitUnlockCode(); });
  $("#unlockCode").addEventListener("keydown", async event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    touch();
    await submitUnlockCode();
  });

  $("#btnAdminBack").addEventListener("click", ()=>{ touch(); enterIdle(); });
  $("#btnAdminClear").addEventListener("click", ()=>{
    touch();
    adminBuffer = "";
    renderPinDots("#adminDots", 0, 6);
    $("#adminLoginError").classList.add("hidden");
  });
  $("#btnAdminLogin").addEventListener("click", async ()=> {
    touch();
    // Must happen directly inside the tap event. Fully/Android may otherwise
    // block Web Audio after the asynchronous database lookup below.
    const audioReady = prepareAudioContext();
    const pass = adminBuffer;
    adminBuffer = "";
    renderPinDots("#adminDots",0,6);
    const real = String(await DB.getSetting("adminPassword", "999999"));
    if (!/^\d{6}$/.test(pass) || !/^\d{6}$/.test(real) || pass !== real) {
      showToast("Falsche Admin-PIN.", "error");
      await audioReady;
      await beep("err");
      return;
    }
    enterAdmin();
  });

  $("#btnLogout").addEventListener("click", ()=>{ touch(); enterIdle(); });
  $("#btnAdminScrollTop").addEventListener("click", ()=>{
    touch();
    try {
      window.scrollTo({ top:0, left:0, behavior:"smooth" });
    } catch (_) {
      window.scrollTo(0, 0);
    }
  });
  $("#btnShowTodayTxns").addEventListener("click", async () => {
    await toggleTodayUserTxns();
  });
  $("#btnPersonalReport")?.addEventListener("click", openPersonalReport);
  ["#auditUserFilter", "#auditStatusFilter", "#auditDateFrom", "#auditDateTo"].forEach(selector => {
    $(selector)?.addEventListener("change", async () => { touch(); await refreshAdminAudit(); });
  });
  $("#btnAuditToday").addEventListener("click", async () => {
    touch();
    await resetAdminAuditToToday();
  });
  // Modal close on overlay click
  $("#modalOverlay").addEventListener("click", (e)=> {
    if (e.target.id === "modalOverlay") closeModal();
  });

  // Admin actions
  $("#btnSaveSettings").addEventListener("click", async ()=> {
    touch();
    const requestedName = normalizeAppName($("#setAppName").value);
    await DB.setSetting("appName", requestedName);
    applyAppName(requestedName);
    await DB.setSetting("userTimeoutMs", parseInt($("#setUserTimeout").value,10));
    await DB.setSetting("adminTimeoutMs", parseInt($("#setAdminTimeout").value,10));
    await DB.setSetting("idleInputResetMs", parseInt($("#setIdleReset").value,10));
    soundEnabled = $("#setSound").value === "true";
    await DB.setSetting("soundEnabled", soundEnabled);
    if (featureIsUnlocked("themes") && $("#setTheme")) {
      await DB.setSetting("theme", normalizeTheme($("#setTheme").value));
      await loadThemeSetting();
    }
    await loadTimeoutSettings();
    setFooter();
    showToast("Einstellungen gespeichert", "success");
  });
  $("#btnSaveNotifications").addEventListener("click", async ()=> {
    touch();
    const values = {
      success: normalizeToastDuration($("#setToastSuccess").value, TOAST_DEFAULT_DURATIONS.success),
      info: normalizeToastDuration($("#setToastInfo").value, TOAST_DEFAULT_DURATIONS.info),
      warning: normalizeToastDuration($("#setToastWarning").value, TOAST_DEFAULT_DURATIONS.warning),
      error: normalizeToastDuration($("#setToastError").value, TOAST_DEFAULT_DURATIONS.error)
    };
    await Promise.all([
      DB.setSetting("toastSuccessMs", values.success),
      DB.setSetting("toastInfoMs", values.info),
      DB.setSetting("toastWarningMs", values.warning),
      DB.setSetting("toastErrorMs", values.error)
    ]);
    Object.assign(toastDurations, values);
    showToast("Benachrichtigungszeiten gespeichert", "success");
  });
  $("#btnReloadApp").addEventListener("click", async ()=> {
    touch();
    const ok = await confirmModal("App neu starten", "Die App wird neu geladen (Daten bleiben erhalten).", "Neu starten");
    if (ok) location.reload();
  });
  $("#btnRunSystemCheck")?.addEventListener("click", async ()=> { touch(); await runSystemCheck(); });
  $("#btnOpenSystemCheck")?.addEventListener("click", async ()=> {
    touch();
    showAdminTab("settings");
    $("#maintenancePanel").open = true;
    await runSystemCheck();
    $("#systemCheckResult")?.scrollIntoView?.({ behavior:"smooth", block:"center" });
  });
  $("#testUserResetSelect")?.addEventListener("change", async ()=>{
    touch();
    await updateTestUserResetSummary();
  });
  $("#btnResetTestUser")?.addEventListener("click", async ()=>{
    touch();
    const userId = $("#testUserResetSelect")?.value;
    const preview = await getTestUserResetPreview(userId);
    if (!preview) {
      showToast("Testnutzer nicht gefunden", "error");
      await refreshTestUserReset();
      return;
    }
    const confirmed = await confirmModal(
      "Testnutzer zurücksetzen",
      `${preview.user.name} (${preview.user.id}) wirklich zurücksetzen? ${preview.txnCount} Buchungen und ${preview.paymentCount} Zahlungen werden gelöscht. Verbrauchte Bestände werden zurückgebucht. Nutzername, ID und Testnutzer-Markierung bleiben erhalten.`,
      "Zurücksetzen"
    );
    if (!confirmed) return;
    try {
      const result = await DB.resetTestUserAtomic(userId);
      showToast(`${result.userName} wurde zurückgesetzt`, "success");
      await Promise.all([refreshAdminOverview(), refreshAdminUsers(), refreshAdminPayments(false), refreshAdminMaintenance()]);
    } catch (error) {
      console.error("Test user reset failed", error);
      showToast("Testnutzer konnte nicht zurückgesetzt werden: " + (error?.message || String(error)), "error");
    }
  });
  $("#btnFactoryReset")?.addEventListener("click", async ()=>{
    touch();
    openModal({
      title: "Werkseinstellungen",
      bodyHtml: '<div class="dangerText"><b>Achtung:</b> Alle Produkte, Nutzer, Buchungen, Zahlungen, Einstellungen und Freischaltungen werden unwiderruflich gelöscht. KassenWart startet anschließend leer mit den Standardwerten.</div>',
      actions: [
        { label:"Abbrechen", onClick: async ()=>closeModal() },
        { label:"Alles löschen & zurücksetzen", danger:true, onClick: async ()=>{
          try {
            sessionStorage.setItem("kassenwartFactoryResetComplete", "1");
            await DB.resetDatabase();
            location.reload();
          } catch (error) {
            sessionStorage.removeItem("kassenwartFactoryResetComplete");
            console.error("Factory reset failed", error);
            showToast("Werkseinstellungen konnten nicht wiederhergestellt werden: " + (error?.message || String(error)), "error");
          }
        } }
      ]
    });
  });

  $("#btnChangeAdminPw").addEventListener("click", async ()=> {
    touch();
    const err = $("#pwError");
    err.classList.add("hidden");
    const oldPw = $("#pwOld").value.trim();
    const n1 = $("#pwNew1").value.trim();
    const n2 = $("#pwNew2").value.trim();
    const real = String(await DB.getSetting("adminPassword", "999999"));
    if (!/^\d{6}$/.test(oldPw) || !/^\d{6}$/.test(real) || oldPw !== real) { showToast("Die bisherige Admin-PIN stimmt nicht.", "error"); return; }
    if (!/^\d{6}$/.test(n1)) { showToast("Die neue Admin-PIN muss genau 6 Ziffern haben.", "warning"); return; }
    if (n1 !== n2) { showToast("Die beiden neuen Admin-PINs stimmen nicht überein.", "warning"); return; }
    await DB.setSetting("adminPassword", n1);
    $("#pwOld").value=""; $("#pwNew1").value=""; $("#pwNew2").value="";
    showToast("Admin-PIN geändert", "success");
  });

  $("#btnAddUser").addEventListener("click", async ()=> {
    touch();
    const id = $("#newUserId").value.trim();
    const name = $("#newUserName").value.trim();
    const err = $("#addUserError");
    err.classList.add("hidden");

    if (!/^\d{4}$/.test(id)) { showToast("Die Nutzer-ID muss genau 4 Ziffern haben.", "warning"); return; }
    if (!name) { showToast("Bitte einen Namen eingeben.", "warning"); return; }
    const exists = await DB.get("users", id);
    if (exists) { showToast("Diese Nutzer-ID existiert bereits.", "error"); return; }

    try {
      await DB.put("users", { id, name, active:true, isTestUser:false });
      $("#newUserId").value = ""; $("#newUserName").value="";
      await refreshAdminUsers();
      showToast("Nutzer angelegt", "success");
    } catch (e) {
      console.error("Create user failed", e);
      showToast("Nutzer konnte nicht angelegt werden: " + (e?.message || String(e)), "error");
    }
  });

  $("#payUser").addEventListener("change", async ()=> { touch(); await updatePayOpen(); });
  $("#btnFillAll").addEventListener("click", async ()=> {
    touch();
    const bal = await updatePayOpen();
    if (bal > 0) $("#payAmount").value = (bal/100).toFixed(2).replace(".",",");
  });

  $("#btnAddPayment").addEventListener("click", async ()=> {
    touch();
    const userId = $("#payUser").value;
    const raw = $("#payAmount").value.trim();
    const note = $("#payNote").value.trim();
    const err = $("#payError");
    err.classList.add("hidden");

    const num = parseFloat(raw.replace('.',',').replace(',','.'));
    if (!Number.isFinite(num) || num <= 0) { showToast("Bitte einen gültigen Zahlungsbetrag größer 0 eingeben.", "warning"); return; }
    const amountCents = Math.round(num * 100);
    const ok = await confirmModal("Zahlung speichern", `${fmtEUR(amountCents)} wirklich als Zahlung speichern?`, "Speichern");
    if (!ok) return;

    const now = Date.now();
    try {
      await DB.put("payments", { id: safeUUID(), userId, amountCents, ts: now, createdAt: now, note: note || null, voidedAt: null });
      $("#payAmount").value=""; $("#payNote").value="";
      await refreshAdminPayments(false);
      showToast("Zahlung gespeichert", "success");
    } catch (e) {
      console.error("Create payment failed", e);
      showToast("Zahlung konnte nicht gespeichert werden: " + (e?.message || String(e)), "error");
    }
  });

  // timeouts
  setInterval(() => {
    const now = Date.now();
    updateLogoutHint(now);
    if (session.mode === "idle") {
      if (pinBuffer && (now - session.lastActivityMs > TIMEOUTS.idleInputResetMs)) {
        pinBuffer = "";
        renderPinDots("#pinDots",0);
      }
      return;
    }
    if (session.mode === "user" && (now - session.lastActivityMs > TIMEOUTS.userAutoLogoutMs)) enterIdle();
    if (session.mode === "admin" && TIMEOUTS.adminAutoLogoutMs > 0 && (now - session.lastActivityMs > TIMEOUTS.adminAutoLogoutMs)) enterIdle();
  }, 700);

  setInterval(() => {
    if (session.mode === "idle") updateIdleClock();
  }, 60000);

  enterIdle();
  if (sessionStorage.getItem("kassenwartFactoryResetComplete") === "1") {
    sessionStorage.removeItem("kassenwartFactoryResetComplete");
    openModal({
      title:"Werkseinstellungen wiederhergestellt",
      bodyHtml:'<div>Alle Daten wurden gelöscht und die Standardwerte wiederhergestellt.</div><div class="maintenanceSummary">Admin-Anmeldung: <strong>999999</strong></div>',
      actions:[{ label:"Verstanden", primary:true, onClick: async ()=>closeModal() }]
    });
  }
}

init();
