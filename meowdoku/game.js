"use strict";

// Palette from github.com/yocox/meowdoku/issues/1 ("bright12"). It is two rings
// of six: a light and a dark version of the same six hues (紅 橘 黃 青 藍 紫).
//
// The order below looks shuffled but is not — it is the ring order permuted by
// slot = (regionId * 7) % 12, baked in. Regions are handed out in order, so
// consecutive ids would otherwise land on neighbouring hues, the hardest pair
// to tell apart side by side. A stride of 7 is coprime with 12, so every slot
// is still used exactly once while consecutive ids always land 5 slots apart —
// the widest separation a 12-colour cycle allows. Re-sorting this list back
// into hue order would silently destroy that, so don't.
//
// This is the factory default. The active palette (REGION_COLORS below) can
// be overwritten by the user via the palette editor in Settings; this array
// is what "恢復預設" restores.
const DEFAULT_REGION_COLORS = [
  "#FF9676",  // 亮紅
  "#B66C00",  // 暗橘
  "#BCDD76",  // 亮黃
  "#009865",  // 暗青
  "#41D1FF",  // 亮藍
  "#946DC5",  // 暗紫
  "#C25A6F",  // 暗紅
  "#FDC35E",  // 亮橘
  "#828900",  // 暗黃
  "#4FEACF",  // 亮青
  "#3584CD",  // 暗藍
  "#FF9FDB",  // 粉桃
];

// Same twelve, dimmed for crossed-out cells: OKLab lightness ×0.7, chroma ×0.5.
// Scaling in OKLab rather than with `filter: brightness() saturate()` matters —
// that filter works in sRGB, which washes the light ring out to a flat grey
// instead of a dimmer version of itself. OKLab's separate lightness and chroma
// axes keep the hue, so a crossed-out cell still reads as its own region.
// Precomputed because the input is a fixed list; a custom palette's dimmed
// variant is instead computed at runtime by dimColor() below, using the same
// OKLab math (verified to reproduce this table exactly).
const DEFAULT_REGION_COLORS_DIM = [
  "#926253",  // 亮紅
  "#664522",  // 暗橘
  "#778659",  // 亮黃
  "#275841",  // 暗青
  "#467E93",  // 亮藍
  "#57466D",  // 暗紫
  "#6D3D45",  // 暗紅
  "#957A50",  // 亮橘
  "#4E5223",  // 暗黃
  "#4F8C7F",  // 亮青
  "#2F5071",  // 暗藍
  "#946883",  // 粉桃
];

// Active palette. Starts as the defaults; loadPalette() below overwrites both
// arrays in place if the user saved a custom palette in an earlier session.
let REGION_COLORS = DEFAULT_REGION_COLORS.slice();
let REGION_COLORS_DIM = DEFAULT_REGION_COLORS_DIM.slice();

const EMPTY = 0, MARK = 1, CAT = 2, HYPO = 3, WRONG = 4;
const HEARTS_MAX = 3;
const DOUBLE_TAP_MS = 300;
const DRAG_THRESHOLD_PX = 6;

// ── Color math (sRGB <-> linear <-> OKLab) ──────────────────────────────────
// Used to derive a dimmed variant of any user-chosen region color. Matrices
// from Björn Ottosson's OKLab writeup; verified against DEFAULT_REGION_COLORS_DIM
// above (same ×0.7 lightness / ×0.5 chroma scaling) before wiring this up.

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
  const h = (v) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}
function linearRgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}
function oklabToLinearRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}
function dimColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  let { L, a, b: bb } = linearRgbToOklab(lr, lg, lb);
  L *= 0.7; a *= 0.5; bb *= 0.5;
  const o = oklabToLinearRgb(L, a, bb);
  return rgbToHex(linearToSrgb(o.r), linearToSrgb(o.g), linearToSrgb(o.b));
}

// ── Custom palette persistence ──────────────────────────────────────────────

function loadPalette() {
  try {
    const raw = JSON.parse(localStorage.getItem("meowdoku_palette") || "null");
    if (Array.isArray(raw) && raw.length === 12 && raw.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) {
      REGION_COLORS = raw.slice();
      REGION_COLORS_DIM = REGION_COLORS.map(dimColor);
    }
  } catch { }
}
function savePalette() {
  try { localStorage.setItem("meowdoku_palette", JSON.stringify(REGION_COLORS)); } catch { }
}
function refreshBoardColors() {
  if (!state.n) return;
  for (let r = 0; r < state.n; r++) for (let c = 0; c < state.n; c++) updateCellView(r, c);
}
function setPaletteColor(idx, hex) {
  REGION_COLORS[idx] = hex;
  REGION_COLORS_DIM[idx] = dimColor(hex);
  savePalette();
  refreshBoardColors();
}
function resetPalette() {
  REGION_COLORS = DEFAULT_REGION_COLORS.slice();
  REGION_COLORS_DIM = DEFAULT_REGION_COLORS_DIM.slice();
  try { localStorage.removeItem("meowdoku_palette"); } catch { }
  renderPaletteEditor();
  refreshBoardColors();
}
loadPalette();

// User-facing toggles — persisted across sessions.
const settings = (() => {
  try {
    const s = JSON.parse(localStorage.getItem("meowdoku_settings") || "{}");
    return { sound: s.sound !== false, vibrate: s.vibrate !== false, autoElim: !!s.autoElim, hypo: !!s.hypo, showHelp: s.showHelp !== false, copyAscii: !!s.copyAscii, dimMarked: s.dimMarked !== false, showAnalysis: !!s.showAnalysis };
  } catch { return { sound: true, vibrate: true, autoElim: false, hypo: false, showHelp: true, copyAscii: false, dimMarked: true, showAnalysis: false }; }
})();

function saveSettings() {
  try { localStorage.setItem("meowdoku_settings", JSON.stringify(settings)); } catch { }
}

// Star tracking: { "<資料夾>:<編號>": 1|2|3 }，key 由 starKey() 算（見那裡的
// 說明：刻意和關卡包無關）。Migrates old array format to object.
function getStars() {
  try {
    const raw = JSON.parse(localStorage.getItem("meowdoku_done") || "{}");
    if (Array.isArray(raw)) { const o = {}; raw.forEach(k => { o[k] = 1; }); return o; }
    return (typeof raw === "object" && raw !== null) ? raw : {};
  } catch { return {}; }
}
function saveStars(id, stars) {
  const data = getStars();
  const key = starKey(id);
  if ((data[key] || 0) < stars) data[key] = stars;
  saveStarsMap(data);
}

function saveStarsMap(data) {
  try { localStorage.setItem("meowdoku_done", JSON.stringify(data)); } catch { }
}

// ── 難度評分 ────────────────────────────────────────────────────────────────
// 過關視窗上的十格，蒐集「人覺得這關多難」。key 和星數同一套（starKey()），
// 但另外存一個 localStorage entry：星數的值是純數字，export/import 兩邊都靠
// 這個形狀驗證，混進物件會讓舊版 client 在匯入時把整筆丟掉。
//
// 一筆 = { r: 1..10 評分, t: 第一次通關用了幾毫秒, at: 評分時間 }
// t 只在第一次通關時寫入：重玩已經解過的關卡一定比較快，那個時間沒有難度訊號。
const RATING_MAX = 10;

