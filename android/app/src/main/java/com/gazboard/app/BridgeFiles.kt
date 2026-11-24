package com.gazboard.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import com.gazboard.sync.*
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToStream

/** Files are capabilities, never renderer-supplied filesystem paths. */
class BridgeFiles(private val context: Context) {
  companion object {
    const val MAX_BYTES = 128 * 1024 * 1024
    /**
     * A file the page is SAVING - a lesson video, a replay - may be bigger: it goes
     * straight from this temporary file to the place the person chose, a piece at
     * a time, and is never read into memory or treated as anything the app opens.
     */
    const val MAX_SAVE_BYTES = 1024L * 1024 * 1024

    /**
     * Some Android document providers de-duplicate a custom extension as
     * "Board.gazboard (1)" instead of the conventional "Board (1).gazboard".
     * The former no longer has a .gazboard extension, so Android and GazBoard
     * both stop recognizing it as a board. Keep the provider's number, but move
     * it back in front of the extension.
     */
    fun normalizeBoardDuplicateName(name: String): String {
      val m = Regex("""^(.+)\.(gazboard|openboard)\s*\((\d+)\)$""", RegexOption.IGNORE_CASE)
        .matchEntire(name) ?: return name
      return "${m.groupValues[1].trimEnd()} (${m.groupValues[3]}).${m.groupValues[2]}"
    }
  }
  private val root = File(context.cacheDir, "bridge").apply { mkdirs() }
  private data class Blob(val file: File, val expected: Long, var complete: Boolean = false, val forSaving: Boolean = false)
  data class Grant(val uri: Uri, val name: String, val writable: Boolean)
  private val blobs = ConcurrentHashMap<String, Blob>()
  private val grants = ConcurrentHashMap<String, Grant>()
  init { root.listFiles()?.forEach { it.delete() } }

