import SwiftUI

@main
struct SFCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var monitor = WorldMonitor()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(monitor)
                .preferredColorScheme(.dark)
                .onAppear { monitor.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            monitor.scenePhaseChanged(phase)
        }
    }
}