function getRatings() {
  try {
    const raw = JSON.parse(localStorage.getItem("meowdoku_ratings") || "{}");
    return (typeof raw === "object" && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

function saveRatingsMap(data) {
  try { localStorage.setItem("meowdoku_ratings", JSON.stringify(data)); } catch { }
}

function recordClear(id, elapsedMs) {
  const data = getRatings();
  const key = starKey(id);
  const rec = data[key] || {};
  if (rec.t === undefined && Number.isFinite(elapsedMs)) rec.t = Math.round(elapsedMs);
  data[key] = rec;
  saveRatingsMap(data);
}

function saveRating(id, value) {
  const data = getRatings();
  const key = starKey(id);
  const rec = data[key] || {};
  rec.r = value;
  rec.at = Date.now();
  data[key] = rec;
  saveRatingsMap(data);
}

function renderRating(id) {
  if (!el.ratingCells) return;
  const mine = getRatings()[starKey(id)]?.r || 0;
  [...el.ratingCells.children].forEach((btn, i) => {
    btn.classList.toggle("selected", i + 1 === mine);
  });
}

function buildRatingCells() {
  if (!el.ratingCells) return;
  el.ratingCells.innerHTML = "";
  for (let v = 1; v <= RATING_MAX; v++) {
    const btn = document.createElement("button");
    btn.textContent = String(v);
    btn.addEventListener("click", () => {
      if (!state.levelId) return;
      saveRating(state.levelId, v);
      renderRating(state.levelId);
    });
    el.ratingCells.appendChild(btn);
  }
}

// ── Progress export / import ────────────────────────────────────────────────
// Export drops the whole star map on the clipboard as JSON; import *merges*
// whatever is pasted back in, keeping the higher star count on every level both
// sides have cleared. Two devices can therefore be synced in either direction
// without a clear ever being lost.
//
// v2 起多帶一份 ratings（過關視窗的十格評分 + 第一次通關用時）。舊版 client 讀
// v2 只會看 stars、忽略 ratings，所以星數不會因為來回同步而掉。
const PROGRESS_FORMAT = 2;
const KEY_RE = /^[a-z0-9]+:[1-9][0-9]*$/i;

async function exportProgress() {
  const stars = getStars();
  const ratings = getRatings();
  const ok = await copyToClipboard(
    JSON.stringify({ v: PROGRESS_FORMAT, stars, ratings }));
  const rated = Object.values(ratings).filter((x) => x?.r).length;
  showToast(ok
    ? `已複製 ${Object.keys(stars).length} 關的進度、${rated} 筆評分`
    : "複製失敗");
}

// Returns { stars, ratings } cleaned, or null if the text is not progress data
// at all. Keys for packs this build does not ship are kept rather than dropped:
// an older client holding a newer one's levels must not erase them on a round trip.
function parseProgress(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (Array.isArray(raw)) raw = { stars: Object.fromEntries(raw.map((k) => [k, 1])) };
  if (!raw || typeof raw !== "object") return null;
  const wrapped = typeof raw.stars === "object" && raw.stars;
  const starsIn = wrapped ? raw.stars : raw;  // 沒包起來的就是純星數 map
  const ratingsIn = (wrapped && typeof raw.ratings === "object" && raw.ratings) || {};
  if (typeof starsIn !== "object") return null;

  const stars = {};
  for (const [key, s] of Object.entries(starsIn)) {
    if (!KEY_RE.test(key)) continue;
    if (!Number.isInteger(s) || s < 1 || s > HEARTS_MAX) continue;
    stars[key] = s;
  }
  const ratings = {};
  for (const [key, rec] of Object.entries(ratingsIn)) {
    if (!KEY_RE.test(key) || !rec || typeof rec !== "object") continue;
    const out = {};
    if (Number.isInteger(rec.r) && rec.r >= 1 && rec.r <= RATING_MAX) out.r = rec.r;
    if (Number.isInteger(rec.t) && rec.t >= 0) out.t = rec.t;
    if (Number.isInteger(rec.at) && rec.at > 0) out.at = rec.at;
    if (Object.keys(out).length) ratings[key] = out;
  }
  return { stars, ratings };
}

// Returns false only when the paste could not be read as progress at all, so the
// caller can leave the text in the box for the user to fix.
function importProgress(text) {
  const incoming = parseProgress(text);
  if (!incoming) { showToast("匯入失敗：格式不對"); return false; }
  const data = getStars();
  let added = 0, improved = 0;
  for (const [key, stars] of Object.entries(incoming.stars)) {
    const have = data[key] || 0;
    if (stars <= have) continue;
    if (have === 0) added++; else improved++;
    data[key] = stars;
  }

  // 評分：at 比較新的贏。t 只補沒有的 —— 已經記著的是那台機器第一次通關的
  // 時間，換成別台的時間只會讓資料變髒。
  const rmap = getRatings();
  let rated = 0;
  for (const [key, rec] of Object.entries(incoming.ratings)) {
    const have = rmap[key] || {};
    let touched = false;
    if (rec.r && (!have.r || (rec.at || 0) > (have.at || 0))) {
      have.r = rec.r;
      have.at = rec.at || Date.now();
      touched = true;
    }
    if (have.t === undefined && rec.t !== undefined) { have.t = rec.t; touched = true; }
    if (touched) { rmap[key] = have; rated++; }
  }

  if (added || improved || rated) {
    if (added || improved) saveStarsMap(data);
    if (rated) saveRatingsMap(rmap);
    refreshDoneMarks();
    showToast(`已合併：新增 ${added} 關、${improved} 關星數提升、${rated} 筆評分`);
  } else {
    showToast("沒有新進度可以合併");
  }
  return true;
}

// Packs shown after the numeric board-size packs, in this order. Their levels
// are mixed-size, so board size comes from each level file rather than the key.
// 關卡包由 web/packs.json 定義（tools/build_packs.py 產生）：難度分數分成六個
// 大類，一個大類裝不下 100 關就切成「簡單 1」「簡單 2」…。一個關卡包就是一串
// 關卡 id，順序沒有意義 —— 以後補關卡、淘汰關卡只要改那串 id。
//
// 關卡 id 就是關卡檔的檔名主幹，例如 level_12_00000999：裡面的 12 是盤面大小
// 也是它放在哪個資料夾，所以 id 自己就能算出檔案路徑。目錄純粹是存放位置
// （順便讓 7000 多個檔案不要擠在一起），不再代表關卡包。
const LEVEL_ID_RE = /^level_([a-z0-9]+)_(\d+)$/i;

// id → { dir, idx }。dir 是資料夾名（盤面大小，或 bad）。
function levelRef(id) {
  const m = LEVEL_ID_RE.exec(id);
  return m ? { dir: m[1], idx: parseInt(m[2], 10) } : null;
}

function levelPath(id) {
  const ref = levelRef(id);
  return ref ? `levels/${ref.dir}/${id}.txt` : null;
}

// 星數的 key 用「資料夾:編號」，和難度分包無關 —— 關卡以後換到別包，紀錄還在。
// 這剛好也是舊版數字關卡包用的 key，所以舊存檔不用搬。
function starKey(id) {
  const ref = levelRef(id);
  return ref ? `${ref.dir}:${ref.idx}` : id;
}

function packLabel(key) {
  return state.packIndex.get(key)?.label ?? key;
}


const state = {
  manifest: null,    // packs.json
  packIndex: null,   // Map: pack key → pack
  levelHome: null,   // Map: 關卡 id → { pack, ordinal }
  pack: null,        // 選到的關卡包 key，例如 "easy-03"
  n: null,
  levelIdx: null,    // 在這一包裡的第幾關（1 起算）
  levelId: null,     // 關卡 id，例如 level_8_00000123 —— 存檔和分享連結用這個
  regions: null,     // n x n array of region ids (0..n-1)
  solution: null,    // solution[row] = column of the true cat
  board: null,       // n x n array of EMPTY/MARK/CAT
  hearts: HEARTS_MAX,
  gameOver: false,
  timerStart: null,     // Date.now() at first board interaction this level, or null
  timerFrozenMs: null,  // elapsed ms once the timer has stopped (win/loss), or null while running
};

const el = {
  packGroups: document.getElementById("pack-groups"),
  levelButtons: document.getElementById("level-buttons"),
  viewPacks: document.getElementById("view-packs"),
  viewLevels: document.getElementById("view-levels"),
  packTitle: document.getElementById("pack-title"),
  btnPackBack: document.getElementById("btn-pack-back"),
  screenSelect: document.getElementById("screen-select"),
  screenGame: document.getElementById("screen-game"),
  appHeader: document.querySelector(".app-header"),
  board: document.getElementById("board"),
  gameTitle: document.getElementById("game-title"),
  timer: document.getElementById("timer"),
  hearts: document.getElementById("hearts"),
  statusBanner: document.getElementById("status-banner"),
  btnBack: document.getElementById("btn-back"),
  btnRestart: document.getElementById("btn-restart"),
  btnUndo: document.getElementById("btn-undo"),
  btnRedo: document.getElementById("btn-redo"),
  winModal: document.getElementById("win-modal"),
  winTime: document.getElementById("win-time"),
  ratingCells: document.getElementById("rating-cells"),
  analysis: document.getElementById("analysis"),
  analysisBody: document.getElementById("analysis-body"),
  btnNextLevel: document.getElementById("btn-next-level"),
  btnReplay: document.getElementById("btn-replay"),
  btnModalBack: document.getElementById("btn-modal-back"),
  helpModal: document.getElementById("help-modal"),
  toast: document.getElementById("toast"),
  btnHelpClose: document.getElementById("btn-help-close"),
  btnToggleHypo: document.getElementById("btn-toggle-hypo"),
  btnSettings: document.getElementById("btn-settings"),
  settingsModal: document.getElementById("settings-modal"),
  btnSettingsClose: document.getElementById("btn-settings-close"),
  btnHelpOpen: document.getElementById("btn-help-open"),
  btnToggleSound: document.getElementById("btn-toggle-sound"),
  btnToggleVibrate: document.getElementById("btn-toggle-vibrate"),
  btnToggleAuto: document.getElementById("btn-toggle-auto"),
  btnToggleCopyAscii: document.getElementById("btn-toggle-copy-ascii"),
  btnToggleDim: document.getElementById("btn-toggle-dim"),
  btnCopyAscii: document.getElementById("btn-copy-ascii"),
  btnCopyLink: document.getElementById("btn-copy-link"),
  paletteEditor: document.getElementById("palette-editor"),
  btnPaletteReset: document.getElementById("btn-palette-reset"),
  btnExportProgress: document.getElementById("btn-export-progress"),
  btnImportProgress: document.getElementById("btn-import-progress"),
  importPanel: document.getElementById("import-panel"),
  importText: document.getElementById("import-text"),
  btnImportCancel: document.getElementById("btn-import-cancel"),
  btnImportConfirm: document.getElementById("btn-import-confirm"),
};

// ── Audio ────────────────────────────────────────────────────────────────────
// All sounds are synthesised with Web Audio API — no external assets needed.

let _ctx = null;
function _getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

function _tone(freq, type, vol, dur, t) {
  const ctx = _getCtx();
  const s = t !== undefined ? t : ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, s);
  gain.gain.setValueAtTime(vol, s);
  gain.gain.exponentialRampToValueAtTime(0.001, s + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(s);
  osc.stop(s + dur);
}

// Short soft tick for marking/unmarking cells (including each cell during drag).
function playMark() { if (settings.sound) _tone(660, "sine", 0.08, 0.10); }

// Warm ding (fundamental + octave) when a cat is placed correctly.
function playCat() {
  if (!settings.sound) return;
  _tone(880, "sine", 0.18, 0.45); _tone(1760, "sine", 0.08, 0.45);
}

// Sharp descending buzz when a cat guess is wrong.
function playWrong() {
  if (!settings.sound) return;
  const ctx = _getCtx(), t = ctx.currentTime;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(240, t);
  osc.frequency.linearRampToValueAtTime(110, t + 0.40);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.40);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(t); osc.stop(t + 0.40);
}

// C-major arpeggio (C E G C) spread over 0.3 s for the win moment.
function playWin() {
  if (!settings.sound) return;
  const ctx = _getCtx(), now = ctx.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => _tone(f, "sine", 0.18, 0.4, now + i * 0.1));
}

// ── Haptic ───────────────────────────────────────────────────────────────────

function vibrate(ms) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(ms); }

