package com.gazboard.app

import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.*
import android.webkit.WebView
import android.widget.FrameLayout
import com.gazboard.sync.*
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonObject

/** The desktop's DOCX/PPTX readers, followed by Android's PDF print backend. */
class DocumentConverter(private val activity: MainActivity, val fileHandle: String) {
  private val app = activity.application as GazBoardApplication
  private val completion = CompletableFuture<File>()
  private val cancellation = CancellationSignal()
  private var web: WebView? = null
  private var bridge: NativeBridge? = null
  private var adapter: PrintDocumentAdapter? = null
  private var descriptor: ParcelFileDescriptor? = null
  private val output = File(activity.cacheDir, "conversion-${Protocol.deviceId()}.pdf")
  private var printing = false
  fun convert(): JsonObject {
    val name = app.files.grant(fileHandle).name
    val extension = name.substringAfterLast('.').lowercase()
    require(extension in listOf("docx", "pptx", "txt")) {
      "${extension.uppercase()} conversion is not available on Android yet. Export this document to PDF, then insert the PDF."
    }
    try {
      activity.onMain {
        val view = activity.createWebView()
        web = view
        bridge = NativeBridge(activity, view, this).also { it.attach() }
        // Behind the editor, but attached and laid out so fonts and images can
        // finish loading before WebView creates its print document.
        activity.frame.addView(view, 0, FrameLayout.LayoutParams(800, 1132))
        view.loadUrl("${MainActivity.ORIGIN}/assets/board/android-convert.html?file=" +
          android.net.Uri.encode(fileHandle) + "&kind=" + extension)
      }
      val file = completion.get(120, TimeUnit.SECONDS)
      require(file.length() > 0) { "Android produced an empty PDF" }
      return json("ok" to true, "engine" to "builtin", "name" to name, "token" to app.files.copy(file.inputStream()))
    } finally {
      activity.onMain {
        cancellation.cancel()
        descriptor?.close(); descriptor = null
        adapter?.onFinish()
        bridge?.dispose()
        web?.let { activity.frame.removeView(it); it.destroy() }; web = null
      }
      output.delete()
    }
  }
  fun failed(message: String) { completion.completeExceptionally(IllegalStateException(message)) }
  fun ready(options: JsonObject) {
    app.main.post {
      if (printing || completion.isDone) return@post
      printing = true
      try {
        val width = (options["widthMm"]?.toString()?.toDoubleOrNull() ?: 210.0)
        val height = (options["heightMm"]?.toString()?.toDoubleOrNull() ?: 297.0)
        require(width in 10.0..2000.0 && height in 10.0..2000.0)
        val attributes = PrintAttributes.Builder()
          .setMediaSize(PrintAttributes.MediaSize("gazboard", "Document", (width / 25.4 * 1000).toInt(), (height / 25.4 * 1000).toInt()))
          .setResolution(PrintAttributes.Resolution("pdf", "PDF", 300, 300))
          .setMinMargins(PrintAttributes.Margins.NO_MARGINS).setColorMode(PrintAttributes.COLOR_MODE_COLOR).build()
        val printer = web!!.createPrintDocumentAdapter("GazBoard document")
        adapter = printer
        printer.onStart()
        printer.onLayout(null, attributes, cancellation, object : PrintDocumentAdapter.LayoutResultCallback() {
          override fun onLayoutFinished(info: PrintDocumentInfo, changed: Boolean) {
            try {
              val fd = ParcelFileDescriptor.open(output, ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_READ_WRITE)
              descriptor = fd
              printer.onWrite(arrayOf(PageRange.ALL_PAGES), fd, cancellation, object : PrintDocumentAdapter.WriteResultCallback() {
                override fun onWriteFinished(pages: Array<out PageRange>) { completion.complete(output) }
                override fun onWriteFailed(error: CharSequence?) { failed(error?.toString() ?: "Could not write document PDF") }
                override fun onWriteCancelled() { failed("Document conversion was cancelled") }
              })
            } catch (e: Exception) { failed(e.message ?: "Could not write document PDF") }
          }
          override fun onLayoutFailed(error: CharSequence?) { failed(error?.toString() ?: "Could not lay out this document") }
          override fun onLayoutCancelled() { failed("Document conversion was cancelled") }
        }, null)
      } catch (e: Exception) { failed(e.message ?: "Could not convert this document") }
    }
  }
}
