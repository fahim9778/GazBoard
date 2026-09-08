package com.gazboard.app

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.gazboard.sync.*
import kotlinx.serialization.json.*

/** Only the bundled top-level HTTPS document gets a native API. An imported
 * document's conversion view has a separate, deliberately smaller contract.
 */
class NativeBridge(private val activity: MainActivity, private val web: WebView,
  private val converter: DocumentConverter? = null) {
  private val app = activity.application as GazBoardApplication
  @Volatile private var reply: JavaScriptReplyProxy? = null
  @Volatile private var disposed = false
  private val allowedConversion = setOf("fs:readFile", "blob:release", "convert:ready", "convert:error")
  fun attach() {
    check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "Update Android System WebView to open GazBoard" }
    WebViewCompat.addWebMessageListener(web, "GazBoardNative", setOf(MainActivity.ORIGIN)) { _, message, origin, mainFrame, proxy ->
      if (disposed || !mainFrame || origin.scheme != "https" || origin.host != "appassets.androidplatform.net") return@addWebMessageListener
      val text = message.data ?: return@addWebMessageListener
      if (text.length > 200000) return@addWebMessageListener
      reply = proxy
      app.io.execute {
        var id = ""
        try {
          val request = parse(text).obj()
          id = request.str("id")
          val method = request.str("method")
          require(id.matches(Regex("[0-9]{1,16}")))
          if (converter != null) require(method in allowedConversion) { "Unavailable during conversion" }
          val argsFile = request.str("argsFile")
          val args = if (argsFile.isEmpty()) request["args"] ?: JsonNull
            else parse(app.files.file(argsFile).readText())
          val result = dispatch(method, args)
          respond(json("id" to id), result)
        } catch (e: Exception) {
          post(json("id" to id, "error" to (e.cause?.message ?: e.message ?: "Could not complete this operation")))
        }
      }
    }
  }
  fun dispose() { disposed = true; reply = null }
  fun event(name: String, result: JsonElement) {
    app.io.execute { runCatching { respond(json("event" to name), result) } }
  }
  private fun respond(header: JsonObject, result: Any?) {
    val value = value(result)
    val encoded = value.toString()
    val response = if (encoded.length > 128000) header.with("resultFile" to app.files.put(encoded.toByteArray()))
      else header.with("result" to value)
    post(response)
  }
  private fun post(message: JsonObject) {
    app.main.post { if (!disposed) runCatching { reply?.postMessage(message.toString()) } }
  }
  private fun dispatch(method: String, arg: JsonElement): Any? {
    fun obj() = arg as? JsonObject ?: json()
    fun str() = (arg as? JsonPrimitive)?.contentOrNull ?: ""
    val s = app.storage
    val f = app.files
    val node = app.node
    return when (method) {
      "app:info" -> json("version" to BuildConfig.VERSION_NAME, "platform" to "android", "electron" to null,
        "chrome" to WebViewCompat.getCurrentWebViewPackage(activity)?.versionName, "libreoffice" to false,
        "userData" to "On this Android device", "smoke" to false, "isWeb" to false, "isAndroid" to true,
        "capabilities" to json("lan" to true, "nativeFiles" to true, "office" to listOf("docx", "pptx", "txt")))
      "blob:begin" -> json("token" to f.begin(obj().long("size", -1)))
      "blob:append" -> f.append(obj().str("token"), obj().long("offset", -1), obj().str("data"))
      "blob:finish" -> f.finish(obj().str("token"))
      "blob:release" -> f.release(obj().str("token"))
      "fs:readFile" -> {
        if (converter != null) require(str() == converter.fileHandle)
        json("token" to f.read(str()))
      }
      "fs:writeFile" -> f.write(obj().str("filePath"), obj().str("token"))
      "dialog:open" -> activity.pickFiles(obj(), false)
      "dialog:save" -> activity.pickFiles(obj(), true).firstOrNull()
      "shell:showItem" -> activity.shareFile(str())
      "shell:openBoards" -> { event("showBoards", JsonNull); true }
      "shell:openExternal" -> activity.openReleases(str())
      "updates:check" -> activity.checkForUpdate()
      "boards:list" -> s.list()
      "boards:load" -> s.load(str())
      "boards:save" -> s.save(obj())
      "boards:delete" -> s.remove(str())
      "boards:last" -> s.last()
      "boards:setLast" -> s.setLast(str())
      "boards:resume" -> s.resume()
      "boards:migrate" -> json("migrated" to 0)
      "assets:put" -> s.putAsset(str())
      "assets:get" -> s.getAsset(str())
      "assets:have" -> s.haveAssets(arg as? JsonArray ?: JsonArray(emptyList()))
      "sync:state" -> node.state().with("error" to app.identity.loadError)
      "sync:start" -> activity.startSharing()
      "sync:stop" -> app.stopSharing()
      "sync:setName" -> app.identity.setName(str()).also { node.deviceName = it }
      "sync:beginPairing" -> node.beginPairing(obj())
      "sync:cancelPairing" -> { node.cancelPairing(); true }
      "sync:pairWith" -> json("ok" to true, "device" to node.pairWith(obj()["peer"]!!.obj(), obj().str("code")))
      "sync:addByAddress" -> json("ok" to true, "peer" to node.addByAddress(str()))
      "sync:send" -> json("ok" to true, "result" to node.send(obj()["peer"]!!.obj(), obj()["board"]!!.obj()) { sent, total ->
        event("sendProgress", json("sent" to sent, "total" to total))
      })
      "sync:stillPaired" -> node.stillPaired(obj())
      "sync:unpair" -> json("ok" to true, "told" to node.unpair(str()))
      "sync:endSession" -> node.endSession()
      "sync:answer" -> app.answer(obj().str("ticket"), obj().str("outcome").ifEmpty { null })
      "import:toPdf" -> activity.convertDocument(str())
      "convert:ready" -> { converter?.ready(obj()); true }
      "convert:error" -> { converter?.failed(obj().str("message")); true }
      "app:ready" -> { activity.editorReady(); true }
      "app:flushed" -> { activity.flushed(obj().str("ticket")); true }
      "app:background" -> { activity.background(); true }
      else -> error("Unknown Android operation")
    }
  }
}