// ── Timer ────────────────────────────────────────────────────────────────────
// Starts on the player's first tap/drag on the board, not on level load — so
// the clock doesn't punish thinking ahead before touching anything.

let timerIntervalId = null;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function updateTimerDisplay() {
  if (!el.timer) return;
  if (state.timerStart === null) { el.timer.textContent = "0:00"; return; }
  const elapsed = state.timerFrozenMs !== null ? state.timerFrozenMs : Date.now() - state.timerStart;
  el.timer.textContent = formatElapsed(elapsed);
}
function resetTimer() {
  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
  state.timerStart = null;
  state.timerFrozenMs = null;
  updateTimerDisplay();
}
function startTimerIfNeeded() {
  if (state.timerStart !== null) return;
  state.timerStart = Date.now();
  state.timerFrozenMs = null;
  timerIntervalId = setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();
}
function stopTimer() {
  if (state.timerStart !== null && state.timerFrozenMs === null) {
    state.timerFrozenMs = Date.now() - state.timerStart;
  }
  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
  updateTimerDisplay();
}

// ── Undo / redo ──────────────────────────────────────────────────────────────
// Each move is a list of {r, c, prev, cur} cell diffs plus `cost`, the hearts
// that move spent. A "move" spans one user gesture (a tap, a drag, or a resolved
// double-tap cat placement) so one Undo click reverts exactly what the player
// perceives as one action.
//
// Hearts are deliberately outside the undo/redo model: Undo never refunds one,
// and Redo charges it again. A wrong guess is paid for once and stays paid.

