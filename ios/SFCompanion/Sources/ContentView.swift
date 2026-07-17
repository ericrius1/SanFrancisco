import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var monitor: WorldMonitor
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ZStack {
                LinearGradient(
                    colors: [Color(red: 0.04, green: 0.07, blue: 0.13), Color(red: 0.09, green: 0.05, blue: 0.16)],
                    startPoint: .top, endPoint: .bottom
                )
                .ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 16) {
                        statusCard
                        playersCard
                        feedCard
                        Text("\(monitor.configSource) · \(monitor.endpoint)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .padding()
                }
            }
            .navigationTitle(monitor.worldName)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsSheet()
                    .environmentObject(monitor)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    private var statusDotColor: Color {
        switch monitor.conn {
        case .live: return .green
        case .retrying: return .orange
        default: return .yellow
        }
    }

    private var statusCard: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(statusDotColor)
                    .frame(width: 10, height: 10)
                    .shadow(color: statusDotColor.opacity(0.8), radius: 5)
                Text(monitor.conn.label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Text("\(monitor.players.count)")
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .contentTransition(.numericText())
                .animation(.snappy, value: monitor.players.count)
            Text(monitor.players.count == 1 ? "explorer in the world" : "explorers in the world")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .background(cardBackground)
    }

    private var playersCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("In the world now", systemImage: "figure.walk")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if monitor.players.isEmpty {
                Text("Nobody roaming right now")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(monitor.players) { player in
                    HStack {
                        Circle()
                            .fill(Color(hue: Double((player.id * 137) % 360) / 360, saturation: 0.7, brightness: 0.9))
                            .frame(width: 8, height: 8)
                        Text(player.name)
                            .font(.callout.weight(.medium))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardBackground)
    }

    private var feedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Activity", systemImage: "bell")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if monitor.feed.isEmpty {
                Text("Waiting for arrivals…")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(monitor.feed) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: icon(for: item.kind))
                            .font(.caption)
                            .foregroundStyle(color(for: item.kind))
                        Text(item.text)
                            .font(.callout)
                        Spacer()
                        Text(item.date, style: .time)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardBackground)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(.white.opacity(0.06))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(.white.opacity(0.08))
            )
    }

    private func icon(for kind: FeedItem.Kind) -> String {
        switch kind {
        case .join: return "arrow.down.forward.circle.fill"
        case .leave: return "arrow.up.backward.circle"
        case .system: return "antenna.radiowaves.left.and.right"
        }
    }

    private func color(for kind: FeedItem.Kind) -> Color {
        switch kind {
        case .join: return .green
        case .leave: return .secondary
        case .system: return .blue
        }
    }
}

struct SettingsSheet: View {
    @EnvironmentObject private var monitor: WorldMonitor
    @Environment(\.dismiss) private var dismiss
    @AppStorage("speakJoins") private var speakJoins = true
    @AppStorage("speakLeaves") private var speakLeaves = false
    @AppStorage("backgroundListening") private var backgroundListening = false
    @AppStorage(ConfigService.overrideKey) private var serverOverride = ""
    @State private var draftOverride = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Announcements") {
                    Toggle("Speak arrivals", isOn: $speakJoins)
                    Toggle("Speak departures", isOn: $speakLeaves)
                    Button("Test voice") {
                        monitor.announcer.speak("Claude entered the world")
                    }
                }
                Section {
                    Toggle("Background listening", isOn: $backgroundListening)
                        .onChange(of: backgroundListening) { _, on in
                            monitor.announcer.setBackgroundListening(on)
                        }
                } footer: {
                    Text("Keeps a silent audio session running so arrivals are announced while the app is in the background. Uses a little more battery.")
                }
                Section {
                    Button("Enable push notifications") {
                        PushRegistrar.shared.enablePush()
                    }
                } footer: {
                    Text("Experimental: lets the server notify this device even when the app is closed. Requires a push-capable build and server-side Apple keys.")
                }
                Section {
                    TextField("https://sanfrancisco.up.railway.app", text: $draftOverride)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Apply & reconnect") {
                        serverOverride = draftOverride.trimmingCharacters(in: .whitespacesAndNewlines)
                        monitor.restart()
                        dismiss()
                    }
                    if !serverOverride.isEmpty {
                        Button("Use default world", role: .destructive) {
                            serverOverride = ""
                            draftOverride = ""
                            monitor.restart()
                            dismiss()
                        }
                    }
                } header: {
                    Text("Server override")
                } footer: {
                    Text("Leave empty to follow the official world config automatically.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { draftOverride = serverOverride }
        }
        .preferredColorScheme(.dark)
    }
}
