import Foundation

enum StreamSignal {
    case connected
    case disconnected(retryIn: TimeInterval)
    case event(name: String, data: Data)
}

/// Server-sent-events listener with automatic reconnect + exponential backoff.
/// This is one implementation of the app's event source; the payload shapes in
/// Models.swift are the actual contract, so a future backend can swap SSE for
/// WebSocket/push by serving a different `events.kind` in the config and adding
/// a sibling client here — nothing else in the app changes.
struct SSEClient {
    func signals(url: URL) -> AsyncStream<StreamSignal> {
        AsyncStream { continuation in
            let task = Task {
                var backoff: TimeInterval = 1
                while !Task.isCancelled {
                    do {
                        var request = URLRequest(url: url)
                        request.timeoutInterval = 90 // server pings every 25 s
                        request.cachePolicy = .reloadIgnoringLocalCacheData
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        let (bytes, response) = try await URLSession.shared.bytes(for: request)
                        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                            throw URLError(.badServerResponse)
                        }
                        continuation.yield(.connected)
                        backoff = 1

                        var eventName = "message"
                        var dataLines: [String] = []
                        var lineBuf: [UInt8] = []
                        // Parse bytes manually: SSE frames end on a blank line and
                        // AsyncLineSequence's blank-line behavior isn't guaranteed.
                        for try await byte in bytes {
                            if Task.isCancelled { break }
                            guard byte == 0x0A else {
                                lineBuf.append(byte)
                                continue
                            }
                            if lineBuf.last == 0x0D { lineBuf.removeLast() }
                            let line = String(decoding: lineBuf, as: UTF8.self)
                            lineBuf.removeAll(keepingCapacity: true)
                            if line.isEmpty {
                                if !dataLines.isEmpty {
                                    let data = Data(dataLines.joined(separator: "\n").utf8)
                                    continuation.yield(.event(name: eventName, data: data))
                                }
                                eventName = "message"
                                dataLines = []
                            } else if line.hasPrefix("event:") {
                                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                            } else if line.hasPrefix("data:") {
                                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                            }
                            // lines starting with ":" are keep-alive comments — ignored
                        }
                        if Task.isCancelled { break }
                        throw URLError(.networkConnectionLost) // clean EOF still means reconnect
                    } catch {
                        if Task.isCancelled { break }
                        continuation.yield(.disconnected(retryIn: backoff))
                        try? await Task.sleep(for: .seconds(backoff))
                        backoff = min(backoff * 1.8, 30)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
