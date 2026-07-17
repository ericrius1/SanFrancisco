import Foundation
import SwiftUI

@MainActor
final class WorldMonitor: ObservableObject {
    enum ConnState: Equatable {
        case resolving
        case connecting
        case live
        case retrying(in: Int)

        var label: String {
            switch self {
            case .resolving: return "Finding world…"
            case .connecting: return "Connecting…"
            case .live: return "Live"
            case .retrying(let s): return "Reconnecting in \(s)s"
            }
        }
    }

    @Published var conn: ConnState = .resolving
    @Published var worldName = "San Francisco"
    @Published var players: [PlayerInfo] = []
    @Published var feed: [FeedItem] = []
    @Published var endpoint = ""
    @Published var configSource = ""

    let announcer = Announcer()
    private var runTask: Task<Void, Never>?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        // -skipNotificationPrompt 1 keeps headless UI tests unblocked
        if !UserDefaults.standard.bool(forKey: "skipNotificationPrompt") {
            announcer.requestNotificationPermission()
        }
        if UserDefaults.standard.bool(forKey: "backgroundListening") {
            announcer.setBackgroundListening(true)
        }
        restart()
    }

    /// Full reconnect — used at launch and after the server override changes.
    func restart() {
        runTask?.cancel()
        runTask = Task { await run() }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        announcer.appIsActive = phase == .active
        // Coming back to the foreground after a suspension: the socket may be
        // dead without having errored yet — force a clean reconnect.
        if phase == .active, case .live = conn {} else if phase == .active {
            restart()
        }
    }

    private func run() async {
        conn = .resolving
        let resolved = await ConfigService.resolve()
        if Task.isCancelled { return }
        worldName = resolved.worldName
        endpoint = resolved.eventsURL.absoluteString
        configSource = resolved.source
        PushRegistrar.shared.registerURL = resolved.registerURL
        conn = .connecting

        for await signal in SSEClient().signals(url: resolved.eventsURL) {
            if Task.isCancelled { return }
            switch signal {
            case .connected:
                conn = .live
            case .disconnected(let retryIn):
                conn = .retrying(in: max(1, Int(retryIn.rounded())))
                if !players.isEmpty { players = [] }
            case .event(let name, let data):
                handle(name: name, data: data)
            }
        }
    }

    private func handle(name: String, data: Data) {
        guard let payload = try? JSONDecoder().decode(EventPayload.self, from: data) else { return }
        switch name {
        case "hello":
            players = payload.players ?? []
            addFeed(.system, "Connected — \(players.count) in world")
        case "join":
            players = payload.players ?? players
            let who = payload.name ?? "Someone"
            addFeed(.join, "\(who) entered the world")
            announcer.announceJoin(who)
        case "leave":
            players = payload.players ?? players.filter { $0.id != payload.id }
            let who = payload.name ?? "Someone"
            addFeed(.leave, "\(who) left the world")
            announcer.announceLeave(who)
        default:
            break
        }
    }

    private func addFeed(_ kind: FeedItem.Kind, _ text: String) {
        feed.insert(FeedItem(kind: kind, text: text, date: Date()), at: 0)
        if feed.count > 60 { feed.removeLast(feed.count - 60) }
    }
}
