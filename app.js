/* 百人一首 読み上げアプリ（WEB版パイロット）
 * iOS 版 (Yomiage-Flash/ContentView.swift) と等価な状態機械を JS で実装。
 */

// キャッシュ確認用の表示バージョン。デプロイ前に手動で更新する。
// 画面右下に小さく表示され、ユーザーが読み込んでいる版を目視確認できる。
const APP_VERSION = "v2026-05-05-5";

const CARDS_DIR = "cards";
const AUDIO_DIR = "mp3_naniwadu";
const RULES_URL = "rules.csv";

const PlayMode = Object.freeze({ NORMAL: "normal", FLASH: "flash", TEST: "test" });
const State = Object.freeze({
  OPENING: "opening",
  LOADING: "loading",
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
const DEFAULT_FLASH_MS = 700;
// プリロードの並列度。モバイルブラウザの同時接続上限を踏まえて控えめに設定。
const PRELOAD_CONCURRENCY = 4;
// 通常再生モードでゲーム開始前に必ず取得しておく先頭札数（A/B 両方）。
// 残りはバックグラウンドで継続ダウンロードする。
const NORMAL_CRITICAL_CARDS = 5;

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
  loadingControls: document.getElementById("loadingControls"),
  loadingProgressText: document.getElementById("loadingProgressText"),
  finishedControls: document.getElementById("finishedControls"),
  finishSubtitle: document.getElementById("finishSubtitle"),

  startNormalBtn: document.getElementById("startNormalBtn"),
  startFlashBtn: document.getElementById("startFlashBtn"),
  startTestBtn: document.getElementById("startTestBtn"),
  skipIntroBtn: document.getElementById("skipIntroBtn"),
  diagnoseBtn: document.getElementById("diagnoseBtn"),
  tapNextBtn: document.getElementById("tapNextBtn"),
  returnHomeBtn: document.getElementById("returnHomeBtn"),
  navPrevBtn: document.getElementById("navPrevBtn"),
  navNextBtn: document.getElementById("navNextBtn"),
  errorModal: document.getElementById("errorModal"),
  errorModalTitle: document.getElementById("errorModalTitle"),
  errorModalBody: document.getElementById("errorModalBody"),
  errorModalCloseBtn: document.getElementById("errorModalCloseBtn"),
};

// ---- エラーモーダル ----
function showError(message, title = "エラー") {
  els.errorModalTitle.textContent = title;
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
  cardTimes: new Map(), // no -> ミリ秒（rules.csv の time 列）
  cardCounts: new Map(), // no -> 決まり字の字数（rules.csv の count 列）
  flashTimer: null,
  waitTimer: null,
  // 一時停止時に保存する「停止位置の index」（テストモードの ◀▶ 用）。
  pauseAnchorIndex: null,
  // 一時停止前に再生していた句の状態（CARD_A / CARD_B）。再開時に同じ句を頭から再生する。
  pausedFromState: null,
  // プリロード進捗（State.LOADING 中のみ有効）。
  loadingProgress: { loaded: 0, total: 0 },
};

// フラッシュ再生で序歌（I-000A）をスキップするか。localStorage で保持。
let skipIntro = (() => {
  try { return localStorage.getItem("skipIntro") === "1"; } catch (_) { return false; }
})();

// 単一の Audio 要素を使い回す（フォールバック用）。Web Audio がデコード済み
// AudioBuffer を持つ場合はそちらを優先するので、通常はあまり使われない。
const sharedAudio = new Audio();
sharedAudio.preload = "auto";
// 連続再生時の「割り込み判定」用。stopAudio() で +1 し、コールバックは自分が発行された
// 当時の世代と現在の世代が一致するときだけ動作する。
let audioGen = 0;

// ---- 音声プリロード（Web Audio + Audio fallback の両建て）----
// AudioBuffer はデコード済み PCM。Web Audio 経由で start() するとゼロ遅延・
// デコード待ちなしで再生できるので、フラッシュ／テストの素早い連続再生に最適。
// AudioContext はユーザー操作後にしか resume できないため lazy init。
let audioContext = null;
function getAudioContext() {
  if (!audioContext) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioContext = new AC();
  }
  return audioContext;
}
function ensureAudioContextResumed() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

const audioBufferCache = new Map(); // name -> AudioBuffer (decoded PCM)
const audioBlobCache = new Map();   // name -> blob URL（デコード失敗時の fallback 用）
let currentSource = null;            // 進行中の AudioBufferSourceNode
let audioPreloadAbort = null;

function audioSrcFor(name) {
  return audioBlobCache.get(name) ?? audioUrl(name);
}

