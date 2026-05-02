/* 百人一首 読み上げアプリ（WEB版パイロット）
 * iOS 版 (Yomiage-Flash/ContentView.swift) と等価な状態機械を JS で実装。
 */

const CARDS_DIR = "cards";
const AUDIO_DIR = "mp3_naniwadu";
const RULES_URL = "rules.csv";

const PlayMode = Object.freeze({ NORMAL: "normal", FLASH: "flash", TEST: "test" });
const State = Object.freeze({
  OPENING: "opening",
  INTRO_A: "introA",
  INTRO_B: "introB",
  CARD_A: "cardA",
  WAIT_TAP: "waitTap",
  CARD_B: "cardB",
  FLASH_WAIT: "flashWait",
  PAUSED: "paused",
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

  cardSlot: document.getElementById("cardSlot"),
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
  startTestBtn: document.getElementById("startTestBtn"),
  tapNextBtn: document.getElementById("tapNextBtn"),
  returnHomeBtn: document.getElementById("returnHomeBtn"),
  navPrevBtn: document.getElementById("navPrevBtn"),
  navNextBtn: document.getElementById("navNextBtn"),
  errorModal: document.getElementById("errorModal"),
  errorModalBody: document.getElementById("errorModalBody"),
  errorModalCloseBtn: document.getElementById("errorModalCloseBtn"),
};

// ---- エラーモーダル ----
function showError(message) {
  els.errorModalBody.textContent = message;
  els.errorModal.classList.remove("hidden");
}
function hideError() {
  els.errorModal.classList.add("hidden");
}

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
  // 一時停止時に保存する「停止位置の index」（テストモードの ◀▶ 用）。
  pauseAnchorIndex: null,
  // 一時停止前に再生していた句の状態（CARD_A / CARD_B）。再開時に同じ句を頭から再生する。
  pausedFromState: null,
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

// FLASH と TEST はタイマー駆動・オレンジ系配色を共有する
const isFlashLike = () => game.mode === PlayMode.FLASH || game.mode === PlayMode.TEST;

// ---- rules.csv 読み込み ----
// 失敗時はサイレントな 0.7s フォールバックを行わず、モーダルでユーザーに通知する。
// 部分的に読み込めなかった行があった場合（100 件未満）も同様にエラー表示する。
async function loadRules() {
  try {
    const res = await fetch(RULES_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}（${RULES_URL}）`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).slice(1);
    const skipped = [];
    let lineNo = 1; // ヘッダーを除いた最初のデータ行を 1 とする
    for (const line of lines) {
      lineNo += 1;
      if (!line.trim()) continue;
      const cols = line.split(",");
      if (cols.length < 5) { skipped.push(`行 ${lineNo}: 列数不足 (${cols.length})`); continue; }
      const no = parseInt(cols[0], 10);
      const t = parseFloat(cols[4]);
      if (!Number.isFinite(no) || !Number.isFinite(t)) {
        skipped.push(`行 ${lineNo}: no="${cols[0]}" / time="${cols[4]}" が数値として解釈できません`);
        continue;
      }
      game.cardTimes.set(no, t);
    }
    console.log(`rules.csv: ${game.cardTimes.size} 件読み込みました`);
    if (game.cardTimes.size < 100) {
      const missing = [];
      for (let i = 1; i <= 100; i++) if (!game.cardTimes.has(i)) missing.push(i);
      const detail = [
        `読み込めた札: ${game.cardTimes.size} / 100`,
        missing.length ? `未取得の no: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " ..." : ""}` : "",
        skipped.length ? `スキップされた行:\n  ${skipped.slice(0, 5).join("\n  ")}${skipped.length > 5 ? "\n  ..." : ""}` : "",
        "",
        "rules.csv の列構成（no, count, kimari-ji, eng, time）と各値が正しいかご確認ください。",
      ].filter(Boolean).join("\n");
      showError(`rules.csv の読み込みが不完全です。\n\n${detail}`);
    }
  } catch (e) {
    console.error("rules.csv の読み込みに失敗:", e);
    showError(
      "rules.csv の読み込みに失敗しました。\n\n" +
      `エラー: ${e.message}\n\n` +
      "ファイルの存在と、HTTP サーバ経由（http://...）でアクセスしているかをご確認ください。\n" +
      "（file:// で開いている場合は CSV を読み込めません）"
    );
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
  const isTest = game.mode === PlayMode.TEST;
  const useFlashColor = isFlashLike();

  // ヘッダー / プログレス
  if (s === State.OPENING || s === State.FINISHED) {
    els.header.classList.add("hidden");
    els.progressWrap.classList.add("hidden");
  } else {
    els.header.classList.remove("hidden");
    els.progressWrap.classList.remove("hidden");
    els.modeBadge.textContent = isTest ? "テスト" : (isFlash ? "⚡ フラッシュ" : "通常再生");
    els.modeBadge.classList.toggle("badge-flash", useFlashColor);
    els.modeBadge.classList.toggle("badge-normal", !useFlashColor);
    els.progressBar.classList.toggle("flash", useFlashColor);

    const isIntro = s === State.INTRO_A || s === State.INTRO_B;
    const shownIndex = isIntro ? 0 : (game.index + 1);
    els.progressLabel.textContent = isIntro ? "序歌" : `${shownIndex} / 100`;
    const ratio = isIntro ? 0 : (game.index + 1) / 100;
    els.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  // フェーズ表示
  els.phaseSpinner.classList.toggle("flash", useFlashColor);
  els.phaseLabel.classList.toggle("paused", s === State.PAUSED);
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
      els.phaseText.textContent = useFlashColor ? "決まり字 再生中..." : "上の句 再生中...";
      break;
    case State.CARD_B:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = "下の句 再生中...";
      break;
    case State.PAUSED:
      els.phaseLabel.classList.remove("hidden");
      els.phaseText.textContent = isTest
        ? "一時停止中（タップ / Space で再開）"
        : "一時停止中（Space で再開）";
      break;
    default:
      els.phaseLabel.classList.add("hidden");
  }

  // テストモードでは札がタップ可能であることを示すカーソル
  els.cardSlot.classList.toggle(
    "tappable",
    isTest && (s === State.CARD_A || s === State.FLASH_WAIT || s === State.PAUSED)
  );

  // 一時停止中の前後ナビ（テストモードのみ）
  const showArrows = s === State.PAUSED && isTest;
  els.navPrevBtn.classList.toggle("show", showArrows);
  els.navNextBtn.classList.toggle("show", showArrows);
  els.navPrevBtn.disabled = !showArrows || game.index <= 0;
  els.navNextBtn.disabled =
    !showArrows || game.pauseAnchorIndex === null || game.index >= game.pauseAnchorIndex;

  // 操作エリアの出し分け
  els.openingControls.classList.toggle("hidden", s !== State.OPENING);
  els.tapControls.classList.toggle("hidden", s !== State.WAIT_TAP);
  els.flashWaitControls.classList.toggle("hidden", s !== State.FLASH_WAIT);
  els.finishedControls.classList.toggle("hidden", s !== State.FINISHED);

  if (s === State.FINISHED) {
    els.finishSubtitle.textContent =
      isTest ? "テスト 完了" : (isFlash ? "フラッシュ再生 完了" : "百首すべて読み上げました");
  }
}

// ---- 状態遷移 ----
function startGame(mode) {
  game.mode = mode;
  game.shuffled = shuffled1to100();
  game.index = 0;
  if (mode === PlayMode.TEST) {
    // テストモード：序歌（I-000A/B）を飛ばして即フラッシュ再生
    moveToNextCard();
  } else {
    setCard(0);
    game.state = State.INTRO_A;
    render();
    playAudio("I-000A", onAudioFinished);
  }
}

// 全モード共通：再生中の句（CARD_A / CARD_B）および札間ギャップ（FLASH_WAIT）を
// Space または札タップで一時停止 ⇄ 再開。再開時は表示中の札を頭から再生する。
// テストモードでは CARD_A / FLASH_WAIT 中の停止に限り ◀▶ ナビ可能。
function togglePause() {
  const s = game.state;

  if (s === State.PAUSED) {
    const from = game.pausedFromState;
    game.pauseAnchorIndex = null;
    game.pausedFromState = null;
    const num = game.shuffled[game.index];
    if (from === State.CARD_B) {
      game.state = State.CARD_B;
      render();
      playAudio(`I-${pad3(num)}B`, onAudioFinished);
    } else {
      // CARD_A / FLASH_WAIT から停止していた場合 — 表示中の札を頭から再生
      moveToNextCard();
    }
    return;
  }

  if (s !== State.CARD_A && s !== State.CARD_B && s !== State.FLASH_WAIT) return;
  stopAudio();
  if (s === State.FLASH_WAIT) {
    // FLASH_WAIT 中は game.index は次の札を指し、表示は直前の札のまま。
    // 一時停止中は表示と index を整合させるため 1 戻す（再開時に表示中の札を再生する）。
    game.index -= 1;
  }
  if (game.mode === PlayMode.TEST && (s === State.CARD_A || s === State.FLASH_WAIT)) {
    game.pauseAnchorIndex = game.index;
  }
  game.pausedFromState = s;
  game.state = State.PAUSED;
  render();
}

// 一時停止中の「前の札へ」。アンカー（停止位置）は変えず、表示中の札だけ巻き戻す。
function navPrev() {
  if (game.state !== State.PAUSED) return;
  if (game.index <= 0) return;
  game.index -= 1;
  setCard(game.shuffled[game.index]);
  render();
}

// 一時停止中の「次の札へ」。アンカーまで戻れるが、それより先（再生済みでない札）には進めない。
function navNext() {
  if (game.state !== State.PAUSED) return;
  if (game.pauseAnchorIndex === null) return;
  if (game.index >= game.pauseAnchorIndex) return;
  game.index += 1;
  setCard(game.shuffled[game.index]);
  render();
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
  if (isFlashLike()) {
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
  game.pauseAnchorIndex = null;
  game.pausedFromState = null;
  setCard(0);
  render();
}

// ---- イベント配線 ----
// クリック直後にフォーカスを外す（残留フォーカスのままだと Space 押下でその要素が
// 再クリックされてしまうため）。
function bindStart(btn, mode) {
  btn.addEventListener("click", () => {
    btn.blur();
    startGame(mode);
  });
}
bindStart(els.startNormalBtn, PlayMode.NORMAL);
bindStart(els.startFlashBtn, PlayMode.FLASH);
bindStart(els.startTestBtn, PlayMode.TEST);
els.tapNextBtn.addEventListener("click", onTapNext);
els.backBtn.addEventListener("click", returnToOpening);
els.returnHomeBtn.addEventListener("click", returnToOpening);

// テストモード専用：札タップ / Space キーで一時停止トグル
els.cardSlot.addEventListener("click", () => {
  if (game.mode === PlayMode.TEST) togglePause();
});
els.navPrevBtn.addEventListener("click", (e) => { e.currentTarget.blur(); navPrev(); });
els.navNextBtn.addEventListener("click", (e) => { e.currentTarget.blur(); navNext(); });
els.errorModalCloseBtn.addEventListener("click", () => { els.errorModalCloseBtn.blur(); hideError(); });
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  // 再生中の句（CARD_A / CARD_B）・札間ギャップ（FLASH_WAIT）・一時停止中のみ反応。
  // それ以外（オープニング・序歌・◯ボタン待機・終了）では何もせず、デフォルトのスクロール挙動も阻害しない。
  if (
    game.state !== State.CARD_A &&
    game.state !== State.CARD_B &&
    game.state !== State.FLASH_WAIT &&
    game.state !== State.PAUSED
  ) return;
  e.preventDefault();
  togglePause();
});

// ---- 起動 ----
(async function init() {
  setCard(0);
  await loadRules();
  render();
})();