let undoStack = [];
let redoStack = [];
let currentMove = null;

function beginMove() {
  currentMove = { diffMap: new Map(), heartsBefore: state.hearts };
}
function setCell(r, c, val) {
  if (currentMove) {
    const key = r * 1000 + c;
    if (!currentMove.diffMap.has(key)) currentMove.diffMap.set(key, { r, c, prev: state.board[r][c] });
  }
  state.board[r][c] = val;
  updateCellView(r, c);
}
function endMove() {
  if (!currentMove) return;
  const diffs = [...currentMove.diffMap.values()]
    .map((d) => ({ ...d, cur: state.board[d.r][d.c] }))
    .filter((d) => d.prev !== d.cur);
  const cost = currentMove.heartsBefore - state.hearts;
  currentMove = null;
  if (diffs.length > 0 || cost !== 0) {
    undoStack.push({ diffs, cost });
    redoStack = [];
    updateUndoRedoButtons();
  }
}
function pushUndoMove(diffs, cost = 0) {
  const real = diffs.filter((d) => d.prev !== d.cur);
  if (real.length === 0 && cost === 0) return;
  undoStack.push({ diffs: real, cost });
  redoStack = [];
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  if (el.btnUndo) el.btnUndo.disabled = state.gameOver || undoStack.length === 0;
  if (el.btnRedo) el.btnRedo.disabled = state.gameOver || redoStack.length === 0;
}
function doUndo() {
  if (pendingTap) commitPendingTap();
  if (state.gameOver || undoStack.length === 0) return;
  const move = undoStack.pop();
  for (const d of move.diffs) { state.board[d.r][d.c] = d.prev; updateCellView(d.r, d.c); }
  redoStack.push(move);
  updateUndoRedoButtons();
}
function doRedo() {
  if (state.gameOver || redoStack.length === 0) return;
  const move = redoStack.pop();
  for (const d of move.diffs) { state.board[d.r][d.c] = d.cur; updateCellView(d.r, d.c); }
  if (move.cost > 0) {
    state.hearts -= move.cost;
    renderHearts();
    playWrong(); vibrate(200);
  }
  undoStack.push(move);
  updateUndoRedoButtons();
  if (state.hearts <= 0) triggerGameOver();
  else checkWin();
}
function resetUndoRedo() {
  undoStack = [];
  redoStack = [];
  currentMove = null;
  if (pendingTap) { clearTimeout(pendingTap.timer); pendingTap = null; }
  updateUndoRedoButtons();
}

// Per-cell DOM elements, indexed [row][col], created once per level load.
let cellEls = [];

// 假設 is a scratch mode rather than a preference: the button, the Space
// shortcut and startLevel() all go through here.
function toggleHypo() {
  settings.hypo = !settings.hypo;
  saveSettings();
  updateToggleUI();
}

function updateToggleUI() {
  el.btnToggleSound.textContent = settings.sound ? "🔊" : "🔇";
  el.btnToggleVibrate.textContent = settings.vibrate ? "📳" : "📴";
  el.btnToggleAuto.textContent = settings.autoElim ? "開" : "關";
  el.btnToggleSound.classList.toggle("off", !settings.sound);
  el.btnToggleVibrate.classList.toggle("off", !settings.vibrate);
  el.btnToggleAuto.classList.toggle("off", !settings.autoElim);
  el.btnToggleHypo?.classList.toggle("off", !settings.hypo);
  if (el.btnToggleCopyAscii) {
    el.btnToggleCopyAscii.textContent = settings.copyAscii ? "開" : "關";
    el.btnToggleCopyAscii.classList.toggle("off", !settings.copyAscii);
  }
  if (el.btnToggleDim) {
    el.btnToggleDim.textContent = settings.dimMarked ? "開" : "關";
    el.btnToggleDim.classList.toggle("off", !settings.dimMarked);
  }
  // Both buttons are opt-in via the same setting; the "c" shortcut for the
  // link works either way.
  el.btnCopyAscii?.classList.toggle("hidden", !settings.copyAscii);
  el.btnCopyLink?.classList.toggle("hidden", !settings.copyAscii);
}

function renderPaletteEditor() {
  if (!el.paletteEditor) return;
  el.paletteEditor.innerHTML = "";
  REGION_COLORS.forEach((color, idx) => {
    const label = document.createElement("label");
    label.className = "swatch";
    label.title = `區域 ${String.fromCharCode(65 + idx)}`;
    const input = document.createElement("input");
    input.type = "color";
    input.value = color;
    input.addEventListener("input", () => setPaletteColor(idx, input.value));
    label.appendChild(input);
    el.paletteEditor.appendChild(label);
  });
}

// The import box is scratch space, not a setting: leaving the dialog always
// discards whatever is sitting in it.
function hideImportPanel() {
  el.importPanel?.classList.add("hidden");
  if (el.importText) el.importText.value = "";
}

function closeSettings() {
  el.settingsModal.classList.add("hidden");
  hideImportPanel();
}

