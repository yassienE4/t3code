import ExpoModulesCore
import Foundation

public final class T3PreviewTunnelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3PreviewTunnel")

    Function("resolveAccess") { (requestId: String, url: String?) in
      T3TunnelAccess.shared.resolve(requestId: requestId, url: url)
    }

    View(T3TunnelWebView.self) {
      Events("onAccessRequest", "onNavigationChange", "onLoadError")

      Prop("url") { (view: T3TunnelWebView, url: String) in
        view.load(url)
      }

      AsyncFunction("goBack") { (view: T3TunnelWebView) in
        view.goBack()
      }

      AsyncFunction("goForward") { (view: T3TunnelWebView) in
        view.goForward()
      }

      AsyncFunction("reload") { (view: T3TunnelWebView) in
        view.reload()
      }
    }
  }
}

/// Pending asks for a tunnel URL. JavaScript owns the environment's credentials and the route in
/// use, so every connection asks it for a freshly ticketed URL.
final class T3TunnelAccess {
  static let shared = T3TunnelAccess()

  private let lock = NSLock()
  private var pending: [String: (String?) -> Void] = [:]
  private var nextId = 0

  func request(ask: (String) -> Void, completion: @escaping (String?) -> Void) {
    let requestId: String = lock.withLock {
      nextId += 1
      let requestId = "preview-tunnel-\(nextId)"
      pending[requestId] = completion
      return requestId
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak self] in
      self?.resolve(requestId: requestId, url: nil)
    }
    ask(requestId)
  }

  func resolve(requestId: String, url: String?) {
    let completion = lock.withLock { pending.removeValue(forKey: requestId) }
    completion?(url)
  }
}
