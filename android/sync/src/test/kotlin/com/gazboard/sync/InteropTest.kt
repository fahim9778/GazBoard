package com.gazboard.sync

import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.*
import kotlin.test.*

private class Desktop : AutoCloseable {
  private val process = ProcessBuilder("node", "test/android-peer.js").redirectError(ProcessBuilder.Redirect.INHERIT).start()
  private val input = process.inputStream.bufferedReader()
  private val output = process.outputStream.bufferedWriter()
  private var sequence = 0
  fun call(method: String, args: Any? = null): JsonElement {
    output.write(json("id" to ++sequence, "method" to method, "args" to args).toString() + "\n"); output.flush()
    val response = parse(input.readLine() ?: error("Desktop process exited")).obj()
    if (response["error"] != null) error(response.str("error"))
    return response["result"] ?: JsonNull
  }
  override fun close() { runCatching { output.close() }; process.destroyForcibly() }
}
private class MemoryPairs : PairedStore {
  private val records = ConcurrentHashMap<String, JsonObject>()
  override fun get(id: String) = records[id]
  override fun set(id: String, record: JsonObject) { records[id] = record }
  override fun remove(id: String) { records.remove(id) }
  override fun all() = records.values.toList()
}

class InteropTest {
  @Test fun `X25519 HKDF HMAC and AES GCM agree byte for byte with Node`() {
    Desktop().use { desktop ->
      val them = desktop.call("keys").obj()
      val keys = Protocol.keys()
      val us = json("deviceId" to Protocol.deviceId(), "publicKey" to keys.publicKey)
      val key = Protocol.deriveKey(keys, them.str("publicKey"), us, them)
      val plain = "Lesson বাংলা 🖊️\nA/B\u0000".toByteArray()
      val aad = json("from" to us.str("deviceId"), "kind" to "board", "v" to 1, "port" to 53318, "name" to "বাংলা 🖊️ / \n")
      val sealed = Protocol.seal(key, aad, plain)
      val reply = desktop.call("proof", json("us" to them, "them" to us, "code" to " abcd-2345 ",
        "envelope" to sealed, "plain" to Protocol.b64(plain))).obj()
      assertEquals(Protocol.b64(key), reply.str("key"))
      assertEquals(Protocol.confirmation("ABCD2345", us, them, "responder"), reply.str("proof"))
      assertEquals(Protocol.fingerprint(key), reply.str("fingerprint"))
      assertEquals(Protocol.b64(plain), reply.str("opened"))
      assertContentEquals(plain, Protocol.open(key, reply["sealed"]!!.obj()))
      assertNull(Protocol.open(key, sealed.with("aad" to aad.with("name" to "changed"))))
      assertNull(Protocol.open(key, sealed.with("tag" to Protocol.b64(ByteArray(16)))))
      assertNull(Protocol.open(key, sealed.with("v" to 2)))
      assertNull(Protocol.open(Protocol.bytes(32), sealed))
    }
  }
  @Test fun `Android initiates pairing and exchanges image boards with desktop`() {
    val incoming = mutableListOf<JsonObject>()
    val pairs = MemoryPairs()
    LanNode(Protocol.deviceId(), "Android", pairs, { board, _ -> incoming.add(board); "saved" }, host = "127.0.0.1", preferredPort = 0, discoveryPort = 0).use { android ->
      Desktop().use { desktop ->
        android.start()
        val peer = desktop.call("start").obj()
        val room = desktop.call("pairing", json("remember" to true)).obj()
        val paired = android.pairWith(peer, room.str("code"))
        assertTrue(paired.bool("remember"))
        assertTrue(android.stillPaired(peer) == true)
        val board = json("id" to "lesson-1", "name" to "বাংলা lesson", "schema" to 2,
          "objects" to listOf(json("id" to "image-1", "type" to "image", "src" to "data:image/png;base64," + Protocol.b64(Protocol.bytes(2 * 1024 * 1024)))))
        val progress = mutableListOf<Int>()
        assertTrue(android.send(peer, board) { sent, _ -> progress.add(sent) }.bool("accepted"))
        assertTrue(progress.size > 0)
        assertEquals(board, desktop.call("incoming").jsonArray[0].obj()["board"])
        val target = json("deviceId" to android.deviceId, "address" to "127.0.0.1", "port" to android.port)
        assertTrue(desktop.call("send", json("peer" to target, "board" to board)).obj().bool("accepted"))
        assertEquals(board, incoming.single())
        desktop.call("decline")
        assertFalse(android.send(peer, board).bool("accepted"))
        assertTrue(android.unpair(peer.str("deviceId")))
        assertEquals(0, desktop.call("devices").jsonArray.size)
        assertFalse(android.stillPaired(peer) == true)
      }
    }
  }
  @Test fun `Desktop initiates pairing and temporary pairs end on both sides`() {
    val pairs = MemoryPairs()
    LanNode(Protocol.deviceId(), "Android", pairs, { _, _ -> "saved" }, host = "127.0.0.1", preferredPort = 0, discoveryPort = 0).use { android ->
      Desktop().use { desktop ->
        android.start()
        val peer = desktop.call("start").obj()
        val room = android.beginPairing()
        val target = json("deviceId" to android.deviceId, "address" to "127.0.0.1", "port" to android.port)
        desktop.call("pair", json("peer" to target, "code" to room.str("code")))
        assertTrue(android.stillPaired(peer) == true)
        assertFalse(pairs.all().single().bool("remember"))
        assertEquals(1, android.endSession())
        assertEquals(JsonPrimitive(false), desktop.call("stillPaired", target))
        assertEquals(0, desktop.call("devices").jsonArray.size)
      }
    }
  }
  @Test fun `Wrong codes are rejected and throttled without closing the room`() {
    LanNode(Protocol.deviceId(), "Android", MemoryPairs(), { _, _ -> null }, host = "127.0.0.1", preferredPort = 0, discoveryPort = 0).use { android ->
      Desktop().use { desktop ->
        android.start(); desktop.call("start")
        android.beginPairing()
        val peer = json("deviceId" to android.deviceId, "address" to "127.0.0.1", "port" to android.port)
        repeat(5) { assertFails { desktop.call("pair", json("peer" to peer, "code" to "ZZZZ-ZZZZ")) } }
        val error = assertFails { desktop.call("pair", json("peer" to peer, "code" to "ZZZZ-ZZZZ")) }
        assertTrue(error.message!!.contains("Too many"))
        assertTrue(android.pairedDevices().isEmpty())
      }
    }
  }
  @Test fun `Discovery keeps typed addresses and rejects invalid announcements`() {
    LanNode(Protocol.deviceId(), "Android", MemoryPairs(), { _, _ -> null }).use { android ->
      val message = json("t" to "gazboard", "v" to 1, "id" to "peer", "name" to "Desktop", "port" to 53318,
        "a" to listOf("192.168.1.9"))
      android.notePeer(message, "169.254.1.2")
      assertEquals("192.168.1.9", android.list()[0].obj().str("address"))
      android.notePeer(message, "192.168.1.10", true)
      android.notePeer(message, "192.168.1.9")
      assertEquals("192.168.1.10", android.list()[0].obj().str("address"))
      android.notePeer(message.with("v" to 99, "id" to "invalid"), "192.168.1.11")
      assertEquals(1, android.list().size)
      assertFalse(android.running)
    }
  }
  @Test fun `Unknown senders and oversized requests fail before body reads`() {
    LanNode(Protocol.deviceId(), "Android", MemoryPairs(), { _, _ -> fail("Unpaired board reached UI") }, host = "127.0.0.1", preferredPort = 0, discoveryPort = 0).use { android ->
      android.start()
      val envelope = Protocol.seal(Protocol.bytes(32), json("from" to "unknown", "kind" to "board", "v" to 1), "{}".toByteArray())
      assertEquals(401, LocalHttp.request("127.0.0.1", android.port, "/send", envelope).status)
      java.net.Socket("127.0.0.1", android.port).use { socket ->
        socket.soTimeout = 2000
        socket.getOutputStream().write("POST /send HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999999999\r\n\r\n".toByteArray())
        assertTrue(socket.getInputStream().bufferedReader().readLine().contains("413"))
      }
    }
  }
}
