# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

百人一首（小倉百人一首）の読み上げ WEB アプリ。元は iOS / SwiftUI で書かれていた試作アプリ（`ariake-app2/Yomiage-Flash/`）を、純粋な静的 HTML/CSS/JS に移植したもの。ビルド工程・依存パッケージは無く、`index.html` を HTTP で配信するだけで動く。

仕様書: `ariake-app2/アプリ要件v2.txt`（プレーンテキスト・日本語）。仕様変更の根拠を確認したい場合はまずこのファイルを読むこと。

## 実行方法

開発・確認はローカル HTTP サーバ経由でのみ可能（`file://` だと `<audio>` の autoplay 制限と CSV の `fetch()` で動かない）。

```bash
cd "/Users/micronet/Desktop/個人つくってみた/ariake-web"
python3 -m http.server 8000
# → http://localhost:8000/ を開く
```

ビルド・テスト・lint コマンドは存在しない（プレーン JS のみ）。

## アーキテクチャ

3 ファイル + アセットの単純構成。状態管理はグローバルな `game` オブジェクト 1 つに集約されている。

- `index.html` — オープニング/再生中/終了の 3 画面分の DOM を全部静的に書いておき、`render()` で `.hidden` を付け外しして表示を切り替える。SPA フレームワーク等は使っていない。
- `app.js` — 状態機械 + DOM 更新。Swift 版 `KarutaViewModel` と意図的に等価な構造で書かれている（移植時の差分を追いやすくするため）。
- `style.css` — iOS 版のテイスト（朱色 `--accent: #99332f` + 和紙色背景 + 明朝）を再現。

### 状態機械（`app.js`）

`State` 列挙：`OPENING → INTRO_A → INTRO_B → CARD_A →（CARD_B または FLASH_WAIT）→ FINISHED`

通常再生（`PlayMode.NORMAL`）とフラッシュ再生（`PlayMode.FLASH`）で遷移経路が分岐する：

- **通常**: `CARD_A`（A音声を最後まで）→ `WAIT_TAP`（◯ボタン待ち）→ `CARD_B`（B音声を最後まで）→ 次札
- **フラッシュ**: `CARD_A`（A音声を `rules.csv` の `time` 秒だけ再生）→ `FLASH_WAIT`（500ms 待機）→ 次札。B 音声は使わない。

通常再生は `<audio>` の `ended` イベント駆動（`onAudioFinished`）、フラッシュは `setTimeout` 駆動（`onFlashTimerFired`）。両者は別の遷移ハンドラに分かれている。状態遷移を変更する際は **両方** を確認すること。

### 「戻る」と中断

`returnToOpening()` は `stopAudio()` を経由して `<audio>` 要素・`flashTimer`・`waitTimer` を全部破棄してから `OPENING` に戻る。新たに非同期処理を増やす場合は `stopAudio()` で確実に止められるようにする（タイマーは `game.flashTimer` / `game.waitTimer` のスロットに保持する流儀に揃える）。

レース対策として、`<audio>` のコールバックは「自分が現在の `game.audio` のとき」だけ動作するチェックを入れている（`if (game.audio === a)`）。新しい音声を再生する前に必ず `stopAudio()` を呼ぶこと。

## アセット規約

ファイル名と札番号は厳密に一対一対応している：

- 画像: `cards/C-{NNN}.png`（`NNN` はゼロ埋め 3 桁、000〜100）。`C-000` は序歌用の表紙。
- 音声: `mp3_naniwadu/I-{NNN}{A|B}.mp3`。`A` = 上の句、`B` = 下の句。`I-000A` / `I-000B` は序歌（難波津）。
- ルール: `rules.csv`（UTF-8）。列は `no, count, kimari-ji, eng, time`。`time` はフラッシュ再生で A 音声を切り上げる秒数。

シャッフル対象は **1〜100 のみ**。`000`（序歌）はシャッフル配列に含めず、必ず最初に固定で再生する（仕様書 6 項参照）。

`rules.csv` のオリジナル（`ariake-app2/rules.csv`、Shift_JIS）は移行時に削除済み。WEB 用は UTF-8。`ariake-app2/Yomiage-Flash/Yomiage-Flash/` 配下に iOS 版が同名アセットを別コピーで保持している（こちらは Xcode プロジェクトの一部）。

## iOS 版との関係

`ariake-app2/Yomiage-Flash/Yomiage-Flash/ContentView.swift` が WEB 版の元実装。状態名・遷移条件・色値（`Color(red: 0.60, green: 0.20, blue: 0.20)` ≒ `#99332f`）は意図的に対応させてある。挙動の正解が分からないときはまず Swift 側を読むのが速い。
