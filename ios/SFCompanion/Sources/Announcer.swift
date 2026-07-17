import AVFoundation
import Foundation
import UserNotifications

/// Posts a normal iOS notification banner when someone enters the world.
/// No speech. The banner shows whether the app is foreground or background
/// (foreground presentation is enabled via the notification-center delegate in
/// PushRegistrar.swift). Also owns the optional silent-audio loop that keeps
/// the SSE connection — and therefore these local notifications — alive while
/// the app is backgrounded ("Background listening", uses the `audio` mode).
final class Announcer {
    var appIsActive = true

    private var keepAlivePlayer: AVAudioPlayer?
    private var notifyLeaves: Bool { UserDefaults.standard.bool(forKey: "notifyLeaves") }

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func announceJoin(_ name: String) {
        banner(body: "\(name) entered the world")
    }

    func announceLeave(_ name: String) {
        guard notifyLeaves else { return }
        banner(body: "\(name) left the world")
    }

    /// A standard local notification — banner + sound, listed in Notification
    /// Center. Fires immediately (nil trigger).
    private func banner(body: String) {
        let content = UNMutableNotificationContent()
        content.title = "San Francisco"
        content.body = body
        content.sound = .default
        content.interruptionLevel = .timeSensitive
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
        try? session.setCategory(.playback, options: [.mixWithOthers])
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