// 札画像も先に Image オブジェクトでキックして HTTP キャッシュに入れる。
// 表示時の fetch/decode が音声再生と競合するのを防ぐ。
function preloadCardImages(numbers) {
  for (const n of numbers) {
    const img = new Image();
    img.src = cardImageUrl(n);
  }
}

// names を並列度 PRELOAD_CONCURRENCY で fetch → Blob URL 化して cache に格納。
// onProgress(loaded, total) は 1 件完了するごと（成功・失敗問わず）に呼ぶ。
// signal が abort されたら速やかに止める（既に完了済みのものは保持）。
async function preloadAudios(names, onProgress, signal) {
  const todo = names.filter(
    (n) => !audioBufferCache.has(n) && !audioBlobCache.has(n)
  );
  const total = todo.length;
  if (total === 0) {
    onProgress?.(0, 0);
    return { failed: [] };
  }
  const ctx = getAudioContext();
  let loaded = 0;
  const failed = [];
  const queue = todo.slice();
  async function fetchOnce(name) {
    const res = await fetch(audioUrl(name), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  }
  async function worker() {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const name = queue.shift();
      let arr = null;
      for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt++) {
        try {
          arr = await fetchOnce(name);
          break;
        } catch (e) {
          if (e.name === "AbortError") return;
          if (attempt === 2) {
            console.warn(`プリロード失敗: ${name}.mp3`, e);
            failed.push(name);
          } else {
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          }
        }
      }
      if (!signal?.aborted && arr) {
        let decoded = false;
        if (ctx) {
          try {
            // decodeAudioData は ArrayBuffer を消費する。Blob URL も作りたいので
            // 先にコピーを取ってから渡す（slice(0) でコピー）。
            const buffer = await ctx.decodeAudioData(arr.slice(0));
            audioBufferCache.set(name, buffer);
            decoded = true;
          } catch (e) {
            console.warn(`decode 失敗、Audio fallback: ${name}.mp3`, e);
          }
        }
        // Web Audio 不可 or デコード失敗時のフォールバックとして Blob URL も保持。
        if (!decoded) {
          audioBlobCache.set(name, URL.createObjectURL(new Blob([arr], { type: "audio/mpeg" })));
        }
      }
      loaded += 1;
      if (!signal?.aborted) onProgress?.(loaded, total);
    }
  }
  const workers = Array.from(
    { length: Math.min(PRELOAD_CONCURRENCY, total) },
    worker
  );
  await Promise.all(workers);
  if (failed.length > 0) {
    console.warn(`プリロード未完了: ${failed.length} 件`, failed);
  }
  return { failed };
}

// バックグラウンドでの非同期プリロード（戻り値を await しない用途）。
function preloadAudiosInBackground(names) {
  preloadAudios(names, null, null).catch(() => {});
}

// ---- 音源自己診断 ----
// 全 202 件 (I-000A/B + I-001A/B〜I-100A/B) を fetch & decodeAudioData で
// 検証する。サーバ配信と中身の両方を確認したいケース（音飛び等の調査）に使用。
async function runAudioSelfTest() {
  const names = ["I-000A", "I-000B"];
  for (let i = 1; i <= 100; i++) names.push(`I-${pad3(i)}A`, `I-${pad3(i)}B`);
  const total = names.length;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    showError("このブラウザでは音源確認機能が使えません（Web Audio API 非対応）。", "音源確認");
    return;
  }
  const ctx = new AC();
  showError(`音源確認中... 0 / ${total}`, "音源確認");

  const failed = [];
  let done = 0;
  const queue = names.slice();
  async function worker() {
    while (queue.length > 0) {
      const name = queue.shift();
      try {
        const res = await fetch(audioUrl(name), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        await ctx.decodeAudioData(buf);
      } catch (e) {
        failed.push({ name, reason: e.message || String(e) });
      }
      done += 1;
      els.errorModalBody.textContent = `音源確認中... ${done} / ${total}`;
    }
  }
  await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
  try { ctx.close(); } catch (_) {}

  if (failed.length === 0) {
    els.errorModalBody.textContent = `全 ${total} 件、音源データに問題ありません。\n（サーバ配信・デコード共に正常）`;
  } else {
    const head = failed.slice(0, 20).map((f) => `${f.name}: ${f.reason}`).join("\n");
    const tail = failed.length > 20 ? `\n... ほか ${failed.length - 20} 件` : "";
    els.errorModalBody.textContent =
      `${failed.length} / ${total} 件で問題あり:\n\n${head}${tail}`;
  }
}

