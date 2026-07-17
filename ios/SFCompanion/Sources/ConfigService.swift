import Foundation

/// Resolves where to listen. The app never hardcodes event paths — it asks a
/// config document, so switching the backend means editing one JSON file, not
/// shipping an app update. Resolution order:
///   1. Manual server override from Settings (power users / local dev)
///   2. Remote config in the repo via GitHub raw (stable across backend moves)
///   3. Last successfully fetched config (cached)
///   4. The current server's own /companion/config
///   5. Built-in default (Railway deployment)
enum ConfigService {
    static let remoteConfigURL = URL(string: "https://raw.githubusercontent.com/ericrius1/SanFrancisco/main/companion/config.json")!
    static let fallbackBase = URL(string: "https://sanfrancisco.up.railway.app")!
    static let overrideKey = "serverOverride"
    private static let cacheKey = "cachedCompanionConfig"

    static func resolve() async -> ResolvedEndpoints {
        if let override = UserDefaults.standard.string(forKey: overrideKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !override.isEmpty,
            let base = normalizedBase(override) {
            if let cfg = await fetch(from: base.appending(path: "companion/config")) {
                return endpoints(from: cfg, defaultBase: base, source: "override")
            }
            // Server unreachable or older build without /companion — assume default paths.
            return ResolvedEndpoints(
                worldName: "World",
                eventsURL: base.appending(path: "companion/events"),
                registerURL: base.appending(path: "companion/register"),
                source: "override (default paths)"
            )
        }
        if let cfg = await fetch(from: remoteConfigURL) {
            cache(cfg)
            return endpoints(from: cfg, defaultBase: fallbackBase, source: "remote config")
        }
        if let cfg = cached() {
            return endpoints(from: cfg, defaultBase: fallbackBase, source: "cached config")
        }
        if let cfg = await fetch(from: fallbackBase.appending(path: "companion/config")) {
            cache(cfg)
            return endpoints(from: cfg, defaultBase: fallbackBase, source: "server config")
        }
        return ResolvedEndpoints(
            worldName: "San Francisco",
            eventsURL: fallbackBase.appending(path: "companion/events"),
            registerURL: fallbackBase.appending(path: "companion/register"),
            source: "built-in default"
        )
    }

    private static func endpoints(from cfg: CompanionConfig, defaultBase: URL, source: String) -> ResolvedEndpoints {
        let base = cfg.baseUrl.flatMap { URL(string: $0) } ?? defaultBase
        let eventsPath = cfg.events?.path ?? "/companion/events"
        let registerPath = cfg.register?.path
        return ResolvedEndpoints(
            worldName: cfg.world ?? "World",
            eventsURL: base.appending(path: String(eventsPath.drop(while: { $0 == "/" }))),
            registerURL: registerPath.map { base.appending(path: String($0.drop(while: { $0 == "/" }))) },
            source: source
        )
    }

    private static func normalizedBase(_ raw: String) -> URL? {
        var s = raw
        if !s.contains("://") { s = "https://\(s)" }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host() != nil else { return nil }
        return url
    }

    private static func fetch(from url: URL) async -> CompanionConfig? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let cfg = try? JSONDecoder().decode(CompanionConfig.self, from: data),
              cfg.events?.path != nil || cfg.baseUrl != nil
        else { return nil }
        return cfg
    }

    private static func cache(_ cfg: CompanionConfig) {
        if let data = try? JSONEncoder().encode(cfg) {
            UserDefaults.standard.set(data, forKey: cacheKey)
        }
    }

    private static func cached() -> CompanionConfig? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(CompanionConfig.self, from: data)
    }
}
