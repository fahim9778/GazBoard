package com.gazboard.sync

import java.io.BufferedInputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/** The desktop speaks fixed-length HTTP/1.1 JSON over a local TCP socket.
 * Payloads are authenticated and encrypted by Protocol, before this layer.
 * No cookies, proxies, redirects, filesystem paths, or general URL fetching.
 */
internal object LocalHttp {
  data class Head(val line: String, val headers: Map<String, String>, val length: Int)
  data class Reply(val status: Int, val body: JsonObject) {
    val ok: Boolean get() = status in 200..299
  }
  fun head(input: InputStream): Head {
    var used = 0
    fun line(): String {
      val bytes = ArrayList<Byte>()
      while (true) {
        val c = input.read()
        require(c >= 0 && ++used <= 16384) { "Invalid HTTP headers" }
        if (c == 10) return bytes.toByteArray().toString(Charsets.US_ASCII).trimEnd('\r')
        bytes.add(c.toByte())
      }
    }
    val first = line()
    val headers = linkedMapOf<String, String>()
    while (true) {
      val s = line()
      if (s.isEmpty()) break
      val at = s.indexOf(':')
      require(at > 0)
      val key = s.substring(0, at).lowercase(Locale.ROOT)
      require(key !in headers) { "Duplicate HTTP header" }
      headers[key] = s.substring(at + 1).trim()
    }
    require("transfer-encoding" !in headers) { "Fixed-length requests required" }
    val length = headers["content-length"]?.toIntOrNull() ?: if ("content-length" in headers) -1 else 0
    require(length >= 0)
    return Head(first, headers, length)
  }
  fun read(input: InputStream, length: Int, limit: Int, progress: (Int, Int) -> Unit = { _, _ -> }): ByteArray {
    require(length in 0..limit) { "Board is too large to send" }
    val out = ByteArray(length)
    var at = 0
    var last = 0L
    while (at < length) {
      val count = input.read(out, at, minOf(64 * 1024, length - at))
      require(count > 0) { "Transfer was interrupted" }
      at += count
      val now = System.currentTimeMillis()
      if (at == length || now - last >= 120) { progress(at, length); last = now }
    }
    return out
  }
  fun reply(socket: Socket, status: Int, body: JsonObject) {
    val bytes = body.toString().toByteArray()
    val header = "HTTP/1.1 $status Result\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    socket.getOutputStream().run { write(header.toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
  }
  fun request(address: String, port: Int, path: String, body: JsonObject? = null,
    timeout: Int = 30_000, progress: (Int, Int) -> Unit = { _, _ -> }): Reply {
    require(address.isNotBlank() && address.length <= 253 && address.none { it.isWhitespace() || it in "/\\@?#" }) { "Enter a device's network address" }
    require(port in 1..65535)
    val bytes = body?.toString()?.toByteArray()
    require((bytes?.size ?: 0) <= LanNode.MAX_BOARD_BYTES) { "Board is too large to send" }
    Socket().use { socket ->
      socket.connect(InetSocketAddress(address, port), minOf(timeout, 5000))
      socket.soTimeout = timeout
      val from = (body?.get("aad") as? JsonObject)?.str("from")
      require(from == null || from.matches(Regex("[A-Za-z0-9_-]{1,128}")))
      val header = "${if (body == null) "GET" else "POST"} $path HTTP/1.1\r\nHost: $address:$port\r\nConnection: close\r\n" +
        (if (from != null) "X-GazBoard-From: $from\r\n" else "") +
        (if (bytes != null) "Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\n" else "") + "\r\n"
      val out = socket.getOutputStream()
      out.write(header.toByteArray(Charsets.US_ASCII))
      if (bytes != null) {
        var at = 0
        var last = 0L
        while (at < bytes.size) {
          val size = minOf(64 * 1024, bytes.size - at)
          out.write(bytes, at, size)
          at += size
          val now = System.currentTimeMillis()
          if (at == bytes.size || now - last >= 120) { progress(at, bytes.size); last = now }
        }
      }
      out.flush()
      val input = BufferedInputStream(socket.getInputStream())
      val head = head(input)
      val status = head.line.split(' ').getOrNull(1)?.toIntOrNull() ?: error("Not a GazBoard reply")
      return Reply(status, parse(read(input, head.length, 64 * 1024).toString(Charsets.UTF_8)).obj())
    }
  }
}