function buildAudioNames(mode, shuffled) {
  const critical = [];
  const background = [];
  if (mode === PlayMode.TEST) {
    for (const num of shuffled) critical.push(`I-${pad3(num)}A`);
  } else if (mode === PlayMode.FLASH) {
    if (!skipIntro) critical.push("I-000A");
    for (const num of shuffled) critical.push(`I-${pad3(num)}A`);
  } else {
    // NORMAL: 序歌 + 先頭 NORMAL_CRITICAL_CARDS 枚分は必須。残りはバックグラウンド。
    critical.push("I-000A", "I-000B");
    const split = Math.min(NORMAL_CRITICAL_CARDS, shuffled.length);
    for (let i = 0; i < split; i++) {
      const num = shuffled[i];
      critical.push(`I-${pad3(num)}A`, `I-${pad3(num)}B`);
    }
    for (let i = split; i < shuffled.length; i++) {
      const num = shuffled[i];
      background.push(`I-${pad3(num)}A`, `I-${pad3(num)}B`);
    }
  }
  return { critical, background };
}

// ---- ユーティリティ ----
const pad3 = (n) => String(n).padStart(3, "0");
const cardImageUrl = (n) => `${CARDS_DIR}/C-${pad3(n)}.png`;
const audioUrl = (name) => `${AUDIO_DIR}/${name}.mp3`;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// モード別の出題セット。TEST は決まり字 2 字（count=2）の札のみ、その他は 1〜100 全件。
function deckForMode(mode) {
  if (mode === PlayMode.TEST) {
    const twos = [];
    for (let i = 1; i <= 100; i++) {
      if (game.cardCounts.get(i) === 2) twos.push(i);
    }
    return shuffleArray(twos);
  }
  return shuffleArray(Array.from({ length: 100 }, (_, i) => i + 1));
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
      const cnt = parseInt(cols[1], 10);
      const t = parseFloat(cols[4]);
      if (!Number.isFinite(no) || !Number.isFinite(t)) {
        skipped.push(`行 ${lineNo}: no="${cols[0]}" / time="${cols[4]}" が数値として解釈できません`);
        continue;
      }
      game.cardTimes.set(no, t);
      if (Number.isFinite(cnt)) game.cardCounts.set(no, cnt);
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
  audioGen += 1;
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  sharedAudio.onended = null;
  sharedAudio.onerror = null;
  sharedAudio.onplaying = null;
  try { sharedAudio.pause(); } catch (_) {}
  if (game.flashTimer) { clearTimeout(game.flashTimer); game.flashTimer = null; }
  if (game.waitTimer)  { clearTimeout(game.waitTimer);  game.waitTimer  = null; }
}

// AudioBuffer がキャッシュにあれば Web Audio で start()。即時再生・デコード待ちなし。
// なければ <audio> 要素にフォールバック。返り値はどちらの経路で再生したか（"buffer"|"audio"）
// または null（即失敗）。
function startPlaybackForName(name, myGen, callbacks) {
  const buffer = audioBufferCache.get(name);
  if (buffer) {
    const ctx = getAudioContext();
    if (ctx) {
      ensureAudioContextResumed();
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
          if (myGen !== audioGen) return;
          if (currentSource === source) currentSource = null;
          callbacks.onEnded?.();
        };
        currentSource = source;
        source.start();
        callbacks.onStarted?.();
        return "buffer";
      } catch (e) {
        console.warn(`Web Audio 再生失敗、Audio fallback: ${name}`, e);
        currentSource = null;
      }
    }
  }
  // Audio 要素フォールバック
  sharedAudio.src = audioSrcFor(name);
  sharedAudio.onplaying = () => {
    if (myGen === audioGen) callbacks.onStarted?.();
  };
  sharedAudio.onended = () => {
    if (myGen === audioGen) callbacks.onEnded?.();
  };
  sharedAudio.onerror = () => {
    console.warn(`音声ファイル読み込み失敗: ${name}.mp3`);
    if (myGen === audioGen) callbacks.onEnded?.();
  };
  const p = sharedAudio.play();
  if (p && typeof p.catch === "function") {
    p.catch((err) => {
      console.warn("音声再生に失敗:", err);
      // 再生不可（autoplay 拒否等）でも進行は止めない。
      if (myGen === audioGen) {
        callbacks.onStarted?.();
        callbacks.onEnded?.();
      }
    });
  }
  return "audio";
}

function playAudio(name, onEnd) {
  stopAudio();
  const myGen = audioGen;
  startPlaybackForName(name, myGen, {
    onEnded: () => onEnd?.(),
  });
}