async function init() {
  // Bind all event listeners synchronously BEFORE any async operations so that
  // browser caching of an older JS file can never leave buttons unresponsive.
  updateToggleUI();
  renderPaletteEditor();
  updateUndoRedoButtons();
  buildRatingCells();
  try { history.replaceState({ screen: "select" }, ""); } catch { }

  el.btnBack.addEventListener("click", () => history.back());
  el.btnRestart.addEventListener("click", () => startLevel(state.pack, state.levelIdx));
  el.btnUndo?.addEventListener("click", doUndo);
  el.btnRedo?.addEventListener("click", doRedo);
  el.btnNextLevel?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    startLevel(state.pack, state.levelIdx + 1);
  });
  el.btnReplay?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    startLevel(state.pack, state.levelIdx);
  });
  el.btnModalBack?.addEventListener("click", () => {
    el.winModal.classList.add("hidden");
    history.back();
  });

  el.btnHelpClose?.addEventListener("click", () => {
    el.helpModal.classList.add("hidden")
    settings.showHelp = false;
    saveSettings();
  });
  el.helpModal?.addEventListener("click", (e) => {
    if (e.target === el.helpModal) el.helpModal.classList.add("hidden");
  });

  el.btnSettings?.addEventListener("click", () => el.settingsModal.classList.remove("hidden"));
  el.btnSettingsClose?.addEventListener("click", closeSettings);
  el.settingsModal?.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) closeSettings();
  });
  el.btnHelpOpen?.addEventListener("click", () => {
    closeSettings();
    el.helpModal.classList.remove("hidden");
  });
  el.btnPaletteReset?.addEventListener("click", resetPalette);

  el.btnExportProgress?.addEventListener("click", exportProgress);
  el.btnImportProgress?.addEventListener("click", () => {
    const shown = !el.importPanel.classList.toggle("hidden");
    if (shown) el.importText.focus();
    else el.importText.value = "";
  });
  el.btnImportCancel?.addEventListener("click", hideImportPanel);
  el.btnImportConfirm?.addEventListener("click", () => {
    const text = el.importText.value.trim();
    if (!text) { showToast("請先貼上匯出的進度"); return; }
    if (importProgress(text)) hideImportPanel();
  });

  el.btnPackBack?.addEventListener("click", () => history.back());

  // 三層：關卡包列表 → 關卡列表 → 遊戲。一律照 history.state 決定要顯示哪一層，
  // 所以瀏覽器上一頁／手機返回手勢都會退回上一層而不是直接離開。
  window.addEventListener("popstate", () => {
    el.winModal.classList.add("hidden");
    const screen = history.state?.screen;
    if (screen === "game") return;
    el.screenGame.classList.add("hidden");
    el.screenSelect.classList.remove("hidden");
    el.appHeader?.classList.remove("hidden");
    if (screen === "levels" && state.packIndex?.has(history.state.pack))
      showLevelList(history.state.pack, false);
    else showPackList();
  });

  el.btnToggleSound?.addEventListener("click", () => {
    settings.sound = !settings.sound;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleVibrate?.addEventListener("click", () => {
    settings.vibrate = !settings.vibrate;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleAuto?.addEventListener("click", () => {
    settings.autoElim = !settings.autoElim;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleCopyAscii?.addEventListener("click", () => {
    settings.copyAscii = !settings.copyAscii;
    saveSettings();
    updateToggleUI();
  });
  el.btnToggleDim?.addEventListener("click", () => {
    settings.dimMarked = !settings.dimMarked;
    saveSettings();
    updateToggleUI();
    refreshBoardColors();
  });
  el.btnCopyAscii?.addEventListener("click", () => copyBoardAscii());
  el.btnCopyLink?.addEventListener("click", () => copyRelayLink());
  el.btnToggleHypo?.addEventListener("click", toggleHypo);

  // Board shortcuts: "c" copies the relay link to the current board, "d" toggles
  // the difficulty analysis (a hidden debug switch, see renderAnalysis), Space
  // toggles 假設 mode. Modifier combos are left alone so Ctrl/Cmd+C still copies.
  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (key !== "c" && key !== "d" && key !== " ") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (el.screenGame.classList.contains("hidden")) return;
    // An open dialog owns the keyboard: Space would otherwise toggle 假設 behind
    // the overlay *and* swallow the activation of whichever button has focus.
    if (document.querySelector(".modal-overlay:not(.hidden)")) return;
    const t = e.target;
    if (t instanceof HTMLElement
      && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();  // also stops Space scrolling / re-clicking a focused button
    if (key === "c") copyRelayLink();
    else if (key === "d") toggleAnalysis();
    else toggleHypo();
  });

  el.board.addEventListener("pointerdown", onPointerDown);
  el.board.addEventListener("pointermove", onPointerMove);
  el.board.addEventListener("pointerup", onPointerUp);
  el.board.addEventListener("pointercancel", onPointerUp);

  const res = await fetch("packs.json");
  state.manifest = await res.json();
  indexManifest();
  await migrateLegacyStars();
  renderPackList();
  await applyRelayFromUrl();
}

// 從 packs.json 建兩張查表：包 key → 包，關卡 id → 它在哪一包的第幾關。
// 後者讓 relay 連結只要認得關卡 id 就能落到正確的包裡（「下一關」才有得接）。
function indexManifest() {
  state.packIndex = new Map();
  state.levelHome = new Map();
  for (const group of state.manifest.groups) {
    for (const pack of group.packs) {
      pack.group = group;
      state.packIndex.set(pack.key, pack);
      pack.levels.forEach((id, i) => {
        if (!state.levelHome.has(id)) state.levelHome.set(id, { pack, ordinal: i + 1 });
      });
    }
  }
}

// 舊存檔裡 "hard:<idx>" 的星數：hard 這個包已經拆散回各尺寸目錄，拿搬家時留下
// 的對應表換成新 key。只有真的存在舊 key 時才去抓那個檔案。
async function migrateLegacyStars() {
  const data = getStars();
  if (!Object.keys(data).some((k) => k.startsWith("hard:"))) return;
  try {
    const res = await fetch("legacy_ids.json");
    const map = (await res.json()).hard || {};
    let moved = 0;
    for (const [old, id] of Object.entries(map)) {
      if (!(old in data)) continue;
      const key = starKey(id);
      if ((data[key] || 0) < data[old]) data[key] = data[old];
      delete data[old];
      moved++;
    }
    if (moved) saveStarsMap(data);
  } catch { }
}

function renderPackList() {
  el.packGroups.innerHTML = "";
  const stars = getStars();
  for (const group of state.manifest.groups) {
    const section = document.createElement("div");
    section.className = "pack-group";
    const h = document.createElement("h3");
    h.textContent = group.label;
    const range = group.scored === false ? "純邏輯解不開，必須猜測"
      : group.max ? `難度 ${group.min}-${group.max}` : `難度 ${group.min} 以上`;
    h.title = `${range}，共 ${group.count} 關`;
    section.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "button-grid";
    for (const pack of group.packs) {
      // 分母是「這包全部三星」的星數，所以滿額才會變綠 —— 和關卡按鈕同一套配色。
      let earned = 0, cleared = 0;
      for (const id of pack.levels) {
        const s = stars[starKey(id)] || 0;
        earned += s;
        if (s > 0) cleared++;
      }
      const total = pack.count * HEARTS_MAX;
      const btn = document.createElement("button");
      const name = document.createElement("span");
      name.textContent = pack.label;
      const score = document.createElement("span");
      score.className = "pack-score";
      score.textContent = `${earned}/${total}`;
      btn.append(name, score);
      btn.dataset.pack = pack.key;
      if (earned >= total) btn.classList.add("full");
      else if (earned > 0) btn.classList.add("partial");
      btn.title = `${cleared}/${pack.count} 關已過，${earned}/${total} 星`;
      btn.addEventListener("click", () => showLevelList(pack.key));
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    el.packGroups.appendChild(section);
  }
}

function showPackList() {
  el.viewLevels.classList.add("hidden");
  el.viewPacks.classList.remove("hidden");
  renderPackList();
}

function showLevelList(packKey, push = true) {
  const pack = state.packIndex.get(packKey);
  if (!pack) return showPackList();
  state.pack = packKey;
  el.packTitle.textContent = pack.label;
  el.viewPacks.classList.add("hidden");
  el.viewLevels.classList.remove("hidden");

  const stars = getStars();
  el.levelButtons.innerHTML = "";
  pack.levels.forEach((id, i) => {
    const btn = document.createElement("button");
    btn.textContent = String(i + 1);
    const s = stars[starKey(id)] || 0;
    if (s > 0) { btn.classList.add("done"); btn.dataset.stars = String(s); }
    btn.addEventListener("click", () => startLevel(packKey, i + 1));
    el.levelButtons.appendChild(btn);
  });

  if (push && history.state?.screen !== "levels")
    history.pushState({ screen: "levels", pack: packKey }, "");
  else history.replaceState({ screen: "levels", pack: packKey }, "");
}

function refreshDoneMarks() {
  if (!state.packIndex) return;
  if (el.viewLevels.classList.contains("hidden")) return renderPackList();
  const pack = state.packIndex.get(state.pack);
  if (!pack) return;
  const stars = getStars();
  [...el.levelButtons.children].forEach((btn, i) => {
    const s = stars[starKey(pack.levels[i])] || 0;
    btn.classList.toggle("done", s > 0);
    if (s > 0) btn.dataset.stars = String(s);
    else delete btn.dataset.stars;
  });
}

// ordinal = 在這一包裡的第幾關（1 起算），不是關卡 id。
async function startLevel(pack, ordinal) {
  const entry = state.packIndex.get(pack);
  const id = entry?.levels[ordinal - 1];
  const path = id && levelPath(id);
  if (!path) { showSelectScreen(); showToast("找不到關卡"); return; }
  const res = await fetch(path);
  const text = await res.text();
  const { n, regions, solution, analysis } = parseLevel(text);

  state.pack = pack;
  state.n = n;
  state.levelIdx = ordinal;
  state.levelId = id;
  state.regions = regions;
  state.solution = solution;
  state.board = Array.from({ length: n }, () => Array(n).fill(EMPTY));
  state.hearts = HEARTS_MAX;
  state.gameOver = false;

  resetUndoRedo();
  resetTimer();
  // Never carry 假設 mode over from the previous level.
  settings.hypo = false;
  saveSettings();
  updateToggleUI();

  el.gameTitle.textContent = `${packLabel(pack)} — 第 ${ordinal} 關 (${n} x ${n})`;
  el.statusBanner.classList.add("hidden");
  renderAnalysis(analysis);
  showGameScreen();
  renderBoard();
  renderHearts();
  if (settings.showHelp)
    el.helpModal.classList.remove("hidden");
}

function parseLevel(text) {
  // \r? 是必要的：關卡檔在 Windows 的工作目錄裡是 CRLF，留著 \r 會讓每一列
  // 多一個垃圾字元（盤面只讀前 n 格所以看不出來），也會讓難度分析多出空行。
  const allLines = text.split(/\r?\n/);
  const solutionLine = allLines.find((l) => l.startsWith("# solution:"));
  const solution = solutionLine.replace("# solution:", "").trim().split(/\s+/).map(Number);

  // 難度分析：`# difficulty:` 開始的那一整塊註解，原樣拿來顯示（和終端機
  // difficulty.py --steps 是同一份格式）。只有 annotate_difficulty.py 跑過的
  // 關卡才有，沒有就是空字串。
  const at = allLines.findIndex((l) => l.startsWith("# difficulty:"));
  const analysis = at < 0 ? "" : allLines.slice(at)
    .filter((l) => l.startsWith("#"))
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");

  const lines = allLines.filter((l) => !l.startsWith("#") && l.trim() !== "");
  const n = parseInt(lines[0], 10);
  const regions = [];
  for (let r = 0; r < n; r++) {
    regions.push(lines[1 + r].split("").map((ch) => ch.charCodeAt(0) - 65));
  }
  return { n, regions, solution, analysis };
}

// 難度分析區塊（debug 用）：一般玩家不需要看到，所以沒有任何按鈕或下拉入口，
// 預設完全隱藏 —— 遊戲畫面按 "d" 才叫得出來，開關記在 settings.showAnalysis，
// 這樣 debug 的時候不用每一關都按一次。關卡檔沒有分析註解就按了也不會出現。
let analysisText = "";

function renderAnalysis(text) {
  if (!el.analysis) return;
  analysisText = text || "";
  el.analysisBody.textContent = analysisText;
  el.analysis.classList.toggle("hidden", !(analysisText && settings.showAnalysis));
}

function toggleAnalysis() {
  settings.showAnalysis = !settings.showAnalysis;
  saveSettings();
  renderAnalysis(analysisText);
}

function showGameScreen() {
  el.screenSelect.classList.add("hidden");
  el.screenGame.classList.remove("hidden");
  el.appHeader?.classList.add("hidden");
  // Push only when coming from the select screen; replace when already in-game (next level).
  if (history.state?.screen !== "game") history.pushState({ screen: "game" }, "");
  else history.replaceState({ screen: "game" }, "");
}

function showSelectScreen() {
  el.screenGame.classList.add("hidden");
  el.screenSelect.classList.remove("hidden");
  el.appHeader?.classList.remove("hidden");
  refreshDoneMarks();
}

function renderBoard() {
  const n = state.n;
  el.board.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  el.board.style.gridTemplateRows = `repeat(${n}, 1fr)`;
  el.board.innerHTML = "";

  cellEls = Array.from({ length: n }, () => Array(n));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cellEl = document.createElement("div");
      cellEl.className = "cell";
      cellEl.innerHTML = '<span class="mark"><span class="bar"></span><span class="bar"></span></span>'
        + '<span class="cat-icon">🐱</span>'
        + '<span class="hypo-icon">△</span>';
      cellEls[r][c] = cellEl;
      el.board.appendChild(cellEl);
      updateCellView(r, c);
    }
  }
}

function updateCellView(r, c) {
  const st = state.board[r][c];
  const cell = cellEls[r][c];
  cell.dataset.state = String(st);
  const palette = (st === MARK && settings.dimMarked) ? REGION_COLORS_DIM : REGION_COLORS;
  cell.style.background = palette[state.regions[r][c] % palette.length];
}

function renderHearts() {
  el.hearts.textContent = "❤️".repeat(state.hearts) + "🤍".repeat(HEARTS_MAX - state.hearts);
}

// ── Copy board as ANSI art (for pasting into a telnet BBS) ───────────────────
// The palette is two rings of six hues (紅 橘 黃 青 藍 紫), a light and a dark
// version of each — which lands exactly on ANSI 31..36 plus the bright
// attribute, so all twelve regions get a distinct colour. 橘 has no ANSI hue of
// its own and takes the otherwise-unused 32 (green).
//
// The code comes from the region id's ring slot, not from REGION_COLORS: a
// custom palette would collapse several regions onto the same nearest ANSI
// colour, and staying distinguishable matters more here than matching on-screen
// hues exactly.
// All four glyphs are East Asian Ambiguous width, i.e. two columns each in a
// CJK BBS terminal, so the board stays square. Don't swap in a narrow one.
const ANSI_HUES = [31, 32, 33, 36, 34, 35];  // 紅 橘 黃 青 藍 紫
const ASCII_CELL = {
  [EMPTY]: "▇",
  [MARK]: "╳",
  [WRONG]: "╳",
  [CAT]: "★",
  [HYPO]: "△",
};

function ansiForRegion(id) {
  const slot = (id * 7) % 12;  // the permutation REGION_COLORS is baked in
  return `${id < 6 ? "1;" : "0;"}${ANSI_HUES[slot % 6]}`;
}

function boardToAnsi() {
  const n = state.n;
  const lines = [];
  for (let r = 0; r < n; r++) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const glyph = ASCII_CELL[state.board[r][c]] ?? ASCII_CELL[EMPTY];
      line += `\x1b[${ansiForRegion(state.regions[r][c])}m${glyph}`;
    }
    lines.push(line + "\x1b[m");
  }
  return lines.join("\n");
}

// navigator.clipboard needs a secure context, which plain http on a LAN address
// is not — hence the execCommand path for playing off another device.
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { }
  return legacyCopy(text);
}

