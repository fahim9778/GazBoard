package com.gazboard.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.*
import android.view.DragAndDropPermissions
import android.view.DragEvent
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
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import com.gazboard.sync.*
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.*
import kotlinx.serialization.json.*

class MainActivity : ComponentActivity() {
  companion object {
    const val ORIGIN = "https://appassets.androidplatform.net"
    /** Beyond this a pasted picture is left on the clipboard rather than carried. */
    const val CLIPBOARD_IMAGE_CAP = 12 * 1024 * 1024
    const val ENTRY = "$ORIGIN/assets/board/index.html"
    /**
     * The only two places the Chinese font may come from, and the only shape
     * its name may have. The page itself can reach no website at all (see
     * shouldInterceptRequest), so the one download it is allowed goes through
     * here, and nothing else does.
     */
    val FONT_SOURCES = listOf(
      "https://cdn.jsdelivr.net/gh/fahim9778/GazBoard@main/fonts/",
      "https://raw.githubusercontent.com/fahim9778/GazBoard/main/fonts/")
    val FONT_FILE = Regex("gazboard-noto-sans-(sc|tc)-[0-9]{3}-v[0-9]{1,3}\\.woff2")
    const val FONT_CAP = 8 * 1024 * 1024
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
  private val dropGrants = mutableListOf<DragAndDropPermissions>()
  private var folderPicker: CompletableFuture<Uri?>? = null
  private val folderLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val waiting = folderPicker
    folderPicker = null
    val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
    // kept across restarts: the copy goes on being written there until the person says stop
    if (uri != null) runCatching {
      contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }
    waiting?.complete(uri)
  }
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
    /*
     * A Word or PowerPoint file is converted by laying each page out in a
     * WebView the size of the page and drawing that WebView into a PDF page.
     * An A4 page at the phone's pixel density is about twice as wide as the
     * screen, and since Android 5 a WebView draws only the part of itself that
     * is on screen unless told otherwise - so the PDF got the top-left corner
     * of every page, blown up to fill it: "zoomed and cropped". This makes it
     * draw the whole page. It has to be said before the first WebView in the
     * app exists, which is why it is the first thing here; the board itself is
     * one screen of canvas, so drawing "all of it" costs it nothing.
     */
    WebView.enableSlowWholeDocumentDraw()
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
      /*
       * Do not let the WebView invert the page for us.
       *
       * Algorithmic darkening is Android's own guess at a dark theme: it
       * flips colours it has never seen and knows nothing about. GazBoard has
       * a real dark mode that decides, deliberately, which ink follows the
       * board and which colours are the user's own - all of which an automatic
       * inversion would undo, turning chosen reds into cyans and yellow sticky
       * notes into blue ones.
       *
       * Switching it OFF does not stop the page going dark. The WebView still
       * reports prefers-color-scheme from this activity's theme, so with
       * values-night in place the stylesheet does the work itself, properly.
       */
      if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
        WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
      }
      isFocusableInTouchMode = true
      setOnDragListener { _, event -> onFileDrag(event) }
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
  /*
   * Files dragged across from another app: Files, Gallery, a browser's
   * downloads, in split screen, from a tablet's taskbar or on DeX.
   *
   * A WebView does not hand files from other apps to the page, so they are
   * caught here and sent the way an "Open with" file is: Android gives a
   * content address, BridgeFiles turns it into a handle the page can read, and
   * the page imports it exactly as Add or Open would. Only drags that carry
   * something other than text are taken; selected text being dragged about
   * stays the WebView's business, as before.
   */
  private fun carriesFiles(d: ClipDescription?): Boolean =
    d != null && (0 until d.mimeTypeCount).any { !d.getMimeType(it).startsWith("text/") }

  private fun onFileDrag(event: DragEvent): Boolean {
    if (!carriesFiles(event.clipDescription)) return false
    if (event.action != DragEvent.ACTION_DROP) return true
    val clip = event.clipData ?: return true
    // reading another app's file needs its say-so, granted only during the drop; it lasts until this screen closes
    requestDragAndDropPermissions(event)?.let { dropGrants += it }
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { it.scheme == "content" }
    if (uris.isEmpty() || !ready) return true
    val density = resources.displayMetrics.density
    val x = event.x / density
    val y = event.y / density
    app.io.execute {
      val handles = uris.mapNotNull { uri -> runCatching { app.files.register(uri) }.getOrNull() }
      if (handles.isEmpty()) {
        app.main.post { Toast.makeText(this, "Could not read the dropped file", Toast.LENGTH_LONG).show() }
        return@execute
      }
      bridge.event("drop", buildJsonObject {
        put("files", JsonArray(handles.map { JsonPrimitive(it) }))
        put("x", x)
        put("y", y)
      })
    }
    return true
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
  /** Android's own folder picker, opening at `start` when given (the folder in use), else Documents. Null when the person backed out. */
  fun pickFolder(start: Uri? = null): Uri? {
    val result = CompletableFuture<Uri?>()
    onMain {
      check(folderPicker == null) { "Finish choosing the folder first" }
      folderPicker = result
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      // open on the folder already in use, as other apps do, or else Documents, the place people look for their
      // own files; a suggestion only, any folder can be picked.
      // No storage permission is involved: the picker hands over this one folder and nothing else.
      runCatching { intent.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, start ?:
        android.provider.DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Documents")) }
      try { folderLauncher.launch(intent) } catch (e: Exception) { folderPicker = null; throw e }
    }
    return try { result.get(5, TimeUnit.MINUTES) }
      finally { app.main.post { if (folderPicker === result) folderPicker = null } }
  }
  /**
   * Show a folder in the phone's Files app. Most phones' Files app opens a folder handed over this way;
   * false when none on this phone does, so the page can say where to look instead.
   */
  fun openFolder(folder: Uri): Boolean {
    val result = CompletableFuture<Boolean>()
    onMain {
      val view = Intent(Intent.ACTION_VIEW).setDataAndType(folder, android.provider.DocumentsContract.Document.MIME_TYPE_DIR)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      result.complete(try { startActivity(view); true } catch (e: Exception) { false })
    }
    return result.get(10, TimeUnit.SECONDS)
  }
  fun pickFiles(options: JsonObject, save: Boolean): List<String> {
    val result = CompletableFuture<List<String>>()
    onMain {
      check(picker == null) { "Finish the open file picker first" }
      picker = result
      saving = save
      val extensions = (options["filters"] as? JsonArray)?.firstOrNull()?.obj()?.get("extensions") as? JsonArray
      val extensionNames = extensions?.map { it.jsonPrimitive.content.lowercase() } ?: emptyList()
      val mappedTypes = extensionNames.map { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
      val types = mappedTypes.filterNotNull().distinct()
      val allExtensionsHaveMime = extensionNames.isNotEmpty() && mappedTypes.all { it != null }
      val boardExport = save && options.str("defaultPath").substringAfterLast('.').lowercase() in listOf("gazboard", "openboard")
      // Android has no registered MIME for .gazboard/.openboard. If even one
      // requested extension is unknown, use */* so the document provider does
      // not hide boards that it labels as generic binary data. The importer
      // still validates the selected file after the picker returns it.
      val mime = if (boardExport) "application/x-gazboard"
        else if (allExtensionsHaveMime && types.size == 1) types[0] else "*/*"
      val intent = Intent(if (save) Intent.ACTION_CREATE_DOCUMENT else Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mime
        if (save) putExtra(Intent.EXTRA_TITLE, options.str("defaultPath", "Board.gazboard").substringAfterLast('/').substringAfterLast('\\'))
        else {
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, (options["properties"] as? JsonArray)?.any { it.jsonPrimitive.content == "multiSelections" } == true)
          if (allExtensionsHaveMime && types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        if (save) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      }
      try { pickerLauncher.launch(intent) } catch (e: Exception) { picker = null; throw e }
    }
    return try { result.get(5, TimeUnit.MINUTES) }
      finally { app.main.post { if (picker === result) picker = null } }
  }
  /**
   * Paint Android's own chrome to match the theme GazBoard is showing.
   *
   * values-night already handles the case where the phone decides. This is the
   * other case: GazBoard's setting can OVERRIDE the phone - somebody on a light
   * phone who wants a dark board, or the reverse - and when it does, the status
   * bar, the navigation bar and the window behind the WebView have to come
   * along, or a dark board sits in a light frame.
   *
   * "system" hands the decision back to the phone by reading the configuration
   * we were given, which is the same thing values-night is keyed on.
   */
  fun applyChromeTheme(want: String): Boolean {
    val dark = when (want) {
      "dark" -> true
      "light" -> false
      else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES
    }
    app.main.post {
      val bar = if (dark) 0xFF1B1A19.toInt() else 0xFFF5F5F8.toInt()
      window.statusBarColor = bar
      window.navigationBarColor = bar
      window.decorView.setBackgroundColor(bar)
      val bars = WindowCompat.getInsetsController(window, window.decorView)
      // light BARS means dark icons on them - the opposite of the theme name
      bars.isAppearanceLightStatusBars = !dark
      bars.isAppearanceLightNavigationBars = !dark
    }
    return true
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
  /**
   * Read a phone build out of a release tag: android-2.6.6-v2 -> [2, 6, 6, 2].
   *
   * Anything else - a desktop tag, a hand-typed tag, a tag from some other
   * project - answers null and is passed over rather than guessed at.
   */
  private fun androidBuild(tag: String): IntArray? {
    val m = Regex("""^android-(\d+)\.(\d+)\.(\d+)-v(\d+)$""").find(tag) ?: return null
    return intArrayOf(m.groupValues[1].toInt(), m.groupValues[2].toInt(),
      m.groupValues[3].toInt(), m.groupValues[4].toInt())
  }

  private fun laterBuild(a: IntArray, b: IntArray): Boolean {
    for (i in 0..3) if (a[i] != b[i]) return a[i] > b[i]
    return false
  }

  /**
   * Ask GitHub which phone build is newest.
   *
   * One repository publishes two kinds of release - v2.6.6 for the desktop,
   * android-2.6.6-v2 for the phone - and GitHub's idea of the latest release
   * is simply whichever went out most recently. Asking it that question gave
   * an Android user a desktop tag half the time and an unreadable one the
   * rest, and both answers came back as "you are up to date" on a build that
   * was two releases old.
   *
   * So the list is fetched and walked here instead. A release counts only if
   * it carries an APK - nothing must ever send a phone user to an installer
   * it cannot run - and only if its tag names a phone build. The highest
   * build wins, not the most recent, and the version handed back is written
   * the way the app writes its own (2.6.6-android.2) so the two can be
   * compared at all. With nothing eligible in the list, the app's own version
   * is returned, which reads as "nothing to do" and is the safe answer.
   */
  /**
   * What the phone's clipboard is holding, as far as the board needs to know.
   *
   * Three answers at once. The words, when there are words. The picture, when
   * there is a picture. And a signature that is only ever compared with an
   * earlier one: unchanged since objects were copied on the board means nothing
   * has been copied anywhere since, so those objects are still the newest.
   *
   * The words are taken ONLY from a clip that says it holds words.
   * coerceToText looks like the obliging way to ask - it is not. Handed a
   * picture, it opens the file behind the clip and reads the bytes as
   * characters, so pasting a copied photo produced a text box full of rubbish
   * several megabytes long, and a board too heavy to draw on. It is not a
   * converter; it is a reader that never says no.
   *
   * Android only hands the clipboard to an app that is in front, which is
   * exactly when this is called - a menu the user just opened. Refused or empty
   * comes back as an empty description rather than an error, because "nothing
   * to paste" is an ordinary answer and not a fault.
   */
  fun readClipboard(): JsonObject = onMain {
    val nothing = json("text" to "", "image" to "", "kind" to "", "signature" to "")
    try {
      val manager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val clip = manager.primaryClip
      if (clip == null || clip.itemCount == 0) return@onMain nothing
      val description = clip.description
      val kinds = (0 until (description?.mimeTypeCount ?: 0))
        .mapNotNull { description?.getMimeType(it) }.sorted().joinToString("|")
      val items = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it) }

      // text/plain and text/html only - NOT text/*, which also covers
      // text/uri-list. A copied photo is often described that way, and taking
      // it as words put a content:// address on the board instead of a picture.
      val saysWords = description?.hasMimeType("text/plain") == true
        || description?.hasMimeType("text/html") == true
      val text = if (!saysWords) "" else items
        .mapNotNull { it.text?.toString() ?: it.coerceToText(this)?.toString() }
        .joinToString("\n").trim()

      // A picture comes across as a handle to a file, so it is read here and
      // handed over as the picture itself. Anything beyond the cap is left
      // alone rather than dragged through the bridge and onto the board.
      /*
       * Ask the file what it is, rather than trusting the clip's own label.
       *
       * A photo copied from a gallery arrives as a handle, and the clip
       * describes itself as anything from image/jpeg to text/uri-list
       * depending on which app did the copying. Believing the label meant a
       * screenshot looked like nothing at all, and paste quietly handed back
       * whatever the board had copied earlier. The handle is the reliable part:
       * resolve it, and if what comes back is a picture, it is a picture.
       */
      var image = ""
      var kind = ""
      val uri = items.firstNotNullOfOrNull { it.uri }
      if (uri != null) {
        runCatching {
          val resolved = contentResolver.getType(uri) ?: ""
          if (resolved.startsWith("image/")) {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes != null && bytes.isNotEmpty() && bytes.size <= CLIPBOARD_IMAGE_CAP) {
              kind = resolved
              image = "data:" + resolved + ";base64," +
                java.util.Base64.getEncoder().encodeToString(bytes)
            }
          }
        }
      }

      // The handles count towards the signature even when the picture itself
      // was too big to carry, or copying one would look like copying nothing
      // and the board's own older copy would wrongly stay in front.
      val handles = items.mapNotNull { it.uri?.toString() }.joinToString("|")
      // The formatted copy as well, when the app that copied offered one - it
      // is how bold and colour pasted from Word reach a box on the board.
      val html = if (description?.hasMimeType("text/html") == true)
        items.mapNotNull { it.htmlText }.joinToString("").take(2 * 1024 * 1024) else ""
      json("text" to text, "html" to html, "image" to image, "kind" to kind,
        "signature" to "$kinds\u0000$text\u0000$handles")
    } catch (e: Exception) {
      nothing
    }
  }

  /**
   * Putting something on the phone's clipboard: "Copy as picture" and
   * "Copy text". Only ever called because somebody pressed one of those - an
   * ordinary Copy keeps objects inside the board and never comes here.
   *
   * A picture cannot go on Android's clipboard as pixels; it goes as a handle
   * to a file the app shares out through its FileProvider, the same way a
   * shared export does. Each copy gets a fresh file name, because an app that
   * pasted the last one may still be holding a copy of it under the old name;
   * the older files are cleared out first so they do not pile up.
   *
   * Words go up with their formatting (for Word, Docs, Gmail) and as plain
   * text (for everything else) in the one clip.
   */
  fun writeClipboard(args: JsonObject): Boolean {
    val image = args.str("image")
    var clip: android.content.ClipData? = null
    if (image.startsWith("data:image/")) {
      val bytes = java.util.Base64.getDecoder().decode(image.substringAfter(','))
      if (bytes.isEmpty()) return false
      val folder = java.io.File(cacheDir, "exports").apply { mkdirs() }
      folder.listFiles { f -> f.name.startsWith("clipboard-") }?.forEach { it.delete() }
      val file = java.io.File(folder, "clipboard-${System.currentTimeMillis()}.png")
      file.writeBytes(bytes)
      val uri = androidx.core.content.FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.files", file)
      clip = android.content.ClipData.newUri(contentResolver, "GazBoard", uri)
    } else {
      val text = args.str("text")
      val html = args.str("html")
      if (text.isEmpty() && html.isEmpty()) return false
      clip = if (html.isNotEmpty()) android.content.ClipData.newHtmlText("GazBoard", text, html)
        else android.content.ClipData.newPlainText("GazBoard", text)
    }
    val ready = clip ?: return false
    return onMain {
      val manager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      manager.setPrimaryClip(ready)
      true
    }
  }

  /**
   * Where this copy was installed from. A copy from Google Play (or F-Droid) is
   * updated by that store, and Play's rules say it may update in no other way -
   * so for those the page never looks at GitHub or offers a download. Anything
   * else (the APK from GitHub, a file passed on by hand) is "github".
   */
  fun installStore(): String {
    val installer = runCatching {
      if (Build.VERSION.SDK_INT >= 30) packageManager.getInstallSourceInfo(packageName).installingPackageName
      else @Suppress("DEPRECATION") packageManager.getInstallerPackageName(packageName)
    }.getOrNull()
    return when (installer) {
      "com.android.vending", "com.google.android.feedback" -> "play"
      "org.fdroid.fdroid", "org.fdroid.basic", "com.looker.droidify", "com.machiav3lli.fdroid", "in.sunilpaulmathew.izzyondroid" -> "fdroid"
      else -> "github"
    }
  }
  fun checkForUpdate(): JsonObject {
    // a store copy is the store's to update: report it as current, whatever GitHub has
    if (installStore() != "github") return json("ok" to true, "version" to BuildConfig.VERSION_NAME, "name" to BuildConfig.VERSION_NAME,
      "url" to "https://github.com/fahim9778/GazBoard/releases", "prerelease" to false)
    val connection = URL("https://api.github.com/repos/fahim9778/GazBoard/releases?per_page=30").openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 8000; connection.readTimeout = 8000
      connection.setRequestProperty("Accept", "application/vnd.github+json")
      connection.setRequestProperty("User-Agent", "GazBoard-Android/${BuildConfig.VERSION_NAME}")
      require(connection.responseCode == 200) { "GitHub replied ${connection.responseCode}" }
      val text = connection.inputStream.bufferedReader().use { it.readText() }
      require(text.length < 1024 * 1024)
      val payload = parse(text)
      val releases = payload as? JsonArray ?: JsonArray(listOf(payload))
      var best: JsonObject? = null
      var bestTag = ""
      var bestBuild: IntArray? = null
      for (element in releases) {
        val release = element as? JsonObject ?: continue
        if ((release["draft"] as? JsonPrimitive)?.booleanOrNull == true) continue
        val tag = (release["tag_name"] as? JsonPrimitive)?.contentOrNull ?: continue
        val build = androidBuild(tag) ?: continue
        val hasApk = (release["assets"] as? JsonArray)?.any {
          (it as? JsonObject)?.get("name")?.let { n -> (n as? JsonPrimitive)?.contentOrNull }
            ?.endsWith(".apk") == true
        } == true
        if (!hasApk) continue
        if (bestBuild == null || laterBuild(build, bestBuild!!)) { best = release; bestTag = tag; bestBuild = build }
      }
      val found = best
      val build = bestBuild
      if (found == null || build == null) {
        return json("ok" to true, "version" to BuildConfig.VERSION_NAME,
          "name" to BuildConfig.VERSION_NAME, "url" to "https://github.com/fahim9778/GazBoard/releases",
          "prerelease" to false)
      }
      val version = "${build[0]}.${build[1]}.${build[2]}-android.${build[3]}"
      val name = (found["name"] as? JsonPrimitive)?.contentOrNull ?: bestTag
      // The tag page is where the APK actually is, so that is where to land.
      return json("ok" to true, "version" to version, "name" to name,
        "url" to "https://github.com/fahim9778/GazBoard/releases/tag/" + bestTag,
        "prerelease" to false)
    } finally { connection.disconnect() }
  }
  /**
   * Fetch one Chinese font file for the page. The page checks its fingerprint
   * afterwards, so all this has to do is refuse any other address and say
   * plainly whether the server answered or the phone could not reach it.
   */
  fun downloadFont(address: String, progress: (Long, Long) -> Unit): JsonObject {
    val base = FONT_SOURCES.firstOrNull { address.startsWith(it) } ?: error("Unknown font source")
    require(FONT_FILE.matches(address.removePrefix(base))) { "Unknown font" }
    val connection = URL(address).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 10000; connection.readTimeout = 20000
      connection.useCaches = false
      connection.setRequestProperty("User-Agent", "GazBoard-Android/${BuildConfig.VERSION_NAME}")
      val code = connection.responseCode
      if (code != 200) return json("ok" to false, "status" to code)
      val total = connection.contentLengthLong
      val out = java.io.ByteArrayOutputStream()
      connection.inputStream.use { input ->
        val buf = ByteArray(64 * 1024)
        var got = 0L
        var told = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          got += n
          require(got <= FONT_CAP) { "Unknown font" }
          out.write(buf, 0, n)
          if (got - told >= 256 * 1024) { told = got; progress(got, total) }
        }
        progress(got, total)
      }
      return json("ok" to true, "token" to app.files.put(out.toByteArray()))
    } catch (e: java.io.IOException) {
      return json("ok" to false, "offline" to true)
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
  override fun onPause() { requestFlush(); app.mirror.flushSoon(); app.visible = false; super.onPause() }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (ready) bridge.event("resize", JsonNull)
  }
  override fun onDestroy() {
    dropGrants.forEach { runCatching { it.release() } }
    dropGrants.clear()
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
