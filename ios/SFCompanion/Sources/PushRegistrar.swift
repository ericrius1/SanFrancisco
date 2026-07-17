import Foundation
import UIKit

/// APNs device-token registration. Optional: works only in builds signed with
/// a push-capable provisioning profile AND when the server has APNs keys
/// configured. Everything else in the app functions without it.
final class PushRegistrar: NSObject {
    static let shared = PushRegistrar()

    var registerURL: URL? {
        didSet { sendRegistration() }
    }
    private var tokenHex: String?

    func enablePush() {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func handleToken(_ deviceToken: Data) {
        tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        sendRegistration()
    }

    private func sendRegistration() {
        guard let url = registerURL, let token = tokenHex else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "platform": "ios"])
        URLSession.shared.dataTask(with: request).resume()
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushRegistrar.shared.handleToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected in simulator / profiles without the push entitlement.
        print("[push] registration unavailable: \(error.localizedDescription)")
    }
}