async function copyBoardAscii() {
  if (!state.board || !state.n) return;
  const ok = await copyToClipboard(boardToAnsi());
  showToast(ok ? "已複製 ASCII 盤面" : "複製失敗");
}

// ── Relay links: share mid-solve progress as a URL ──────────────────────────
// The `r` parameter is three concatenated fields:
//
//   PP       folder code, 2 digits, from DIR_CODES
//   IIII     level index, 4 digits
//   payload  base64url of one bitstream: n*n mask bits (1 = crossed out,
//            row-major), then n nibbles, one per row, holding that row's cat
//            column + 1 (0 = no cat found in that row yet)
//
// Pulling the cats out of the grid is what makes this fit a BBS line. At most
// one cat per row is reachable — attemptPlaceCat() only writes CAT when the
// guess equals solution[r] — so 4 bits of column index per row beats spending
// a second bit on every one of the n*n cells. A 12x12 is 144 + 48 = 192 bits =
// 32 chars, putting the whole URL at 74.
//
// WRONG folds into MARK: a relayed board hands over the deduction ("no cat
// here"), not the sender's penalty, and the recipient starts on full hearts.
// HYPO is scratch and encodes as EMPTY, matching how startLevel() drops it.
// 連結認的是關卡放在哪個資料夾（盤面大小，或 bad）＋ 資料夾內的編號，和關卡包
// 無關 —— 所以難度重新分包不會讓任何連結失效。舊版這裡是「關卡包 → 代號」，但
// 數字包和 bad 的代號和資料夾一模一樣，所以那些舊連結照樣打得開。
// 8 / 10 / 11 是退役代號（hard / 實驗包），只保留給舊連結認；不要重複使用。
const DIR_CODES = {
  "6": 1, "7": 2, "8": 3, "9": 4, "10": 5, "11": 6, "12": 7, bad: 9,
};
const LEGACY_HARD_CODE = 8;
// Frozen and append-only: these codes are baked into every link ever shared,
// so a new folder takes the next unused number. Renumbering breaks old links.
const DIR_BY_CODE = Object.fromEntries(
  Object.entries(DIR_CODES).map(([dir, code]) => [code, dir]));

