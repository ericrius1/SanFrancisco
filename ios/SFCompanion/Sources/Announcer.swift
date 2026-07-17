import AVFoundation
import Foundation
import UserNotifications

/// Speaks "{user} entered the world" and posts a local notification banner
/// when the app isn't frontmost. Also owns the optional silent-audio loop that
/// keeps the SSE connection alive while the app is backgrounded ("Background
/// listening" — uses the `audio` background mode).
final class Announcer {
    var appIsActive = true

    private let synth = AVSpeechSynthesizer()
    private var keepAlivePlayer: AVAudioPlayer?

    private var speakJoins: Bool { UserDefaults.standard.object(forKey: "speakJoins") as? Bool ?? true }
    private var speakLeaves: Bool { UserDefaults.standard.object(forKey: "speakLeaves") as? Bool ?? false }

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func announceJoin(_ name: String) {
        print("[announce] \(name) entered the world (speak: \(speakJoins))")
        banner(body: "\(name) entered the world")
        if speakJoins { speak("\(name) entered the world") }
    }

    func announceLeave(_ name: String) {
        if speakLeaves {
            banner(body: "\(name) left the world")
            speak("\(name) left the world")
        }
    }

    func speak(_ text: String) {
        activateAudioSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.5
        synth.speak(utterance)
    }

    /// Local notification so a banner + sound shows while the app is
    /// backgrounded-but-alive. When the app is killed, only APNs push (server
    /// side, optional) can reach the user.
    private func banner(body: String) {
        guard !appIsActive else { return }
        let content = UNMutableNotificationContent()
        content.title = "San Francisco"
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: background keep-alive

    func setBackgroundListening(_ on: Bool) {
        if on {
            activateAudioSession()
            if keepAlivePlayer == nil, let player = try? AVAudioPlayer(data: Self.silentWav()) {
                player.numberOfLoops = -1
                player.volume = 0
                keepAlivePlayer = player
            }
            keepAlivePlayer?.play()
        } else {
            keepAlivePlayer?.stop()
        }
    }

    private func activateAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: [.mixWithOthers, .duckOthers])
        try? session.setActive(true)
    }

    /// One second of 8 kHz mono 16-bit silence, generated so the bundle needs
    /// no audio asset.
    private static func silentWav() -> Data {
        let sampleRate: UInt32 = 8000
        let dataSize: UInt32 = sampleRate * 2
        var d = Data()
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); le32(36 + dataSize)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); le32(16)
        le16(1); le16(1); le32(sampleRate); le32(sampleRate * 2); le16(2); le16(16)
        d.append(contentsOf: Array("data".utf8)); le32(dataSize)
        d.append(Data(count: Int(dataSize)))
        return d
    }
}
