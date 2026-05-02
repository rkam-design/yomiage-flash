/* 百人一首 読み上げアプリ（WEB版パイロット）
 * iOS 版 (Yomiage-Flash/ContentView.swift) と等価な状態機械を JS で実装。
 */

const CARDS_DIR = "cards";
const AUDIO_DIR = "mp3_naniwadu";
const RULES_URL = "rules.csv";

const PlayMode = Object.freeze({ NORMAL: "normal", FLASH: "flash" });
const State = Object.freeze({
  OPENING: "opening",
  INTRO_A: "introA",
  INTRO_B: "introB",
  CARD_A: "cardA",
  WAIT_TAP: "waitTap",
  CARD_B: "cardB",
  FLASH_WAIT: "flashWait",
  FINISHED: "finished",
});

const FLASH_GAP_MS = 500;
const DEFAULT_FLASH_TIME = 0.7;

// ---- DOM ----
const els = {
  header: document.getElementById("header"),
  backBtn: document.getElementById("backBtn"),
  modeBadge: document.getElementById("modeBadge"),
  progressLabel: document.getElementById("progressLabel"),
  progressWrap: document.getElementById("progressWrap"),
  progressBar: document.getElementById("progressBar"),

  cardImage: document.getElementById("cardImage"),
  cardFallback: document.getElementById("cardFallback"),
  phaseLabel: document.getElementById("phaseLabel"),
  phaseText: document.getElementById("phaseText"),
  phaseSpinner: document.querySelector("#phaseLabel .spinner"),

  openingControls: document.getElementById("openingControls"),
  tapControls: document.getElementById("tapControls"),
  flashWaitControls: document.getElementById("flashWaitControls"),
  finishedControls: document.getElementById("finishedControls"),
  finishSubtitle: document.getElementById("finishSubtitle"),

  startNormalBtn: document.getElementById("startNormalBtn"),
  startFlashBtn: document.getElementById("startFlashBtn"),
  tapNextBtn: document.getElementById("tapNextBtn"),
  returnHomeBtn: document.getElementById("returnHomeBtn"),
};

// ---- ゲームモデル ----
const game = {
  state: State.OPENING,
  mode: PlayMode.NORMAL,
  shuffled: [],
  index: 0,
  currentCard: 0,
  cardTimes: new Map(), // no -> seconds
  audio: null,
  flashTimer: null,
  waitTimer: null,
};

// ---- ユーティリティ ----
const pad3 = (n) => String(n).padStart(3, "0");
const cardImageUrl = (n) => `${CARDS_DIR}/C-${pad3(n)}.png`;
const audioUrl = (name) => `${AUDIO_DIR}/${name}.mp3`;

function shuffled1to100() {
  const a = Array.from({ length: 100 }, (_, i) => i + 1);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- rules.csv 読み込み ----
async function loadRules() {
  try {
    const res = await fetch(RULES_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split(",");
      if (cols.length < 5) continue;
      const no = parseInt(cols[0], 10);
      const t = parseFloat(cols[4]);
      if (Number.isFinite(no) && Number.isFinite(t)) {
        game.cardTimes.set(no, t);
      }
    }
    console.log(`rules.csv: ${game.cardTimes.size} 件読み込みました`);
  } catch (e) {
    console.warn("rules.csv の読み込みに失敗。デフォルト値を使用します。", e);
    for (let i = 1; i <= 100; i++) game.cardTimes.set(i, DEFAULT_FLASH_TIME);
  }
}

// ---- 音声再生 ----
function stopAudio() {
  if (game.audio) {
    game.audio.onended = null;
    game.audio.onerror = null;
    try { game.audio.pause(); } catch (_) {}
    game.audio = null;
  }
  if (game.flashTimer) { clearTimeout(game.flashTimer); game.flashTimer = null; }
  if (game.waitTimer)  { clearTimeout(game.waitTimer);  game.waitTimer  = null; }
}

function playAudio(name, onEnd) {
  stopAudio();
  const a = new Audio(audioUrl(name));
  game.audio = a;
  a.onended = () => { if (game.audio === a) onEnd?.(); };
  a.onerror = () => {
    console.warn(`音声ファイル読み込み失敗: ${name}.mp3`);
    if (game.audio === a) onEnd?.();
  };
  // ブラウザは autoplay にユーザー操作を要求するため、再生開始のフォールバック処理を挟む
  const p = a.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => {
      console.warn("音声再生に失敗:", err);
      if (game.audio === a) onEnd?.();
    });
  }
}

function playAudioFlash(name, durationSec, onTimerFired) {
  stopAudio();
  const a = new Audio(audioUrl(name));
  game.audio = a;
  a.onerror = () => {
    console.warn(`音声ファイル読み込み失敗: ${name}.mp3`);
    onTimerFired?.();
  };
  const p = a.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => console.warn("音声再生に失敗:", err));
  }
  game.flashTimer = setTimeout(() => {
    game.flashTimer = null;
    onTimerFired?.();
  }, Math.max(0, durationSec * 1000));
}