function encodeRelayPayload(board, n) {
  const bits = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      bits.push(board[r][c] === MARK || board[r][c] === WRONG ? 1 : 0);
  for (let r = 0; r < n; r++) {
    const col = board[r].indexOf(CAT);
    const nibble = col < 0 ? 0 : col + 1;
    for (let k = 3; k >= 0; k--) bits.push((nibble >> k) & 1);
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
  return bytesToBase64Url(bytes);
}

// Returns null rather than a half-built board for anything the level can't
// hold, so a mangled or hand-edited link fails visibly instead of quietly
// dropping a cat somewhere illegal.
function decodeRelayPayload(str, n) {
  const bytes = base64UrlToBytes(str);
  if (bytes.length < Math.ceil((n * n + 4 * n) / 8)) return null;
  const bit = (i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1;

  const board = Array.from({ length: n }, () => Array(n).fill(EMPTY));
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (bit(r * n + c)) board[r][c] = MARK;

  for (let r = 0; r < n; r++) {
    let nibble = 0;
    for (let k = 0; k < 4; k++) nibble = (nibble << 1) | bit(n * n + r * 4 + k);
    if (nibble === 0) continue;
    if (nibble > n) return null;
    board[r][nibble - 1] = CAT;  // a cat wins over its own mask bit
  }
  return board;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function buildRelayUrl() {
  if (!state.board || !state.n || !state.levelId) return null;
  const ref = levelRef(state.levelId);
  const code = ref && DIR_CODES[ref.dir];
  if (!code || ref.idx > 9999) return null;
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("r", String(code).padStart(2, "0")
    + String(ref.idx).padStart(4, "0")
    + encodeRelayPayload(state.board, state.n));
  return url.toString();
}

async function copyRelayLink() {
  const url = buildRelayUrl();
  if (!url) return;
  const ok = await copyToClipboard(url);
  showToast(ok ? "已複製連結" : "複製失敗");
}

// 連結裡的代號 + 編號 → 關卡 id。代號 8 是退役的 hard 包，只有舊連結會用到，
// 靠搬家時留下的對應表換算。
async function relayLevelId(code, idx) {
  if (code === LEGACY_HARD_CODE) {
    try {
      const res = await fetch("legacy_ids.json");
      return (await res.json()).hard?.[`hard:${idx}`] || null;
    } catch { return null; }
  }
  const dir = DIR_BY_CODE[code];
  return dir ? `level_${dir}_${String(idx).padStart(8, "0")}` : null;
}

// Runs once at startup. Consumes ?r= if present, loading that level and
// overlaying the decoded board on top of it. The query string is stripped
// immediately so a later "重來" or level switch doesn't re-trigger it.
async function applyRelayFromUrl() {
  const r = new URLSearchParams(location.search).get("r");
  if (!r) return;
  history.replaceState(history.state, "", location.pathname);
  const code = parseInt(r.slice(0, 2), 10);
  const idx = parseInt(r.slice(2, 6), 10);
  const payload = r.slice(6);
  try {
    if (!Number.isInteger(idx) || idx < 1 || !payload) throw new Error("bad link");
    const id = await relayLevelId(code, idx);
    const home = id && state.levelHome.get(id);
    if (!home) throw new Error("bad link");
    await startLevel(home.pack.key, home.ordinal);
    if (state.regions?.length !== state.n) throw new Error("bad level");
    const board = decodeRelayPayload(payload, state.n);
    if (!board) throw new Error("bad payload");
    state.board = board;
    renderBoard();
    renderHearts();
  } catch {
    showSelectScreen();
    showToast("連結格式錯誤");
  }
}

let toastTimer = null;
function showToast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 1600);
}

function checkWin() {
  const n = state.n;
  let cats = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (state.board[r][c] === CAT) cats++;
  if (cats === n) {
    state.gameOver = true;
    stopTimer();
    updateUndoRedoButtons();
    saveStars(state.levelId, state.hearts);
    recordClear(state.levelId, state.timerFrozenMs);
    renderRating(state.levelId);
    playWin(); vibrate(300);
    const hasNext = state.levelIdx < (state.packIndex.get(state.pack)?.count || 0);
    el.btnNextLevel.style.display = hasNext ? "" : "none";
    if (el.winTime) el.winTime.textContent = state.timerFrozenMs !== null ? `用時 ${formatElapsed(state.timerFrozenMs)}` : "";
    setTimeout(() => el.winModal.classList.remove("hidden"), 300);
  }
}

function triggerGameOver() {
  state.gameOver = true;
  stopTimer();
  updateUndoRedoButtons();
  el.statusBanner.textContent = "💔 掰了，按「重來」再試一次";
  el.statusBanner.className = "status-banner lose";
}


// Auto-eliminate: when a cat is correctly placed, mark same row, same column,
// surrounding 8 cells, and entire same-region (same color) as MARK.
function autoEliminate(r, c) {
  const n = state.n;
  const region = state.regions[r][c];
  const mark = (mr, mc) => {
    if (state.board[mr][mc] === EMPTY) setCell(mr, mc, MARK);
  };
  for (let j = 0; j < n; j++) if (j !== c) mark(r, j);
  for (let i = 0; i < n; i++) if (i !== r) mark(i, c);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < n && nc >= 0 && nc < n) mark(nr, nc);
    }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (state.regions[i][j] === region) mark(i, j);
}

