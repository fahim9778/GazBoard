package com.gazboard.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.*
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import com.gazboard.sync.*
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.*
import kotlinx.serialization.json.*

class MainActivity : ComponentActivity() {
  companion object {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val ENTRY = "$ORIGIN/assets/board/index.html"
  }
  private val app get() = application as GazBoardApplication
  lateinit var web: WebView; private set
  lateinit var frame: FrameLayout; private set
  private lateinit var bridge: NativeBridge
  private var ready = false
  private var pendingIntent: Intent? = null
  var startupFilePending = false; private set
  private var picker: CompletableFuture<List<String>>? = null
  private var saving = false
  private val flushes = ConcurrentHashMap<String, CompletableFuture<Boolean>>()
  private val conversionSlot = Semaphore(1)
  private var conversion: DocumentConverter? = null
  private val pickerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val waiting = picker
    picker = null
    if (result.resultCode != RESULT_OK || result.data == null) { waiting?.complete(emptyList()); return@registerForActivityResult }
    val intent = result.data!!
    app.io.execute {
      try {
        val uris = if (intent.clipData != null) List(intent.clipData!!.itemCount) { intent.clipData!!.getItemAt(it).uri }
          else listOfNotNull(intent.data)
        waiting?.complete(uris.take(100).map { app.files.register(it, intent.flags, saving) })
      } catch (e: Exception) { waiting?.completeExceptionally(e) }
    }
  }
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    frame = FrameLayout(this)
    setContentView(frame)
    ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
      val handled = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      val safe = insets.getInsets(handled)
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      // The WebView already fits inside this padding. Passing the same insets
      // on makes CSS reserve them again and lifts the toolbar off the bottom.
      // Send zeroes instead of CONSUMED so keyboard changes still reach it;
      // otherwise an old keyboard inset can linger after the keyboard closes.
      WindowInsetsCompat.Builder(insets).setInsets(handled, Insets.NONE).build()
    }
    pendingIntent = intent
    startupFilePending = intent.action in listOf(Intent.ACTION_VIEW, Intent.ACTION_SEND)
    try {
      web = createWebView()
      frame.addView(web, FrameLayout.LayoutParams(-1, -1))
      bridge = NativeBridge(this, web).also { it.attach() }
      app.events = { name, payload -> if (ready) bridge.event(name, payload) }
      web.loadUrl(ENTRY)
    } catch (e: Exception) {
      AlertDialog.Builder(this).setTitle("GazBoard needs an updated WebView")
        .setMessage(e.message).setPositiveButton("Close") { _, _ -> finish() }.show()
    }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (ready) bridge.event("back", JsonNull) else background()
      }
    })
  }
  @SuppressLint("SetJavaScriptEnabled")
  fun createWebView(): WebView {
    val loader = WebViewAssetLoader.Builder()
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
      .addPathHandler("/files/") { token -> app.files.response(token) }
      .build()
    return WebView(this).apply {
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      settings.setSupportMultipleWindows(false)
      settings.javaScriptCanOpenWindowsAutomatically = false
      settings.mediaPlaybackRequiresUserGesture = true
      settings.builtInZoomControls = false
      settings.displayZoomControls = false
      settings.textZoom = 100
      settings.useWideViewPort = true
      isFocusableInTouchMode = true
      overScrollMode = android.view.View.OVER_SCROLL_NEVER
      WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
      webChromeClient = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
      }
      webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
          val url = request.url
          if (url.scheme in listOf("data", "blob")) return null
          if (url.scheme == "https" && url.host == "appassets.androidplatform.net" && request.method == "GET") {
            loader.shouldInterceptRequest(url)?.let { return it }
          }
          return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          // Links in imported documents can never navigate the privileged view.
          return request.url.toString() != ENTRY
        }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          app.events = null
          ready = false
          frame.removeView(view)
          view.destroy()
          AlertDialog.Builder(this@MainActivity).setTitle("Reopen your board")
            .setMessage("Android stopped the editor. Your last saved board will reopen.")
            .setPositiveButton("Reopen") { _, _ -> recreate() }.setCancelable(false).show()
          return true
        }
      }
    }
  }
  fun editorReady() {
    app.main.post {
      ready = true
      dispatchPendingIntent()
      app.resumeQuestions()
    }
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    pendingIntent = intent
    if (ready) dispatchPendingIntent()
  }
  private fun dispatchPendingIntent() {
    val next = pendingIntent ?: return
    pendingIntent = null
    val uri = when (next.action) {
      Intent.ACTION_VIEW -> next.data
      Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33) next.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") next.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    } ?: return
    app.io.execute {
      try { bridge.event("file", JsonPrimitive(app.files.register(uri, next.flags))) }
      catch (e: Exception) { app.main.post { Toast.makeText(this, e.message ?: "Could not open file", Toast.LENGTH_LONG).show() } }
    }
  }
  fun pickFiles(options: JsonObject, save: Boolean): List<String> {
    val result = CompletableFuture<List<String>>()
    onMain {
      check(picker == null) { "Finish the open file picker first" }
      picker = result
      saving = save
      val extensions = (options["filters"] as? JsonArray)?.firstOrNull()?.obj()?.get("extensions") as? JsonArray
      val types = extensions?.mapNotNull { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.jsonPrimitive.content) }?.distinct() ?: emptyList()
      val mime = if (types.size == 1) types[0] else "*/*"
      val intent = Intent(if (save) Intent.ACTION_CREATE_DOCUMENT else Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mime
        if (save) putExtra(Intent.EXTRA_TITLE, options.str("defaultPath", "Board.gazboard").substringAfterLast('/').substringAfterLast('\\'))
        else {
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, (options["properties"] as? JsonArray)?.any { it.jsonPrimitive.content == "multiSelections" } == true)
          // Unknown board extensions use */*, so Android's provider doesn't
          // hide .gazboard files that it labels application/octet-stream.
          if (types.isNotEmpty() && types.size == (extensions?.size ?: 0)) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        if (save) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      }
      try { pickerLauncher.launch(intent) } catch (e: Exception) { picker = null; throw e }
    }
    return try { result.get(5, TimeUnit.MINUTES) }
      finally { app.main.post { if (picker === result) picker = null } }
  }
  fun shareFile(handle: String): Boolean {
    val grant = app.files.grant(handle)
    onMain {
      startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = contentResolver.getType(grant.uri) ?: "application/octet-stream"
        putExtra(Intent.EXTRA_STREAM, grant.uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = android.content.ClipData.newUri(contentResolver, grant.name, grant.uri)
      }, "Share ${grant.name}"))
    }
    return true
  }
  fun openReleases(raw: String): Boolean {
    val url = raw.ifEmpty { "https://github.com/fahim9778/GazBoard/releases" }
    val uri = Uri.parse(url)
    require(uri.scheme == "https" && uri.host == "github.com" &&
      (uri.path == "/fahim9778/GazBoard/releases" || uri.path?.startsWith("/fahim9778/GazBoard/releases/tag/") == true))
    onMain { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    return true
  }
  fun checkForUpdate(): JsonObject {
    val connection = URL("https://api.github.com/repos/fahim9778/GazBoard/releases/latest").openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 8000; connection.readTimeout = 8000
      connection.setRequestProperty("Accept", "application/vnd.github+json")
      connection.setRequestProperty("User-Agent", "GazBoard-Android/${BuildConfig.VERSION_NAME}")
      require(connection.responseCode == 200) { "GitHub replied ${connection.responseCode}" }
      val text = connection.inputStream.bufferedReader().use { it.readText() }
      require(text.length < 1024 * 1024)
      val release = parse(text).obj()
      val apk = (release["assets"] as? JsonArray)?.any { it.obj().str("name").endsWith(".apk") } == true
      // A desktop-only tag must never tell an Android user to install an EXE.
      return json("ok" to true, "version" to if (apk) release.str("tag_name").removePrefix("v") else BuildConfig.VERSION_NAME,
        "name" to release.str("name"), "url" to "https://github.com/fahim9778/GazBoard/releases", "prerelease" to release.bool("prerelease"))
    } finally { connection.disconnect() }
  }
  fun startSharing(): JsonObject {
    try {
      onMain {
        check(app.visible) { "Open GazBoard to turn sharing on" }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
        }
        ContextCompat.startForegroundService(this, Intent(this, SharingService::class.java))
      }
      return app.node.start()
    } catch (e: Exception) {
      app.stopSharing()
      return app.node.state().with("error" to (e.message ?: "Could not start sharing"))
    }
  }
  fun convertDocument(handle: String): JsonObject {
    val ext = app.files.grant(handle).name.substringAfterLast('.').lowercase()
    if (ext == "pdf") return json("ok" to true, "engine" to "native", "name" to app.files.grant(handle).name, "token" to app.files.read(handle))
    check(conversionSlot.tryAcquire()) { "Finish the current document import first" }
    try {
      val converter = DocumentConverter(this, handle)
      conversion = converter
      return converter.convert()
    } finally { conversion = null; conversionSlot.release() }
  }
  fun requestFlush(): CompletableFuture<Boolean> {
    if (!ready) return CompletableFuture.completedFuture(false)
    val ticket = Protocol.deviceId()
    val result = CompletableFuture<Boolean>()
    flushes[ticket] = result
    bridge.event("flush", json("ticket" to ticket))
    app.main.postDelayed({ flushes.remove(ticket)?.complete(false) }, 8000)
    return result
  }
  fun flushed(ticket: String) { flushes.remove(ticket)?.complete(true) }
  fun background() {
    requestFlush().whenComplete { _, _ -> app.main.post { moveTaskToBack(true) } }
  }
  override fun onResume() { super.onResume(); app.visible = true; if (::web.isInitialized) web.onResume() }
  override fun onPause() { requestFlush(); app.visible = false; super.onPause() }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (ready) bridge.event("resize", JsonNull)
  }
  override fun onDestroy() {
    app.events = null
    conversion?.failed("The editor closed during conversion")
    picker?.complete(emptyList()); picker = null
    if (::bridge.isInitialized) bridge.dispose()
    if (::web.isInitialized) { frame.removeView(web); web.destroy() }
    super.onDestroy()
  }
  fun <T> onMain(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val result = CompletableFuture<T>()
    app.main.post { try { result.complete(block()) } catch (e: Exception) { result.completeExceptionally(e) } }
    return result.get(30, TimeUnit.SECONDS)
  }
}
