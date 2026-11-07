import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coldStartObserver: NSObjectProtocol?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PasoFiBridgeViewController()

        // Preserve Capacitor's cold-start delivery timing, while consuming payment return
        // URLs before any plugin can forward their query parameters to the WebView.
        NotificationCenter.default.post(name: .capacitorSceneWillConnect, object: scene)
        coldStartObserver = NotificationCenter.default.addObserver(
            forName: .capacitorViewDidAppear, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            if let observer = self.coldStartObserver {
                NotificationCenter.default.removeObserver(observer)
                self.coldStartObserver = nil
            }
            self.scene(scene, openURLContexts: connectionOptions.urlContexts)
            for activity in connectionOptions.userActivities {
                self.scene(scene, continue: activity)
            }
        }
        // Install the observer before making the view visible, so a fast cold start
        // cannot deliver capacitorViewDidAppear before the owned URL filter exists.
        window?.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let otherURLs = Set(URLContexts.filter { !PasoFiStripePlugin.consumeReturnURL($0.url) })
        if !otherURLs.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: otherURLs)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    deinit {
        if let observer = coldStartObserver { NotificationCenter.default.removeObserver(observer) }
    }
}
