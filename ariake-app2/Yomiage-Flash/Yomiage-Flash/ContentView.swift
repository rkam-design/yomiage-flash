//
//  ContentView.swift
//  Yomiage-Flash
//
//  Created by Micronet on 2026/02/22.
//

import SwiftUI
import AVFoundation
import Combine

// MARK: - 再生モード
enum PlayMode {
    case normal    // 通常再生
    case flash     // フラッシュ再生
}

// MARK: - ゲーム状態
enum GameState {
    case opening          // オープニング画面（C-000 + ボタン）
    case playingIntroA    // I-000A 再生中
    case playingIntroB    // I-000B 再生中
    case playingCardA     // 上の句（A）再生中
    case waitingForTap    // ◯ボタン表示（通常再生のみ）
    case playingCardB     // 下の句（B）再生中（通常再生のみ）
    case flashWaiting     // フラッシュ再生：カード間の0.5秒待機
    case finished         // 全札終了
}

// MARK: - ViewModel
class KarutaViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var state: GameState = .opening
    @Published var playMode: PlayMode = .normal
    @Published var currentIndex: Int = 0
    @Published var currentCardNumber: Int = 0

    var shuffledCards: [Int] = []
    private var audioPlayer: AVAudioPlayer?
    private var flashTimer: Timer?
    private var waitTimer: Timer?

    // rules.csv から読み込んだ各札の決まり字再生時間（秒）
    private var cardTimes: [Int: TimeInterval] = [:]

    // MARK: - 初期化
    override init() {
        super.init()
        loadCardTimes()
    }

    // MARK: - rules.csv 読み込み
    private func loadCardTimes() {
        // フォルダ参照の場合
        var csvURL: URL?
        if let path = Bundle.main.path(forResource: "rules", ofType: "csv", inDirectory: "Resources") {
            csvURL = URL(fileURLWithPath: path)
        } else if let path = Bundle.main.path(forResource: "rules", ofType: "csv") {
            csvURL = URL(fileURLWithPath: path)
        }

        guard let url = csvURL else {
            print("rules.csv が見つかりません。デフォルト値(0.7秒)を使用します。")
            for i in 1...100 { cardTimes[i] = 0.7 }
            return
        }

        do {
            // Shift_JIS と UTF-8 の両方を試す
            var content: String?
            // まず UTF-8 で試す
            content = try? String(contentsOf: url, encoding: .utf8)
            // ダメなら Shift_JIS
            if content == nil {
                let shiftJIS = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(
                    CFStringEncoding(CFStringEncodings.shiftJIS.rawValue)
                ))
                content = try? String(contentsOf: url, encoding: shiftJIS)
            }

            guard let csvContent = content else {
                print("rules.csv の読み込みに失敗。デフォルト値を使用します。")
                for i in 1...100 { cardTimes[i] = 0.7 }
                return
            }

            let lines = csvContent.components(separatedBy: .newlines)
            for line in lines.dropFirst() {  // ヘッダをスキップ
                let cols = line.components(separatedBy: ",")
                guard cols.count >= 5,
                      let no = Int(cols[0].trimmingCharacters(in: .whitespaces)),
                      let time = Double(cols[4].trimmingCharacters(in: .whitespaces)) else {
                    continue
                }
                cardTimes[no] = time
            }
            print("rules.csv 読み込み完了: \(cardTimes.count)件")
        }
    }

    // MARK: - カード画像取得
    func cardImage(number: Int) -> UIImage? {
        let name = String(format: "C-%03d", number)
        if let path = Bundle.main.path(forResource: name, ofType: "png", inDirectory: "cards") {
            return UIImage(contentsOfFile: path)
        }
        if let path = Bundle.main.path(forResource: name, ofType: "png") {
            return UIImage(contentsOfFile: path)
        }
        return nil
    }

    // MARK: - 音声再生
    private func playAudio(_ name: String) {
        var url: URL?
        if let path = Bundle.main.path(forResource: name, ofType: "mp3", inDirectory: "mp3_naniwadu") {
            url = URL(fileURLWithPath: path)
        }
        if url == nil, let path = Bundle.main.path(forResource: name, ofType: "mp3") {
            url = URL(fileURLWithPath: path)
        }

        guard let audioURL = url else {
            print("音声ファイルが見つかりません: \(name).mp3")
            handleAudioFinished()
            return
        }

        do {
            audioPlayer = try AVAudioPlayer(contentsOf: audioURL)
            audioPlayer?.delegate = self
            audioPlayer?.play()
        } catch {
            print("音声再生エラー: \(error)")
            handleAudioFinished()
        }
    }

    // MARK: - 音声再生（フラッシュ用：time秒後に停止）
    private func playAudioFlash(_ name: String, duration: TimeInterval) {
        var url: URL?
        if let path = Bundle.main.path(forResource: name, ofType: "mp3", inDirectory: "mp3_naniwadu") {
            url = URL(fileURLWithPath: path)
        }
        if url == nil, let path = Bundle.main.path(forResource: name, ofType: "mp3") {
            url = URL(fileURLWithPath: path)
        }

        guard let audioURL = url else {
            print("音声ファイルが見つかりません: \(name).mp3")
            handleFlashTimerFired()
            return
        }

        do {
            audioPlayer = try AVAudioPlayer(contentsOf: audioURL)
            audioPlayer?.delegate = nil  // delegateは使わない（タイマーで制御）
            audioPlayer?.play()

            // 指定時間後に停止
            flashTimer?.invalidate()
            flashTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.handleFlashTimerFired()
                }
            }
        } catch {
            print("音声再生エラー: \(error)")
            handleFlashTimerFired()
        }
    }

    // MARK: - ゲーム開始（通常再生）
    func startNormalGame() {
        playMode = .normal
        shuffledCards = Array(1...100).shuffled()
        currentIndex = 0
        currentCardNumber = 0
        state = .playingIntroA
        playAudio("I-000A")
    }

    // MARK: - ゲーム開始（フラッシュ再生）
    func startFlashGame() {
        playMode = .flash
        shuffledCards = Array(1...100).shuffled()
        currentIndex = 0
        currentCardNumber = 0
        state = .playingIntroA
        playAudio("I-000A")
    }

    // MARK: - ◯ボタンタップ（通常再生のみ）
    func onTapNext() {
        guard state == .waitingForTap else { return }
        let num = shuffledCards[currentIndex]
        state = .playingCardB
        playAudio(String(format: "I-%03dB", num))
    }

    // MARK: - はじめに戻る
    func returnToOpening() {
        audioPlayer?.stop()
        audioPlayer = nil
        flashTimer?.invalidate()
        flashTimer = nil
        waitTimer?.invalidate()
        waitTimer = nil
        state = .opening
        currentCardNumber = 0
        currentIndex = 0
    }

    // MARK: - AVAudioPlayerDelegate（通常再生・イントロ用）
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.handleAudioFinished()
        }
    }

    // MARK: - 音声再生完了ハンドラ（通常再生・イントロ共通）
    private func handleAudioFinished() {
        switch state {
        case .playingIntroA:
            state = .playingIntroB
            playAudio("I-000B")

        case .playingIntroB:
            moveToNextCard()

        case .playingCardA:
            // 通常再生のみここに来る（フラッシュはタイマー制御）
            state = .waitingForTap

        case .playingCardB:
            currentIndex += 1
            if currentIndex >= 100 {
                state = .finished
            } else {
                moveToNextCard()
            }

        default:
            break
        }
    }

    // MARK: - フラッシュタイマー発火（time秒経過）
    private func handleFlashTimerFired() {
        audioPlayer?.stop()
        audioPlayer = nil
        flashTimer?.invalidate()
        flashTimer = nil

        // 次の札へ進むか終了か
        currentIndex += 1
        if currentIndex >= 100 {
            state = .finished
        } else {
            // 0.5秒待機
            state = .flashWaiting
            waitTimer?.invalidate()
            waitTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.moveToNextCard()
                }
            }
        }
    }

    // MARK: - 次の札へ移動
    private func moveToNextCard() {
        let num = shuffledCards[currentIndex]
        currentCardNumber = num
        state = .playingCardA

        if playMode == .flash {
            // フラッシュ再生：time秒だけ再生
            let duration = cardTimes[num] ?? 0.7
            playAudioFlash(String(format: "I-%03dA", num), duration: duration)
        } else {
            // 通常再生：最後まで再生
            playAudio(String(format: "I-%03dA", num))
        }
    }
}

