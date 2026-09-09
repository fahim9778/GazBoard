package com.gazboard.app

import android.graphics.Color
import android.graphics.pdf.PdfDocument
import android.webkit.WebView
import android.widget.FrameLayout
import com.gazboard.sync.*
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonObject
import kotlin.math.roundToInt

/** The shared DOCX/PPTX readers, paginated in an isolated WebView and drawn
 * into Android's public PdfDocument API. No hidden printing callbacks.
 */
class DocumentConverter(private val activity: MainActivity, val fileHandle: String) {
  private val app = activity.application as GazBoardApplication
  private val completion = CompletableFuture<JsonObject>()
  private var web: WebView? = null
  private var bridge: NativeBridge? = null
  private val output = File(activity.cacheDir, "conversion-${Protocol.deviceId()}.pdf")
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
        activity.frame.addView(view, 0, FrameLayout.LayoutParams(800, 1132))
        view.loadUrl("${MainActivity.ORIGIN}/assets/board/android-convert.html?file=" +
          android.net.Uri.encode(fileHandle) + "&kind=" + extension)
      }
      val options = completion.get(90, TimeUnit.SECONDS)
      val width = options["widthMm"]?.toString()?.toDoubleOrNull() ?: 210.0
      val height = options["heightMm"]?.toString()?.toDoubleOrNull() ?: 297.0
      val pages = options.num("pages", 1)
      require(width in 10.0..1000.0 && height in 10.0..1000.0 && pages in 1..300) { "This document is too large to convert" }
      val density = activity.resources.displayMetrics.density
      val pixelWidth = (width / 25.4 * 96 * density).roundToInt()
      val pixelHeight = (height / 25.4 * 96 * density).roundToInt()
      activity.onMain { web!!.layoutParams = FrameLayout.LayoutParams(pixelWidth, pixelHeight) }
      val pdf = PdfDocument()
      var closed = false
      try {
        for (index in 0 until pages) {
          val painted = CompletableFuture<Boolean>()
          activity.onMain {
            val view = web ?: error("Conversion closed")
            view.evaluateJavascript("window.gazboardConvertPage($index)") {
              view.postVisualStateCallback(index.toLong(), object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) {
                  if (closed) return
                  try {
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder((width / 25.4 * 72).roundToInt(),
                      (height / 25.4 * 72).roundToInt(), index + 1).create())
                    try {
                      page.canvas.drawColor(Color.WHITE)
                      page.canvas.save()
                      page.canvas.scale(page.info.pageWidth.toFloat() / view.width, page.info.pageHeight.toFloat() / view.height)
                      view.draw(page.canvas)
                      page.canvas.restore()
                    } finally { pdf.finishPage(page) }
                    painted.complete(true)
                  } catch (e: Exception) { painted.completeExceptionally(e) }
                }
              })
            }
          }
          painted.get(15, TimeUnit.SECONDS)
        }
        output.outputStream().use { pdf.writeTo(it) }
      } finally { activity.onMain { closed = true; pdf.close() } }
      require(output.length() > 0) { "Android produced an empty PDF" }
      return json("ok" to true, "engine" to "builtin", "name" to name, "token" to app.files.copy(output.inputStream()))
    } finally {
      activity.onMain {
        bridge?.dispose()
        web?.let { activity.frame.removeView(it); it.destroy() }; web = null
      }
      output.delete()
    }
  }
  fun failed(message: String) { completion.completeExceptionally(IllegalStateException(message)) }
  fun ready(options: JsonObject) { completion.complete(options) }
}
