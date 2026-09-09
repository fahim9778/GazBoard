package com.gazboard.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import com.gazboard.sync.*
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** Files are capabilities, never renderer-supplied filesystem paths. */
class BridgeFiles(private val context: Context) {
  companion object { const val MAX_BYTES = 128 * 1024 * 1024 }
  private val root = File(context.cacheDir, "bridge").apply { mkdirs() }
  private data class Blob(val file: File, val expected: Long, var complete: Boolean = false)
  data class Grant(val uri: Uri, val name: String, val writable: Boolean)
  private val blobs = ConcurrentHashMap<String, Blob>()
  private val grants = ConcurrentHashMap<String, Grant>()
  init { root.listFiles()?.forEach { it.delete() } }

  @Synchronized fun begin(size: Long): String {
    require(size in 0..MAX_BYTES.toLong() && blobs.size < 32) { "Temporary file limit reached; finish this import first" }
    require(blobs.values.sumOf { it.expected } + size <= MAX_BYTES.toLong() * 2) { "Temporary files are too large" }
    val token = Protocol.deviceId()
    blobs[token] = Blob(File(root, token).apply { createNewFile() }, size)
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
  fun release(token: String): Boolean { blobs.remove(token)?.file?.delete(); return true }
  fun put(bytes: ByteArray): String {
    val token = begin(bytes.size.toLong())
    try { blobs[token]!!.file.writeBytes(bytes); finish(token); return token }
    catch (e: Exception) { release(token); throw e }
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

  fun register(uri: Uri, flags: Int = 0, writable: Boolean = false): String {
    require(uri.scheme == "content") { "Choose a file using Android's file picker" }
    if (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0) {
      runCatching { context.contentResolver.takePersistableUriPermission(uri,
        flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) }
    }
    var name = "document"
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) name = it.getString(0) ?: name
    }
    name = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(200)
    if (!name.contains('.')) {
      val mime = context.contentResolver.getType(uri)
      MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name += ".$it" }
    }
    val id = Protocol.hex(MessageDigest.getInstance("SHA-256").digest(uri.toString().toByteArray()))
    val handle = "gazboard-file://$id/$name"
    grants[handle] = Grant(uri, name, writable || grants[handle]?.writable == true)
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