  @Synchronized fun begin(size: Long, forSaving: Boolean = false): String {
    val cap = if (forSaving) MAX_SAVE_BYTES else MAX_BYTES.toLong()
    require(size in 0..cap && blobs.size < 32) { "Temporary file limit reached; finish this import first" }
    // files being saved stream out to their place and are never held in memory, so they do not count here
    require(blobs.values.filter { !it.forSaving }.sumOf { it.expected } + (if (forSaving) 0 else size) <= MAX_BYTES.toLong() * 2) { "Temporary files are too large" }
    if (forSaving) require(root.usableSpace > size + 64L * 1024 * 1024) { "Not enough free space on this phone to save it" }
    val token = Protocol.deviceId()
    blobs[token] = Blob(File(root, token).apply { createNewFile() }, size, forSaving = forSaving)
    return token
  }
  @Synchronized fun append(token: String, offset: Long, data: String): Boolean {
    val blob = blobs[token] ?: error("Unknown temporary file")
    require(!blob.complete && blob.file.length() == offset && data.length <= 140000) { "Invalid file chunk" }
    val bytes = Protocol.unb64(data)
    require(offset + bytes.size <= blob.expected)
    blob.file.appendBytes(bytes)
    return true
  }
  @Synchronized fun finish(token: String): Boolean {
    val blob = blobs[token] ?: error("Unknown temporary file")
    require(blob.file.length() == blob.expected) { "Incomplete file" }
    blob.complete = true
    return true
  }
  fun file(token: String): File = blobs[token]?.takeIf { it.complete }?.file ?: error("File is no longer available")
  /** A temporary file the app is about to READ (a request, a board): never one of the big ones being saved. */
  fun readable(token: String): File = blobs[token]?.takeIf { it.complete && !it.forSaving }?.file ?: error("File is no longer available")
  fun release(token: String): Boolean { blobs.remove(token)?.file?.delete(); return true }
  fun put(bytes: ByteArray): String {
    val token = begin(bytes.size.toLong())
    try { blobs[token]!!.file.writeBytes(bytes); finish(token); return token }
    catch (e: Exception) { release(token); throw e }
  }
  /**
   * Write JSON straight into a temporary file, never holding it as one long
   * string - a board with its linked boards and their pictures can be tens of
   * megabytes, and three copies of that at once is how a phone runs out of
   * memory. Returns the token, or null if it came to `inlineBelow` bytes or
   * fewer, in which case `small` gets the text to send inline instead.
   */
  @OptIn(ExperimentalSerializationApi::class)
  fun putJson(element: JsonElement, inlineBelow: Int, small: (String) -> Unit): String? {
    val token = Protocol.deviceId()
    val file = File(root, token)
    try {
      file.outputStream().buffered().use { Json.encodeToStream(JsonElement.serializer(), element, it) }
      val size = file.length()
      if (size <= inlineBelow) { small(file.readText()); file.delete(); return null }
      require(size <= MAX_BYTES) { "This board is larger than 128 MB" }
      synchronized(this) {
        require(blobs.size < 32) { "Temporary file limit reached" }
        blobs[token] = Blob(file, size, complete = true)
      }
      return token
    } catch (e: Throwable) { file.delete(); throw e }
  }
  fun copy(input: InputStream): String {
    val target = File(root, Protocol.deviceId())
    try {
      input.use { source -> target.outputStream().use { out ->
        val buf = ByteArray(64 * 1024)
        var count = 0L
        while (true) {
          val n = source.read(buf)
          if (n < 0) break
          count += n
          require(count <= MAX_BYTES) { "This file is larger than 128 MB" }
          out.write(buf, 0, n)
        }
      } }
      val token = begin(target.length())
      target.inputStream().use { source -> blobs[token]!!.file.outputStream().use { out -> source.copyTo(out) } }
      finish(token)
      return token
    } finally { target.delete() }
  }
  fun response(token: String): WebResourceResponse? = runCatching {
    WebResourceResponse("application/octet-stream", null, 200, "OK",
      mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), file(token).inputStream())
  }.getOrNull()

  private fun displayName(uri: Uri): String? {
    var name: String? = null
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) name = it.getString(0)
    }
    return name
  }

  private fun persistGrant(uri: Uri, flags: Int) {
    if (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION == 0) return
    runCatching { context.contentResolver.takePersistableUriPermission(uri,
      flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) }
  }

  fun register(uri: Uri, flags: Int = 0, writable: Boolean = false): String {
    require(uri.scheme == "content") { "Choose a file using Android's file picker" }
    persistGrant(uri, flags)

    var actualUri = uri
    var providerName = displayName(actualUri) ?: "document"
    val normalized = normalizeBoardDuplicateName(providerName)

    /*
     * ACTION_CREATE_DOCUMENT deliberately refuses to overwrite. Most Android
     * providers turn a duplicate Board.gazboard into Board (1).gazboard, but
     * some put the number after the extension: Board.gazboard (1). If this is
     * a document we just created for writing, ask the provider to fix that real
     * on-disk/display name immediately. Failure is harmless: the internal name
     * below is still normalized so GazBoard can use the file this session.
     */
    if (writable && normalized != providerName && DocumentsContract.isDocumentUri(context, actualUri)) {
      val renamed = runCatching {
        DocumentsContract.renameDocument(context.contentResolver, actualUri, normalized)
      }.getOrNull()
      if (renamed != null) {
        actualUri = renamed
        persistGrant(actualUri, flags)
        providerName = displayName(actualUri) ?: normalized
      }
    }

    // Also normalize when opening an older malformed copy. This is only the
    // capability's display name; the provider file itself is untouched unless
    // it was the writable save case above.
    var name = normalizeBoardDuplicateName(providerName)
      .replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(200)
    if (!name.contains('.')) {
      val mime = context.contentResolver.getType(actualUri)
      MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name += ".$it" }
    }
    val id = Protocol.hex(MessageDigest.getInstance("SHA-256").digest(actualUri.toString().toByteArray()))
    val handle = "gazboard-file://$id/$name"
    grants[handle] = Grant(actualUri, name, writable || grants[handle]?.writable == true)
    return handle
  }
  fun grant(handle: String): Grant = grants[handle] ?: error("This file permission expired. Open the file again.")
  fun read(handle: String): String = copy(context.contentResolver.openInputStream(grant(handle).uri) ?: error("Could not open file"))
  fun write(handle: String, token: String): Boolean {
    val grant = grant(handle)
    require(grant.writable) { "This file was not chosen for saving" }
    context.contentResolver.openOutputStream(grant.uri, "wt")?.use { out -> file(token).inputStream().use { it.copyTo(out) } }
      ?: error("Could not write the selected file")
    return true
  }
}
