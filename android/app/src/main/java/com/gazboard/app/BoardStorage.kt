package com.gazboard.app

import android.content.Context
import android.util.AtomicFile
import com.gazboard.sync.*
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Native durable storage. A failed save leaves the previous board readable. */
class BoardStorage(context: Context) {
  private val root = File(context.filesDir, "boards").apply { mkdirs() }
  private val assets = File(context.filesDir, "assets").apply { mkdirs() }
  private val pointer = AtomicFile(File(context.filesDir, "last-board.json"))
  private val idPattern = Regex("[A-Za-z0-9_-]{1,128}")
  private val assetPattern = Regex("[a-f0-9]{64}\\.[a-z0-9]{1,8}")
  private val extensions = mapOf("image/png" to "png", "image/jpeg" to "jpg", "image/webp" to "webp",
    "image/gif" to "gif", "image/svg+xml" to "svg", "image/bmp" to "bmp", "image/avif" to "avif")
  private fun boardFile(id: String): AtomicFile {
    require(idPattern.matches(id)) { "Invalid board id" }
    return AtomicFile(File(root, "$id.json"))
  }
  @Synchronized fun load(id: String): JsonObject? = runCatching {
    parse(boardFile(id).readFully().toString(Charsets.UTF_8)).obj()
  }.getOrNull()
  @Synchronized fun list(): JsonArray {
    val ids = root.listFiles().orEmpty().map { it.name.removeSuffix(".bak") }
      .filter { it.endsWith(".json") }.map { it.removeSuffix(".json") }.distinct()
    return JsonArray(ids.mapNotNull { id ->
      val board = load(id) ?: return@mapNotNull null
      json("id" to id, "name" to board.str("name", "Untitled board"), "modified" to File(root, "$id.json").lastModified(),
        "objects" to when (val objects = board["objects"]) { is JsonArray -> objects.size; is JsonObject -> objects.size; else -> 0 },
        "thumb" to board["thumb"], "origin" to board["origin"])
    }.sortedByDescending { it.long("modified") })
  }
  @Synchronized fun save(payload: JsonObject): Boolean {
    val text = payload.str("json").ifEmpty { payload.toString() }
    val board = parse(text).obj()
    val id = payload.str("id")
    require(id == board.str("id")) { "Board id does not match its contents" }
    writeAtomic(boardFile(id), text.toByteArray())
    // Only point at a board after its file reached disk successfully.
    if (payload.bool("setLast", true)) setLast(id)
    return true
  }
  @Synchronized fun remove(id: String): Boolean {
    boardFile(id).delete()
    if (last() == id) pointer.delete()
    return true
  }
  @Synchronized fun last(): String? = runCatching {
    parse(pointer.readFully().toString(Charsets.UTF_8)).jsonPrimitive.content
  }.getOrNull()
  @Synchronized fun setLast(id: String): Boolean {
    require(idPattern.matches(id))
    writeAtomic(pointer, JsonPrimitive(id).toString().toByteArray())
    return true
  }
  @Synchronized fun resume(): JsonObject {
    last()?.let { id -> load(id)?.let { return json("board" to it, "reason" to "pointer") } }
    val candidates = list().map { it.obj() }
    val newest = candidates.firstOrNull { it.num("objects") > 0 } ?: candidates.firstOrNull()
    return if (newest == null) json("board" to null, "reason" to "none")
      else json("board" to load(newest.str("id")), "reason" to if (newest.num("objects") > 0) "newest" else "empty")
  }
  @Synchronized fun putAsset(dataUrl: String): JsonObject? = runCatching {
    val comma = dataUrl.indexOf(',')
    require(comma in 5..150 && dataUrl.substring(0, comma).endsWith(";base64"))
    val mime = dataUrl.substring(5, comma).removeSuffix(";base64").lowercase()
    val extension = extensions[mime] ?: "bin"
    val bytes = Protocol.unb64(dataUrl.substring(comma + 1))
    require(bytes.isNotEmpty())
    val id = Protocol.hex(MessageDigest.getInstance("SHA-256").digest(bytes)) + "." + extension
    val file = AtomicFile(File(assets, id))
    if (!file.baseFile.exists()) writeAtomic(file, bytes)
    json("id" to id)
  }.getOrNull()
  @Synchronized fun getAsset(id: String): String? = runCatching {
    require(assetPattern.matches(id))
    val mime = extensions.entries.firstOrNull { it.value == id.substringAfterLast('.') }?.key ?: "application/octet-stream"
    "data:$mime;base64," + Protocol.b64(AtomicFile(File(assets, id)).readFully())
  }.getOrNull()
  @Synchronized fun haveAssets(ids: JsonArray): JsonObject = JsonObject(ids.associate {
    val id = it.jsonPrimitive.content
    id to JsonPrimitive(assetPattern.matches(id) && File(assets, id).exists())
  })
  companion object {
    fun writeAtomic(file: AtomicFile, bytes: ByteArray) {
      val stream = file.startWrite()
      try { stream.write(bytes); file.finishWrite(stream) }
      catch (e: Exception) { file.failWrite(stream); throw e }
    }
  }
}
