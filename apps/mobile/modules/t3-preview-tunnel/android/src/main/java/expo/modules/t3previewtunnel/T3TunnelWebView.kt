package expo.modules.t3previewtunnel

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * A webview whose loopback is another environment's: `localhost` requests go to a SOCKS listener
 * in this process, which carries each connection over the environment's tunnel.
 *
 * Android's proxy override applies to every WebView in the app, so it is set while this view is
 * attached and cleared when it detaches. Other webviews here never load loopback pages.
 */
@SuppressLint("SetJavaScriptEnabled")
class T3TunnelWebView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onAccessRequest by EventDispatcher()
  private val onNavigationChange by EventDispatcher()
  private val onLoadError by EventDispatcher()
  private val main = Handler(Looper.getMainLooper())
  private val webView = WebView(context)
  private var listener: SocksListener? = null
  private var proxied = false
  private var pendingUrl: String? = null

  init {
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = report(true)
      override fun onPageFinished(view: WebView, url: String?) = report(false)
      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) =
        report(null)

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
      ) {
        if (!request.isForMainFrame) return
        onLoadError(mapOf("code" to error.errorCode, "description" to error.description.toString()))
      }
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onReceivedTitle(view: WebView, title: String?) = report(null)
    }
    addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private var loading = false

  private fun report(nowLoading: Boolean?) {
    if (nowLoading != null) loading = nowLoading
    onNavigationChange(
      mapOf(
        "url" to (webView.url ?: ""),
        "title" to (webView.title ?: ""),
        "loading" to loading,
        "canGoBack" to webView.canGoBack(),
        "canGoForward" to webView.canGoForward()
      )
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      onLoadError(mapOf("code" to -1, "description" to "This WebView cannot route localhost."))
      return
    }
    val listener = SocksListener {
      TunnelAccess.request { requestId ->
        main.post { onAccessRequest(mapOf("requestId" to requestId)) }
      }
    }
    this.listener = listener
    // `*` loads everything directly, and the implicit-rule removal after it takes loopback back
    // out of that bypass, the same split the desktop app makes with `*,<-loopback>`.
    val onSet = Runnable {
      main.post {
        proxied = true
        pendingUrl?.let { load(it) }
      }
    }
    // Older WebViews reject `socks5://`; their `socks://` is SOCKS4, which the listener also speaks.
    for (scheme in listOf("socks5", "socks")) {
      val config = ProxyConfig.Builder()
        .addProxyRule("$scheme://127.0.0.1:${listener.port}")
        .addBypassRule("*")
        .removeImplicitRules()
        .build()
      val set = runCatching {
        ProxyController.getInstance().setProxyOverride(config, { it.run() }, onSet)
      }
      if (set.isSuccess) return
    }
    onLoadError(mapOf("code" to -1, "description" to "This WebView cannot route localhost."))
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    listener?.close()
    listener = null
    if (proxied) {
      proxied = false
      ProxyController.getInstance().clearProxyOverride({ it.run() }) {}
    }
    webView.destroy()
  }

  fun load(url: String) {
    if (!proxied) {
      pendingUrl = url
      return
    }
    pendingUrl = null
    if (webView.url != url) webView.loadUrl(url)
  }

  fun goBack() = main.post { webView.goBack() }
  fun goForward() = main.post { webView.goForward() }
  fun reload() = main.post { webView.reload() }
}
