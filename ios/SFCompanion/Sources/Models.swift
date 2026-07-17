import Foundation

struct PlayerInfo: Codable, Identifiable, Equatable {
    let id: Int
    let name: String
}

/// Wire payload for every companion SSE event (hello / join / leave).
/// All fields optional so protocol additions never break old app builds.
struct EventPayload: Codable {
    var type: String?
    var id: Int?
    var name: String?
    var players: [PlayerInfo]?
    var ts: Double?
}

/// Backend descriptor. Served both from the repo (GitHub raw, survives a
/// backend switch) and from the live server at /companion/config.
struct CompanionConfig: Codable, Equatable {
    struct Endpoint: Codable, Equatable {
        var kind: String?
        var path: String
    }

    var v: Int?
    var world: String?
    var baseUrl: String?
    var events: Endpoint?
    var register: Endpoint?
}

struct ResolvedEndpoints {
    let worldName: String
    let eventsURL: URL
    let registerURL: URL?
    let source: String
}

struct FeedItem: Identifiable, Equatable {
    enum Kind { case join, leave, system }
    let id = UUID()
    let kind: Kind
    let text: String
    let date: Date
}