// MARK: - メインビュー
struct ContentView: View {
    @StateObject private var viewModel = KarutaViewModel()

    var body: some View {
        ZStack {
            Color(red: 0.96, green: 0.95, blue: 0.93)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                switch viewModel.state {
                case .opening:
                    openingView
                case .playingIntroA, .playingIntroB:
                    introView
                case .playingCardA, .waitingForTap, .playingCardB, .flashWaiting:
                    cardPlayView
                case .finished:
                    finishedView
                }
            }
        }
    }

    // MARK: - オープニング画面
    private var openingView: some View {
        VStack(spacing: 20) {
            Spacer()

            cardImageView(number: 0)

            // 通常再生ボタン
            Button(action: {
                viewModel.startNormalGame()
            }) {
                Text("はじめる")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 240, height: 56)
                    .background(
                        RoundedRectangle(cornerRadius: 28)
                            .fill(Color(red: 0.60, green: 0.20, blue: 0.20))
                    )
            }

            // フラッシュ再生ボタン
            Button(action: {
                viewModel.startFlashGame()
            }) {
                Text("⚡ フラッシュ再生")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(Color(red: 0.60, green: 0.20, blue: 0.20))
                    .frame(width: 240, height: 52)
                    .background(
                        RoundedRectangle(cornerRadius: 26)
                            .stroke(Color(red: 0.60, green: 0.20, blue: 0.20), lineWidth: 2)
                    )
            }

            Spacer()
        }
        .padding()
    }

    // MARK: - 戻るボタン
    private var backButton: some View {
        HStack {
            Button(action: {
                viewModel.returnToOpening()
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                    Text("戻る")
                }
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(Color(red: 0.60, green: 0.20, blue: 0.20))
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    // MARK: - イントロ再生画面（序歌）
    private var introView: some View {
        VStack(spacing: 32) {
            backButton

            Spacer()

            // モード表示
            Text(viewModel.playMode == .flash ? "⚡ フラッシュ再生" : "通常再生")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(viewModel.playMode == .flash
                              ? Color.orange
                              : Color(red: 0.60, green: 0.20, blue: 0.20))
                )

            Text("序歌")
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(.gray)

            cardImageView(number: 0)

            HStack(spacing: 8) {
                ProgressView()
                    .tint(Color(red: 0.60, green: 0.20, blue: 0.20))
                Text(viewModel.state == .playingIntroA ? "上の句 再生中..." : "下の句 再生中...")
                    .font(.system(size: 16))
                    .foregroundColor(.gray)
            }

            Spacer()
        }
        .padding()
    }

    // MARK: - 札再生画面
    private var cardPlayView: some View {
        VStack(spacing: 24) {
            backButton

            // モード＋進捗表示
            HStack {
                Text(viewModel.playMode == .flash ? "⚡ フラッシュ" : "通常再生")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(
                        Capsule()
                            .fill(viewModel.playMode == .flash
                                  ? Color.orange
                                  : Color(red: 0.60, green: 0.20, blue: 0.20))
                    )

                Spacer()

                Text("\(viewModel.currentIndex + 1) / 100")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.gray)
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)

            // プログレスバー
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.gray.opacity(0.2))
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(viewModel.playMode == .flash
                              ? Color.orange
                              : Color(red: 0.60, green: 0.20, blue: 0.20))
                        .frame(width: geo.size.width * CGFloat(viewModel.currentIndex + 1) / 100.0, height: 6)
                }
            }
            .frame(height: 6)
            .padding(.horizontal, 24)

            Spacer()

            // 札画像
            cardImageView(number: viewModel.currentCardNumber)

            Spacer()

            // 状態に応じたUI
            switch viewModel.state {
            case .playingCardA:
                HStack(spacing: 8) {
                    ProgressView()
                        .tint(viewModel.playMode == .flash ? Color.orange : Color(red: 0.60, green: 0.20, blue: 0.20))
                    Text(viewModel.playMode == .flash ? "決まり字 再生中..." : "上の句 再生中...")
                        .font(.system(size: 16))
                        .foregroundColor(.gray)
                }
                .padding(.bottom, 40)

            case .waitingForTap:
                Button(action: {
                    viewModel.onTapNext()
                }) {
                    ZStack {
                        Circle()
                            .fill(Color(red: 0.60, green: 0.20, blue: 0.20))
                            .frame(width: 80, height: 80)
                        Circle()
                            .stroke(Color.white, lineWidth: 3)
                            .frame(width: 64, height: 64)
                        Text("◯")
                            .font(.system(size: 36, weight: .bold))
                            .foregroundColor(.white)
                    }
                }
                .padding(.bottom, 40)

            case .playingCardB:
                HStack(spacing: 8) {
                    ProgressView()
                        .tint(Color(red: 0.60, green: 0.20, blue: 0.20))
                    Text("下の句 再生中...")
                        .font(.system(size: 16))
                        .foregroundColor(.gray)
                }
                .padding(.bottom, 40)

            case .flashWaiting:
                Text("次の札へ...")
                    .font(.system(size: 16))
                    .foregroundColor(.orange)
                    .padding(.bottom, 40)

            default:
                EmptyView()
            }
        }
    }

    // MARK: - 終了画面
    private var finishedView: some View {
        VStack(spacing: 32) {
            Spacer()

            Text("おわり")
                .font(.system(size: 40, weight: .bold))
                .foregroundColor(Color(red: 0.60, green: 0.20, blue: 0.20))

            Text(viewModel.playMode == .flash
                 ? "フラッシュ再生 完了"
                 : "百首すべて読み上げました")
                .font(.system(size: 18))
                .foregroundColor(.gray)

            Button(action: {
                viewModel.returnToOpening()
            }) {
                Text("はじめに戻る")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 200, height: 52)
                    .background(
                        RoundedRectangle(cornerRadius: 26)
                            .fill(Color(red: 0.60, green: 0.20, blue: 0.20))
                    )
            }

            Spacer()
        }
        .padding()
    }

    // MARK: - 札画像コンポーネント
    @ViewBuilder
    private func cardImageView(number: Int) -> some View {
        if let uiImage = viewModel.cardImage(number: number) {
            Image(uiImage: uiImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 320)
                .cornerRadius(8)
                .shadow(color: .black.opacity(0.15), radius: 8, x: 0, y: 4)
        } else {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.gray.opacity(0.2))
                .frame(width: 240, height: 340)
                .overlay(
                    Text(number == 0 ? "百人一首" : "第\(number)番")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundColor(.gray)
                )
        }
    }
}

#Preview {
    ContentView()
}
