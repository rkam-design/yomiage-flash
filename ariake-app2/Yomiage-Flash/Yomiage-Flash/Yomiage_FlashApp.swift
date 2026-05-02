//
//  Yomiage_FlashApp.swift
//  Yomiage-Flash
//
//  Created by Micronet on 2026/02/22.
//

import SwiftUI
import AVFoundation

@main
struct Yomiage_FlashApp: App {
    init() {
        // オーディオセッションを設定（サイレントモードでも音声再生）
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            print("オーディオセッション設定エラー: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.light)
        }
    }
}
