import AppKit
import Foundation
import WebKit

func requiredInfo(_ key: String) -> String {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
          !value.isEmpty else {
        fatalError("Missing Codeex configuration: \(key)")
    }
    return value
}

func requiredPath(_ key: String) -> String {
    let value = requiredInfo(key)
    let bundlePrefix = "@bundle/"
    if value.hasPrefix(bundlePrefix) {
        return Bundle.main.bundleURL
            .appendingPathComponent(String(value.dropFirst(bundlePrefix.count))).path
    }
    return value
}

func optionalPath(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
          !value.isEmpty else {
        return nil
    }
    let bundlePrefix = "@bundle/"
    if value.hasPrefix(bundlePrefix) {
        return Bundle.main.bundleURL
            .appendingPathComponent(String(value.dropFirst(bundlePrefix.count))).path
    }
    return value
}

final class CodeexDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var pluginWindow: NSWindow?
    private var server: Process?
    private var logHandle: FileHandle?
    private var controlURL: URL?
    private var pluginCenterURL: URL?
    private var controlToken = ""
    private var statusItem: NSStatusItem?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let url = try startServer()
            configureControl(url)
            installStatusMenu()
            // Launching the app is an explicit foreground action. Runtime
            // preparation remains background-only; this activation is scoped
            // to the user's open/reopen request.
            showCodeex()
        } catch {
            showFatalError(error)
        }
    }

    private func startServer() throws -> URL {
        let projectRoot = requiredPath("CodeexProjectRoot")
        let nodePath = requiredPath("CodeexNodePath")
        let fileManager = FileManager.default
        let supportRoot = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Codeex", isDirectory: true)
        let runtimeMode = Bundle.main.object(forInfoDictionaryKey: "CodeexRuntimeMode") as? String
            ?? "local-clone"
        let embeddedRuntime = runtimeMode == "embedded"
        let workRoot: URL
        let runtimeApp: URL
        let runtimeExecutable: String
        let runtimeBundleIdentifier: String
        let runtimeDisplayName: String
        let launcherDist: URL?
        if embeddedRuntime {
            workRoot = URL(fileURLWithPath: projectRoot, isDirectory: true)
            runtimeApp = Bundle.main.bundleURL
            runtimeExecutable = runtimeApp.appendingPathComponent("Contents/MacOS/CodeexRuntime").path
            runtimeBundleIdentifier = Bundle.main.bundleIdentifier ?? "ai.lovstudio.codeex"
            runtimeDisplayName = "Codeex"
            launcherDist = nil
        } else {
            let officialApp = URL(fileURLWithPath: "/Applications/ChatGPT.app", isDirectory: true)
            guard fileManager.fileExists(atPath: officialApp.path) else {
                throw NSError(
                    domain: "Codeex",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "请先安装并至少启动一次官方 Codex（/Applications/ChatGPT.app），然后重新打开 Codeex。"]
                )
            }
            workRoot = supportRoot.appendingPathComponent("Runtime", isDirectory: true)
            runtimeApp = workRoot.appendingPathComponent(".runtime/Codeex.app", isDirectory: true)
            runtimeExecutable = runtimeApp.appendingPathComponent("Contents/MacOS/ChatGPT").path
            runtimeBundleIdentifier = "ai.lovstudio.codeex.runtime"
            runtimeDisplayName = "Codeex"
            launcherDist = URL(
                fileURLWithPath: optionalPath("CodeexLauncherDist")
                    ?? URL(fileURLWithPath: projectRoot, isDirectory: true)
                        .appendingPathComponent("launcher-ui", isDirectory: true).path,
                isDirectory: true
            )
        }
        let logDirectory = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Codeex", isDirectory: true)
        try fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let logFile = logDirectory.appendingPathComponent("supervisor.log")
        if !fileManager.fileExists(atPath: logFile.path) {
            _ = fileManager.createFile(atPath: logFile.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: logFile)
        try log.seekToEnd()
        self.logHandle = log

        let output = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["scripts/launcher-server.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        var environment = ProcessInfo.processInfo.environment
        let toolDirectories = [URL(fileURLWithPath: nodePath).deletingLastPathComponent().path]
        environment["PATH"] = toolDirectories.joined(separator: ":") + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        environment["CODEEX_WRAPPER_MODE"] = "1"
        environment["CODEEX_APPLICATION_PATH"] = runtimeApp.path
        environment["CODEEX_LAUNCHER_APPLICATION_PATH"] = Bundle.main.bundlePath
        environment["CODEEX_WORK_ROOT"] = workRoot.path
        if let launcherDist { environment["CODEEX_LAUNCHER_DIST"] = launcherDist.path }
        environment["CODEEX_RUNTIME_APP"] = runtimeApp.path
        environment["CODEEX_RUNTIME_EXECUTABLE"] = runtimeExecutable
        environment["CODEEX_RUNTIME_BUNDLE_IDENTIFIER"] = runtimeBundleIdentifier
        environment["CODEEX_RUNTIME_DISPLAY_NAME"] = runtimeDisplayName
        environment["CODEEX_RUNTIME_STATE"] = supportRoot.appendingPathComponent("runtime.json").path
        environment["CODEEX_SUPERVISOR_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["CODEEX_CODEX_CLI"] = runtimeApp
            .appendingPathComponent("Contents/Resources/codex").path
        environment["CODEEX_LAUNCHED_FROM_FINDER"] = "1"
        environment["CODEEX_FULL_DISK_ACCESS"] = hasFullDiskAccess() ? "1" : "0"
        process.environment = environment
        process.standardOutput = output
        process.standardError = log
        try process.run()
        self.server = process

        var line = Data()
        let reader = output.fileHandleForReading
        while process.isRunning {
            guard let byte = try reader.read(upToCount: 1), !byte.isEmpty else { break }
            if byte[byte.startIndex] == 10 { break }
            line.append(byte)
            if line.count > 16_384 {
                throw NSError(domain: "Codeex", code: 2, userInfo: [NSLocalizedDescriptionKey: "Codeex 服务返回了无效响应。"])
            }
        }
        guard process.isRunning else {
            throw NSError(domain: "Codeex", code: 3, userInfo: [NSLocalizedDescriptionKey: "Codeex 服务提前退出，请查看 ~/Library/Logs/Codeex/supervisor.log。"])
        }
        let payload = try JSONSerialization.jsonObject(with: line) as? [String: Any]
        guard let value = payload?["url"] as? String, let url = URL(string: value) else {
            throw NSError(domain: "Codeex", code: 4, userInfo: [NSLocalizedDescriptionKey: "Codeex 服务没有返回有效地址。"])
        }
        return url
    }

    private func configureControl(_ url: URL) {
        pluginCenterURL = url
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        controlToken = components?.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
        var origin = URLComponents()
        origin.scheme = url.scheme
        origin.host = url.host
        origin.port = url.port
        controlURL = origin.url
    }

    private func installStatusMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "cube.transparent.fill", accessibilityDescription: "Codeex")
            button.toolTip = "Codeex"
        }
        let menu = NSMenu()
        let product = NSMenuItem(title: "Codeex · 完整 Codex", action: nil, keyEquivalent: "")
        product.isEnabled = false
        menu.addItem(product)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "显示 Codeex", action: #selector(showCodeex), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "插件中心…", action: #selector(showPluginCenter), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "完全磁盘访问权限…", action: #selector(openFullDiskAccessSettings), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重启 Codeex", action: #selector(restartCodeex), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 Codeex", action: #selector(quitCodeex), keyEquivalent: "q"))
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        statusItem = item
    }

    private func request(_ path: String, method: String = "GET", completion: @escaping (Data?) -> Void) {
        guard let url = controlURL?.appendingPathComponent(path) else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(controlToken, forHTTPHeaderField: "X-Codeex-Token")
        URLSession.shared.dataTask(with: request) { data, _, _ in completion(data) }.resume()
    }

    private func activateRuntime(attemptsRemaining: Int) {
        request("api/status") { [weak self] data in
            guard let self else { return }
            var application: NSRunningApplication?
            if let data,
               let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let runtime = payload["runtime"] as? [String: Any],
               let enhanced = runtime["enhancedCodex"] as? [String: Any],
               let number = enhanced["pid"] as? NSNumber {
                application = NSRunningApplication(
                    processIdentifier: pid_t(number.intValue)
                )
            }
            if let application {
                DispatchQueue.main.async {
                    application.activate(options: [.activateAllWindows])
                }
            } else if attemptsRemaining > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.activateRuntime(attemptsRemaining: attemptsRemaining - 1)
                }
            }
        }
    }

    @objc private func showCodeex() {
        request("api/launch", method: "POST") { [weak self] _ in
            self?.activateRuntime(attemptsRemaining: 120)
        }
    }

    @objc private func showPluginCenter() {
        guard let url = pluginCenterURL else { return }
        if let pluginWindow {
            pluginWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Codeex 插件中心"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 900, height: 620)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("CodeexPluginCenterWindow")
        window.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: url))
        pluginWindow = window
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func restartCodeex() {
        request("api/restart", method: "POST") { _ in }
    }

    private func hasFullDiskAccess() -> Bool {
        let database = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
        do {
            let handle = try FileHandle(forReadingFrom: database)
            _ = try handle.read(upToCount: 1)
            try? handle.close()
            return true
        } catch {
            return false
        }
    }

    @objc private func openFullDiskAccessSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quitCodeex() {
        quitting = true
        if let server, server.isRunning { server.terminate() }
        NSApp.terminate(nil)
    }

    private func showFatalError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Codeex 无法启动"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "知道了")
        alert.runModal()
        quitting = true
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if !quitting, let server, server.isRunning { server.terminate() }
        try? logHandle?.close()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showCodeex()
        return true
    }
}

let app = NSApplication.shared
let delegate = CodeexDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