// ---- 画面描画 ----
function setCard(number) {
  game.currentCard = number;
  els.cardImage.src = cardImageUrl(number);
  els.cardImage.alt = number === 0 ? "百人一首" : `第${number}番`;
  els.cardImage.classList.remove("hidden");
  els.cardFallback.classList.add("hidden");
  els.cardImage.onerror = () => {
    els.cardImage.classList.add("hidden");
    els.cardFallback.textContent = number === 0 ? "百人一首" : `第${number}番`;
    els.cardFallback.classList.remove("hidden");
  };
}

function render() {
  const s = game.state;
  const isFlash = game.mode === PlayMode.FLASH;

  // ヘッダー / プログレス
  if (s === State.OPENING) {
    els.header.classList.add("hidden");
    els.progressWrap.classList.add("hidden");
  } else if (s === State.FINISHED) {
    els.header.classList.add("hidden");
    els.progressWrap.classList.add("hidden");
  } else {
    els.header.classList.remove("hidden");
    els.progressWrap.classList.remove("hidden");
    els.modeBadge.textContent = isFlash ? "⚡ フラッシュ" : "通常再生";
    els.modeBadge.classList.toggle("badge-flash", isFlash);
    els.modeBadge.classList.toggle("badge-normal", !isFlash);
    els.progressBar.classList.toggle("flash", isFlash);

    const isIntro = s === State.INTRO_A || s === State.INTRO_B;
    const shownIndex = isIntro ? 0 : (game.index + 1);
    els.progressLabel.textContent = isIntro ? "序歌" : `${shownIndex} / 100`;
    const ratio = isIntro ? 0 : (game.index + 1) / 100;
    els.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  // フェーズ表示
  els.phaseSpinner.classList.toggle("flash", isFlash);
  switch (s) {
    case State.INTRO_A:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = "上の句 再生中...";
      break;
    case State.INTRO_B:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = "下の句 再生中...";
      break;
    case State.CARD_A:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = isFlash ? "決まり字 再生中..." : "上の句 再生中...";
      break;
    case State.CARD_B:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = "下の句 再生中...";
      break;
    default:
      els.phaseLabel.classList.add("hidden");
  }

  // 操作エリアの出し分け
  els.openingControls.classList.toggle("hidden", s !== State.OPENING);
  els.tapControls.classList.toggle("hidden", s !== State.WAIT_TAP);
  els.flashWaitControls.classList.toggle("hidden", s !== State.FLASH_WAIT);
  els.finishedControls.classList.toggle("hidden", s !== State.FINISHED);

  if (s === State.FINISHED) {
    els.finishSubtitle.textContent = isFlash ? "フラッシュ再生 完了" : "百首すべて読み上げました";
  }
}

// ---- 状態遷移 ----
function startGame(mode) {
  game.mode = mode;
  game.shuffled = shuffled1to100();
  game.index = 0;
  setCard(0);
  game.state = State.INTRO_A;
  render();
  playAudio("I-000A", onAudioFinished);
}

function onAudioFinished() {
  switch (game.state) {
    case State.INTRO_A:
      game.state = State.INTRO_B;
      render();
      playAudio("I-000B", onAudioFinished);
      break;
    case State.INTRO_B:
      moveToNextCard();
      break;
    case State.CARD_A:
      // 通常再生のみ。タップ待ち。
      game.state = State.WAIT_TAP;
      render();
      break;
    case State.CARD_B:
      game.index += 1;
      if (game.index >= 100) {
        game.state = State.FINISHED;
        stopAudio();
        render();
      } else {
        moveToNextCard();
      }
      break;
    default:
      break;
  }
}

function onFlashTimerFired() {
  stopAudio();
  game.index += 1;
  if (game.index >= 100) {
    game.state = State.FINISHED;
    render();
    return;
  }
  game.state = State.FLASH_WAIT;
  render();
  game.waitTimer = setTimeout(() => {
    game.waitTimer = null;
    moveToNextCard();
  }, FLASH_GAP_MS);
}

function moveToNextCard() {
  const num = game.shuffled[game.index];
  setCard(num);
  game.state = State.CARD_A;
  render();
  if (game.mode === PlayMode.FLASH) {
    const dur = game.cardTimes.get(num) ?? DEFAULT_FLASH_TIME;
    playAudioFlash(`I-${pad3(num)}A`, dur, onFlashTimerFired);
  } else {
    playAudio(`I-${pad3(num)}A`, onAudioFinished);
  }
}

function onTapNext() {
  if (game.state !== State.WAIT_TAP) return;
  const num = game.shuffled[game.index];
  game.state = State.CARD_B;
  render();
  playAudio(`I-${pad3(num)}B`, onAudioFinished);
}

function returnToOpening() {
  stopAudio();
  game.state = State.OPENING;
  game.index = 0;
  setCard(0);
  render();
}

// ---- イベント配線 ----
els.startNormalBtn.addEventListener("click", () => startGame(PlayMode.NORMAL));
els.startFlashBtn.addEventListener("click", () => startGame(PlayMode.FLASH));
els.tapNextBtn.addEventListener("click", onTapNext);
els.backBtn.addEventListener("click", returnToOpening);
els.returnHomeBtn.addEventListener("click", returnToOpening);

// ---- 起動 ----
(async function init() {
  setCard(0);
  await loadRules();
  render();
})();