function playAudioFlash(name, durationMs, onTimerFired) {
  stopAudio();
  const myGen = audioGen;
  let timerStarted = false;
  const startTimer = () => {
    if (timerStarted || myGen !== audioGen) return;
    timerStarted = true;
    game.flashTimer = setTimeout(() => {
      game.flashTimer = null;
      onTimerFired?.();
    }, Math.max(0, durationMs));
  };
  startPlaybackForName(name, myGen, {
    onStarted: startTimer,
    // フラッシュは音声末尾まで再生せず時間で切り上げるので onEnded は使わない（タイマー駆動）。
    onEnded: () => {},
  });
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

    if (s === State.LOADING) {
      const { loaded, total } = game.loadingProgress;
      els.progressLabel.textContent = "読み込み中";
      const r = total > 0 ? loaded / total : 0;
      els.progressBar.style.width = `${(r * 100).toFixed(2)}%`;
    } else {
      const total = game.shuffled.length || 100;
      const isIntro = s === State.INTRO_A || s === State.INTRO_B;
      const shownIndex = isIntro ? 0 : (game.index + 1);
      els.progressLabel.textContent = isIntro ? "序歌" : `${shownIndex} / ${total}`;
      const ratio = isIntro ? 0 : (game.index + 1) / total;
      els.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
    }
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
  els.loadingControls.classList.toggle("hidden", s !== State.LOADING);
  els.finishedControls.classList.toggle("hidden", s !== State.FINISHED);

  if (s === State.LOADING) {
    const { loaded, total } = game.loadingProgress;
    els.loadingProgressText.textContent = `${loaded} / ${total}`;
  }

  if (s === State.FINISHED) {
    els.finishSubtitle.textContent =
      isTest ? "テスト 完了" : (isFlash ? "フラッシュ再生 完了" : "百首すべて読み上げました");
  }
}

// ---- 状態遷移 ----
async function startGame(mode) {
  // ユーザー操作直後の今のうちに AudioContext を初期化／resume する。
  // iOS Safari は autoplay policy で gesture 文脈外の resume() を拒否する。
  ensureAudioContextResumed();

  game.mode = mode;
  game.shuffled = deckForMode(mode);
  game.index = 0;
  if (mode === PlayMode.TEST && game.shuffled.length === 0) {
    showError("テスト対象（決まり字 2 字）の札が rules.csv に見つかりませんでした。");
    return;
  }

  // 札画像も先読みして表示時の fetch/decode が音声と競合しないようにする。
  const imgNumbers = mode === PlayMode.TEST ? game.shuffled.slice() : [0, ...game.shuffled];
  preloadCardImages(imgNumbers);

  const { critical, background } = buildAudioNames(mode, game.shuffled);
  const critToFetch = critical.filter((n) => !audioBlobCache.has(n));
  if (critToFetch.length > 0) {
    game.state = State.LOADING;
    game.loadingProgress = { loaded: 0, total: critToFetch.length };
    render();
    audioPreloadAbort = new AbortController();
    const signal = audioPreloadAbort.signal;
    await preloadAudios(
      critical,
      (loaded, total) => {
        if (game.state !== State.LOADING) return;
        game.loadingProgress = { loaded, total };
        render();
      },
      signal
    );
    audioPreloadAbort = null;
    // 中断されていた場合（戻る押下） — returnToOpening 側で OPENING に戻っているので何もしない。
    if (signal.aborted || game.state !== State.LOADING) return;
  }
  // 残りはバックグラウンドで継続取得（NORMAL モードで分割した場合のみ非空）。
  if (background.length > 0) preloadAudiosInBackground(background);

  // TEST は元々序歌スキップ。FLASH も序歌オフが設定されていればスキップして即札再生へ。
  if (mode === PlayMode.TEST || (mode === PlayMode.FLASH && skipIntro)) {
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
      if (game.index >= game.shuffled.length) {
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
  // time に達したら音声を即停止する。Web Audio の AudioBufferSourceNode と
  // <audio> 要素の両方を確実に止める（どちらの経路で再生中かに関わらず）。
  game.flashTimer = null;
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  try { sharedAudio.pause(); } catch (_) {}

  game.index += 1;
  if (game.index >= game.shuffled.length) {
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
    const dur = game.cardTimes.get(num) ?? DEFAULT_FLASH_MS;
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
  if (audioPreloadAbort) {
    audioPreloadAbort.abort();
    audioPreloadAbort = null;
  }
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
els.diagnoseBtn.addEventListener("click", () => {
  els.diagnoseBtn.blur();
  runAudioSelfTest();
});
els.skipIntroBtn.addEventListener("click", () => {
  els.skipIntroBtn.blur();
  skipIntro = !skipIntro;
  els.skipIntroBtn.setAttribute("aria-pressed", String(skipIntro));
  try { localStorage.setItem("skipIntro", skipIntro ? "1" : "0"); } catch (_) {}
});
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
  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = APP_VERSION;
  els.skipIntroBtn.setAttribute("aria-pressed", String(skipIntro));
  setCard(0);
  await loadRules();
  render();
})();