function attemptPlaceCat(r, c) {
  if (state.gameOver || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  beginMove();
  if (state.solution[r] === c) {
    setCell(r, c, CAT);
    playCat(); vibrate(100);
    if (settings.autoElim) autoEliminate(r, c);
    endMove();
    checkWin();
  } else {
    state.hearts--;
    setCell(r, c, WRONG);
    renderHearts();
    playWrong(); vibrate(200);
    endMove();
    if (state.hearts <= 0) triggerGameOver();
  }
}

function applyMarkToggle(r, c) {
  const val = state.board[r][c] === EMPTY ? MARK : EMPTY;
  state.board[r][c] = val;
  updateCellView(r, c);
  playMark(); vibrate(50);
  return val;
}

function applyHypoToggle(r, c) {
  const val = state.board[r][c] === HYPO ? EMPTY : HYPO;
  state.board[r][c] = val;
  updateCellView(r, c);
  playMark(); vibrate(50);
  return val;
}

// --- Pointer handling: single tap toggles a mark, double tap on the same
// cell attempts a cat, and press-and-drag paints every swept cell to match
// the cell where the drag started (not a per-cell toggle). ---

let pointerId = null;
let dragging = false;
let dragTargetState = null;
let dragOrigin = null;
let lastPaintedKey = null;
let startX = 0, startY = 0;
let pendingTap = null; // { key, r, c, prevState, timer }
let activeCellEl = null;

function cellFromPoint(clientX, clientY) {
  const n = state.n;
  const rect = el.board.getBoundingClientRect();
  const relX = clientX - rect.left, relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return null;
  const c = Math.floor((relX / rect.width) * n);
  const r = Math.floor((relY / rect.height) * n);
  if (r < 0 || r >= n || c < 0 || c >= n) return null;
  return { r, c };
}

function onPointerDown(e) {
  if (state.gameOver || pointerId !== null) return;
  const cell = cellFromPoint(e.clientX, e.clientY);
  if (!cell) return;
  e.preventDefault(); // only suppress default when pointer is actually over the board
  startTimerIfNeeded();

  const startState = state.board[cell.r][cell.c];
  if (startState !== WRONG) {
    activeCellEl = cellEls[cell.r][cell.c];
    activeCellEl.classList.add("active");
  }

  pointerId = e.pointerId;
  el.board.setPointerCapture(pointerId);
  dragOrigin = cell;
  dragging = false;
  lastPaintedKey = null;
  startX = e.clientX;
  startY = e.clientY;

  if (startState === CAT || startState === WRONG) dragTargetState = null;
  else if (settings.hypo) dragTargetState = startState === HYPO ? EMPTY : HYPO;
  else dragTargetState = startState === EMPTY ? MARK : EMPTY;
}

function onPointerMove(e) {
  if (e.pointerId !== pointerId) return;
  const cell = cellFromPoint(e.clientX, e.clientY);

  if (!dragging) {
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD_PX;
    const leftOrigin = cell && (cell.r !== dragOrigin.r || cell.c !== dragOrigin.c);
    if (!moved && !leftOrigin) return;
    dragging = true;
    if (activeCellEl) { activeCellEl.classList.remove("active"); activeCellEl = null; }
    if (pendingTap) commitPendingTap();
    beginMove();
    paintDragCell(dragOrigin.r, dragOrigin.c);
  }

  if (cell) paintDragCell(cell.r, cell.c);
}

function paintDragCell(r, c) {
  const key = `${r},${c}`;
  if (key === lastPaintedKey) return;
  lastPaintedKey = key;
  if (dragTargetState === null || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  if (state.board[r][c] === dragTargetState) return;
  const cur = state.board[r][c];
  if (settings.hypo ? (cur !== EMPTY && cur !== HYPO) : (cur !== EMPTY && cur !== MARK)) return;
  setCell(r, c, dragTargetState);
  playMark(); vibrate(100);
}

function onPointerUp(e) {
  if (e.pointerId !== pointerId) return;
  el.board.releasePointerCapture(pointerId);
  if (activeCellEl) { activeCellEl.classList.remove("active"); activeCellEl = null; }
  const wasDragging = dragging;
  const origin = dragOrigin;
  pointerId = null;
  dragging = false;
  dragOrigin = null;

  if (wasDragging) endMove();
  else handleTap(origin.r, origin.c);
}

function handleTap(r, c) {
  if (state.gameOver || state.board[r][c] === CAT || state.board[r][c] === WRONG) return;
  const key = `${r},${c}`;
  if (pendingTap && pendingTap.key === key) {
    clearTimeout(pendingTap.timer);
    // Undo the mark applied on first tap (without a separate undo entry —
    // it was never committed), then place the cat as one clean move.
    if (pendingTap.prevState !== undefined) {
      state.board[r][c] = pendingTap.prevState;
      updateCellView(r, c);
    }
    pendingTap = null;
    attemptPlaceCat(r, c);
    return;
  }
  // Flush any pending tap on a different cell as its own committed move.
  if (pendingTap) commitPendingTap();
  // Apply mark/hypo immediately for instant feedback; committed to the undo
  // stack only once we know a follow-up double-tap didn't revert it.
  const prevState = state.board[r][c];
  if (settings.hypo) applyHypoToggle(r, c); else applyMarkToggle(r, c);
  pendingTap = {
    key, r, c, prevState,
    timer: setTimeout(() => commitPendingTap(), DOUBLE_TAP_MS),
  };
}

function commitPendingTap() {
  if (!pendingTap) return;
  clearTimeout(pendingTap.timer);
  const { r, c, prevState } = pendingTap;
  pendingTap = null;
  pushUndoMove([{ r, c, prev: prevState, cur: state.board[r][c] }]);
}

init();
