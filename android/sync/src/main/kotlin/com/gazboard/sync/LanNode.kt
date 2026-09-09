package com.gazboard.sync

import java.io.BufferedInputStream
import java.net.*
import java.util.concurrent.*
import kotlinx.serialization.json.*

interface PairedStore {
  fun get(id: String): JsonObject?
  fun set(id: String, record: JsonObject)
  fun remove(id: String)
  fun all(): List<JsonObject>
}

/** Android-free transport, tested against the actual desktop sync/node.js.
 * start() is the only operation that opens sockets. Session pairs stay in
 * memory; the platform's PairedStore persists only remembered devices.
 */
class LanNode(
  val deviceId: String,
  @Volatile var deviceName: String,
  private val paired: PairedStore,
  private val onBoard: (JsonObject, JsonObject) -> String?,
  private val onPeers: (JsonArray) -> Unit = {},
  private val onReceiving: (JsonObject) -> Unit = {},
  private val host: String = "0.0.0.0",
  private val preferredPort: Int = TRANSFER_PORT,
  private val discoveryPort: Int = DISCOVERY_PORT
) : AutoCloseable {
  companion object {
    const val TRANSFER_PORT = 53318
    const val DISCOVERY_PORT = 53319
    const val MAX_BOARD_BYTES = 64 * 1024 * 1024
    private val ID = Regex("[A-Za-z0-9_-]{1,128}")
    fun addresses(): List<JsonObject> = runCatching {
      NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
        .flatMap { n -> n.inetAddresses.toList().filterIsInstance<Inet4Address>().map {
          json("name" to n.displayName, "address" to it.hostAddress, "selfAssigned" to it.isLinkLocalAddress)
        } }.sortedBy { it.bool("selfAssigned") }
    }.getOrDefault(emptyList())
    private fun daemon(name: String, block: () -> Unit): Thread = Thread(block, name).apply { isDaemon = true; start() }
  }
  @Volatile var running = false; private set
  @Volatile var port = 0; private set
  @Volatile var discovery = false; private set
  @Volatile private var server: ServerSocket? = null
  @Volatile private var udp: DatagramSocket? = null
  private var timer: ScheduledExecutorService? = null
  private var workers: ThreadPoolExecutor? = null
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()
  private val peers = ConcurrentHashMap<String, JsonObject>()
  private val boardSlot = Semaphore(1)
  private val pairingLock = Any()
  private data class Room(val code: String, val expires: Long, val remember: Boolean,
    val attempts: MutableMap<String, Int> = mutableMapOf(), val failures: MutableList<Long> = mutableListOf())
  private data class Half(val keys: Protocol.Keys, val them: JsonObject, val name: String, val port: Int, val at: Long)
  private var room: Room? = null
  private val halves = linkedMapOf<String, Half>()
  private val received = linkedMapOf<String, Long>()

  fun state(): JsonObject = json("running" to running, "deviceId" to deviceId, "deviceName" to deviceName,
    "port" to port, "expectedPort" to TRANSFER_PORT, "unusualPort" to (running && port != TRANSFER_PORT),
    "discovery" to discovery, "discoveryPort" to discoveryPort, "addresses" to addresses(), "error" to null,
    "peers" to list(), "paired" to pairedDevices())
  fun list(): JsonArray = JsonArray(peers.values.sortedBy { it.str("name") }.map { peer ->
    val record = paired.get(peer.str("deviceId"))
    peer.with("paired" to (record != null), "fingerprint" to record?.let { fingerprint(it) })
  })
  fun pairedDevices(): JsonArray = JsonArray(paired.all().map {
    JsonObject(it - "key").with("fingerprint" to fingerprint(it))
  })
  private fun fingerprint(rec: JsonObject): String = Protocol.fingerprint(Protocol.unb64(rec.str("key")))
  private fun changed() { runCatching { onPeers(list()) } }

  @Synchronized fun start(): JsonObject {
    if (running) return state()
    val listener = ServerSocket()
    try { listener.bind(InetSocketAddress(host, preferredPort)) }
    catch (e: Exception) {
      listener.close()
      if (preferredPort == 0) throw e
      server = ServerSocket(0, 16, InetAddress.getByName(host))
    }
    if (server == null) server = listener
    port = server!!.localPort
    running = true
    workers = ThreadPoolExecutor(8, 8, 30, TimeUnit.SECONDS, ArrayBlockingQueue(16),
      { r -> Thread(r, "GazBoard transfer").apply { isDaemon = true } })
    daemon("GazBoard listener") {
      while (running) {
        val socket = try { server?.accept() ?: break } catch (_: Exception) { break }
        sockets.add(socket)
        try { workers?.execute { handle(socket) } }
        catch (_: RejectedExecutionException) { sockets.remove(socket); socket.close() }
      }
    }
    if (discoveryPort > 0) {
      try {
        val datagram = DatagramSocket(null).apply {
          reuseAddress = true
          broadcast = true
          bind(InetSocketAddress(discoveryPort))
        }
        udp = datagram
        discovery = true
        daemon("GazBoard discovery") {
          val data = ByteArray(4096)
          while (running && !datagram.isClosed) {
            try {
              val packet = DatagramPacket(data, data.size)
              datagram.receive(packet)
              notePeer(parse(String(packet.data, 0, packet.length, Charsets.UTF_8)).obj(), packet.address.hostAddress ?: "")
            } catch (_: Exception) { if (datagram.isClosed) break }
          }
        }
      } catch (_: Exception) { discovery = false }
    }
    timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "GazBoard announcements").apply { isDaemon = true } }
    timer!!.scheduleAtFixedRate({ runCatching { announce() } }, 0, 3, TimeUnit.SECONDS)
    return state()
  }
  @Synchronized fun stop(): JsonObject {
    running = false
    discovery = false
    timer?.shutdownNow(); timer = null
    runCatching { server?.close() }; server = null
    udp?.close(); udp = null
    sockets.forEach { runCatching { it.close() } }; sockets.clear()
    workers?.shutdownNow(); workers = null
    endSession()
    peers.clear()
    port = 0
    changed()
    return state()
  }
  override fun close() { stop() }

  internal fun notePeer(msg: JsonObject, source: String, pinned: Boolean = false) {
    val id = msg.str("id")
    if (msg.str("t") != "gazboard" || msg.num("v") != 1 || !ID.matches(id) || id == deviceId || msg.num("port") !in 1..65535) return
    if (peers.size >= 256 && !peers.containsKey(id)) return
    val before = peers[id]
    val advertised = (msg["a"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
      ?.filter { it.matches(Regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) }?.take(6) ?: emptyList()
    val candidates = (if (pinned) listOf(source) else listOf(source) + advertised).distinct().sortedBy { it.startsWith("169.254.") }
    val best = candidates.firstOrNull() ?: return
    val keep = !pinned && before != null && (before.bool("pinned") || (!before.str("address").startsWith("169.254.") && best.startsWith("169.254.")))
    val address = if (keep) before!!.str("address") else best
    val peer = json("deviceId" to id, "name" to msg.str("name", "Unknown device").take(64),
      "address" to address, "port" to if (keep) before!!.num("port") else msg.num("port"),
      "addresses" to (listOf(address) + candidates).distinct(), "pinned" to (pinned || before?.bool("pinned") == true),
      "seen" to System.currentTimeMillis())
    peers[id] = peer
    if (before == null || before.str("address") != address || before.str("name") != peer.str("name")) changed()
  }
  private fun announce() {
    val cutoff = System.currentTimeMillis() - 12000
    if (peers.entries.removeIf { it.value.long("seen") < cutoff }) changed()
    val bytes = json("t" to "gazboard", "v" to 1, "id" to deviceId, "name" to deviceName,
      "port" to port, "a" to addresses().filter { !it.bool("selfAssigned") }.take(6).map { it.str("address") }).toString().toByteArray()
    val targets = mutableSetOf("255.255.255.255")
    runCatching {
      NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.forEach { n ->
        n.interfaceAddresses.forEach { it.broadcast?.hostAddress?.let(targets::add) }
      }
    }
    targets.forEach { target -> runCatching { udp?.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName(target), discoveryPort)) } }
  }
  fun beginPairing(opts: JsonObject = json()): JsonObject = synchronized(pairingLock) {
    check(running) { "Sharing is switched off" }
    halves.clear()
    val current = Room(Protocol.generateCode(), System.currentTimeMillis() +
      opts.long("ttlMs", Protocol.CODE_TTL_MS).coerceIn(1000, Protocol.CODE_TTL_MS), opts.bool("remember"))
    room = current
    json("code" to current.code, "expiresAt" to current.expires, "remember" to current.remember)
  }
  fun cancelPairing() = synchronized(pairingLock) { room = null; halves.clear() }
  fun endSession(): Int {
    cancelPairing()
    val temporary = paired.all().filter { !it.bool("remember") }
    temporary.forEach { paired.remove(it.str("deviceId")) }
    changed()
    return temporary.size
  }
  private fun noteCaller(id: String, address: String, theirPort: Int) {
    val rec = paired.get(id) ?: return
    if (address.startsWith("169.254.") && rec.str("lastAddress").isNotEmpty() && !rec.str("lastAddress").startsWith("169.254.")) return
    paired.set(id, rec.with("lastAddress" to address, "lastPort" to theirPort.takeIf { it in 1..65535 }.let { it ?: rec.num("lastPort", TRANSFER_PORT) }))
    changed()
  }

  private fun handle(socket: Socket) {
    var ownsBoardSlot = false
    socket.use {
      try {
        socket.soTimeout = 30_000
        val input = BufferedInputStream(socket.getInputStream())
        val head = LocalHttp.head(input)
        val line = head.line.split(' ')
        require(line.size == 3 && line[2] in listOf("HTTP/1.0", "HTTP/1.1"))
        val path = line[1]
        if (line[0] == "GET" && path == "/ping") {
          LocalHttp.reply(socket, 200, json("v" to 1, "deviceId" to deviceId, "name" to deviceName)); return
        }
        if (line[0] != "POST" || path !in setOf("/pair/hello", "/pair/confirm", "/send", "/paired", "/unpair")) {
          LocalHttp.reply(socket, 404, json("error" to "not found")); return
        }
        val claimed = head.headers["x-gazboard-from"]
        if (path == "/send" && claimed != null && paired.get(claimed) == null) {
          LocalHttp.reply(socket, 401, json("error" to "not paired")); return
        }
        val limit = if (path == "/send") MAX_BOARD_BYTES else if (path.startsWith("/pair/")) 8192 else 65536
        if (head.length > limit) { LocalHttp.reply(socket, 413, json("error" to "board is too large")); return }
        if (path == "/send") {
          ownsBoardSlot = boardSlot.tryAcquire()
          if (!ownsBoardSlot) { LocalHttp.reply(socket, 503, json("error" to "Receiving another board; try again shortly")); return }
        }
        val transferId = Protocol.deviceId()
        val known = claimed?.let(paired::get)
        val payload = LocalHttp.read(input, head.length, limit) { sent, total ->
          if (path == "/send" && known != null) onReceiving(json("id" to transferId, "deviceId" to claimed,
            "name" to known.str("name"), "percent" to if (total > 0) sent * 100L / total else 0, "bytes" to sent))
        }
        val body = parse(payload.toString(Charsets.UTF_8)).obj()
        val address = socket.inetAddress.hostAddress?.removePrefix("::ffff:") ?: ""
        val reply = when (path) {
          "/pair/hello" -> hello(body)
          "/pair/confirm" -> confirm(body, address)
          "/send" -> receiveBoard(body, claimed, address, transferId)
          else -> pairedRequest(path, body, address)
        }
        LocalHttp.reply(socket, reply.status, reply.body)
      } catch (_: Exception) {
        runCatching { LocalHttp.reply(socket, 400, json("error" to "bad request")) }
      } finally {
        sockets.remove(socket)
        if (ownsBoardSlot) boardSlot.release()
      }
    }
  }
  private fun hello(body: JsonObject): LocalHttp.Reply = synchronized(pairingLock) {
    val current = room
    if (current == null || current.expires < System.currentTimeMillis()) return@synchronized failure(409, "pairing is not open")
    val id = body.str("deviceId")
    if (body.num("v") != 1 || !ID.matches(id) || id == deviceId || !Protocol.validPublicKey(body.str("publicKey"))) return@synchronized failure(400, "bad request")
    halves.entries.removeIf { System.currentTimeMillis() - it.value.at > Protocol.CODE_TTL_MS }
    if (halves.size >= 64 && id !in halves) return@synchronized failure(429, "Pairing is busy; try again shortly")
    val keys = Protocol.keys()
    halves[id] = Half(keys, json("deviceId" to id, "publicKey" to body.str("publicKey")),
      body.str("name", "Unknown device").take(64), body.num("port", TRANSFER_PORT), System.currentTimeMillis())
    LocalHttp.Reply(200, json("v" to 1, "deviceId" to deviceId, "name" to deviceName, "publicKey" to keys.publicKey))
  }
  private fun confirm(body: JsonObject, address: String): LocalHttp.Reply = synchronized(pairingLock) {
    val current = room
    if (current == null || current.expires < System.currentTimeMillis()) return@synchronized failure(409, "pairing is not open")
    val id = body.str("deviceId")
    if (body.num("v") != 1) return@synchronized failure(400, "bad request")
    val half = halves[id] ?: return@synchronized failure(409, "start pairing again")
    current.failures.removeAll { System.currentTimeMillis() - it > 60000 }
    val attempts = current.attempts[id] ?: 0
    if (attempts >= Protocol.MAX_ATTEMPTS || current.failures.size >= Protocol.ROOM_FAILURES) return@synchronized failure(429, "Too many wrong codes; wait and try again")
    val us = json("deviceId" to deviceId, "publicKey" to half.keys.publicKey)
    if (!Protocol.matches(Protocol.confirmation(current.code, us, half.them, "initiator"), body.str("confirm"))) {
      if (current.attempts.size >= 256 && id !in current.attempts) return@synchronized failure(429, "Pairing is busy")
      current.attempts[id] = attempts + 1
      current.failures.add(System.currentTimeMillis())
      return@synchronized LocalHttp.Reply(403, json("error" to "wrong code", "attemptsLeft" to Protocol.MAX_ATTEMPTS - attempts - 1))
    }
    val key = Protocol.deriveKey(half.keys, half.them.str("publicKey"), us, half.them)
    paired.set(id, json("deviceId" to id, "name" to half.name, "key" to Protocol.b64(key),
      "pairedAt" to System.currentTimeMillis(), "remember" to current.remember, "lastAddress" to address,
      "lastPort" to half.port.takeIf { it in 1..65535 }.let { it ?: TRANSFER_PORT }))
    halves.remove(id)
    changed()
    LocalHttp.Reply(200, json("v" to 1, "deviceId" to deviceId, "name" to deviceName,
      "confirm" to Protocol.confirmation(current.code, us, half.them, "responder"),
      "fingerprint" to Protocol.fingerprint(key), "remembered" to current.remember))
  }
  private fun receiveBoard(envelope: JsonObject, claimed: String?, address: String, transferId: String): LocalHttp.Reply {
    val aad = envelope["aad"]?.obj() ?: return failure(400, "bad request")
    val id = aad.str("from")
    if (claimed != null && claimed != id) return failure(401, "not paired")
    val rec = paired.get(id) ?: return failure(401, "not paired")
    val plain = Protocol.open(Protocol.unb64(rec.str("key")), envelope) ?: return failure(403, "could not verify board")
    if (aad.str("kind") != "board" || aad.num("v") != 1) return failure(400, "not a board")
    synchronized(received) {
      val token = "$id:${envelope.str("iv")}:${envelope.str("tag")}"
      if (received.containsKey(token)) return failure(409, "board already received")
      received[token] = System.currentTimeMillis()
      while (received.size > 512) received.remove(received.keys.first())
    }
    val board = parse(plain.toString(Charsets.UTF_8)).obj()
    if (board["objects"] !is JsonArray && board["objects"] !is JsonObject) return failure(400, "not a board")
    val name = aad.str("name", rec.str("name")).take(64)
    if (name != rec.str("name")) paired.set(id, rec.with("name" to name))
    noteCaller(id, address, aad.num("port"))
    onReceiving(json("id" to transferId, "deviceId" to id, "name" to name, "state" to "arrived", "boardName" to board.str("name", "Untitled board")))
    val outcome = onBoard(board, json("deviceId" to id, "name" to name))
    return LocalHttp.Reply(200, json("accepted" to (outcome != null), "outcome" to (outcome ?: "declined")))
  }
  private fun pairedRequest(path: String, envelope: JsonObject, address: String): LocalHttp.Reply {
    val aad = envelope["aad"]?.obj() ?: json()
    val id = aad.str("from")
    val rec = paired.get(id)
    val plain = rec?.let { Protocol.open(Protocol.unb64(it.str("key")), envelope) }
    val valid = plain?.toString(Charsets.UTF_8) == id && id.isNotEmpty() && aad.num("v") == 1 &&
      aad.str("kind") == if (path == "/unpair") "unpair" else "still-paired"
    if (valid) {
      if (path == "/unpair") { paired.remove(id); changed() }
      else noteCaller(id, address, aad.num("port"))
    }
    return LocalHttp.Reply(200, if (path == "/unpair") json("ok" to true) else json("paired" to valid))
  }
  private fun failure(code: Int, message: String) = LocalHttp.Reply(code, json("error" to message))

  private fun bestAddress(peer: JsonObject): JsonObject {
    val rec = paired.get(peer.str("deviceId"))
    val candidates = (listOf(peer.str("address")) +
      ((peer["addresses"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()) +
      listOf(rec?.str("lastAddress") ?: "")).filter { it.isNotBlank() }.distinct().take(8)
    require(candidates.isNotEmpty()) { "No address for this device. Add it by address in Sharing." }
    val port = peer.num("port", rec?.num("lastPort", TRANSFER_PORT) ?: TRANSFER_PORT)
    // A successful ping is checked against the device id, so stale addresses
    // cannot silently redirect a transfer to a different GazBoard.
    for (address in candidates) {
      val response = runCatching { LocalHttp.request(address, port, "/ping", timeout = 1500) }.getOrNull()
      if (response?.ok == true && response.body.str("deviceId") == peer.str("deviceId")) return peer.with("address" to address, "port" to port)
    }
    return peer.with("address" to candidates.first(), "port" to port)
  }
  fun addByAddress(raw: String): JsonObject {
    check(running) { "Sharing is switched off" }
    val parts = raw.trim().split(':')
    require(parts.size <= 2) { "Enter an IPv4 address, optionally followed by :port" }
    val address = parts[0]
    val port = if (parts.size == 2) parts[1].toIntOrNull() ?: error("Invalid port") else TRANSFER_PORT
    val reply = LocalHttp.request(address, port, "/ping", timeout = 5000)
    require(reply.ok && reply.body.num("v") == 1 && ID.matches(reply.body.str("deviceId"))) { "No GazBoard at that address" }
    require(reply.body.str("deviceId") != deviceId) { "That is this device" }
    notePeer(json("t" to "gazboard", "v" to 1, "id" to reply.body.str("deviceId"), "name" to reply.body.str("name"), "port" to port), address, true)
    return list().first { it.obj().str("deviceId") == reply.body.str("deviceId") }.obj()
  }
  fun pairWith(peer: JsonObject, code: String): JsonObject {
    check(running) { "Sharing is switched off" }
    require(Protocol.normaliseCode(code).length == 8) { "Enter the eight-character pairing code" }
    val target = bestAddress(peer)
    val keys = Protocol.keys()
    val us = json("deviceId" to deviceId, "publicKey" to keys.publicKey)
    val hello = post(target, "/pair/hello", us.with("v" to 1, "name" to deviceName, "port" to port))
    require(hello.ok) { hello.body.str("error", "Pairing is not open on that device") }
    val them = hello.body
    require(them.num("v") == 1 && them.str("deviceId") == peer.str("deviceId") && Protocol.validPublicKey(them.str("publicKey"))) { "The other device changed; add it again" }
    val done = post(target, "/pair/confirm", json("v" to 1, "deviceId" to deviceId,
      "confirm" to Protocol.confirmation(code, us, them, "initiator")))
    require(done.ok) { done.body.str("error", "Pairing failed") }
    require(Protocol.matches(Protocol.confirmation(code, us, them, "responder"), done.body.str("confirm"))) { "The other device did not prove it knew the code" }
    val key = Protocol.deriveKey(keys, them.str("publicKey"), us, them)
    val record = json("deviceId" to them.str("deviceId"), "name" to done.body.str("name", them.str("name")).take(64),
      "key" to Protocol.b64(key), "pairedAt" to System.currentTimeMillis(), "remember" to done.body.bool("remembered"),
      "lastAddress" to target.str("address"), "lastPort" to target.num("port"))
    paired.set(them.str("deviceId"), record)
    changed()
    return JsonObject(record - "key").with("fingerprint" to Protocol.fingerprint(key))
  }
  fun send(peer: JsonObject, board: JsonObject, progress: (Int, Int) -> Unit = { _, _ -> }): JsonObject {
    check(running) { "Sharing is switched off" }
    val rec = paired.get(peer.str("deviceId")) ?: error("Not paired with that device")
    val payload = board.toString().toByteArray()
    require(payload.size <= MAX_BOARD_BYTES) { "Board is too large to send" }
    val envelope = Protocol.seal(Protocol.unb64(rec.str("key")),
      json("from" to deviceId, "kind" to "board", "v" to 1, "port" to port, "name" to deviceName), payload)
    val reply = post(bestAddress(peer), "/send", envelope, 330_000, progress)
    if (reply.status == 401) { paired.remove(peer.str("deviceId")); changed(); error("That device forgot this one. Pair again to send.") }
    require(reply.ok) { reply.body.str("error", "The other device refused the board") }
    return reply.body
  }
  fun stillPaired(peer: JsonObject): Boolean? {
    val rec = paired.get(peer.str("deviceId")) ?: return false
    if (!running) return null
    return runCatching {
      val envelope = Protocol.seal(Protocol.unb64(rec.str("key")),
        json("from" to deviceId, "kind" to "still-paired", "v" to 1, "port" to port), deviceId.toByteArray())
      val reply = post(bestAddress(peer), "/paired", envelope, 4000)
      val answer = if (reply.ok) (reply.body["paired"] as? JsonPrimitive)?.booleanOrNull else null
      if (answer == false) { paired.remove(peer.str("deviceId")); changed() }
      answer
    }.getOrNull()
  }
  fun unpair(id: String): Boolean {
    val rec = paired.get(id)
    paired.remove(id)
    changed()
    if (rec == null || !running) return false
    return runCatching {
      val target = peers[id] ?: json("deviceId" to id, "address" to rec.str("lastAddress"), "port" to rec.num("lastPort", TRANSFER_PORT))
      val envelope = Protocol.seal(Protocol.unb64(rec.str("key")), json("from" to deviceId, "kind" to "unpair", "v" to 1), deviceId.toByteArray())
      post(bestAddress(target), "/unpair", envelope, 5000).ok
    }.getOrDefault(false)
  }
  private fun post(peer: JsonObject, path: String, body: JsonObject, timeout: Int = 30_000,
    progress: (Int, Int) -> Unit = { _, _ -> }): LocalHttp.Reply =
    LocalHttp.request(peer.str("address"), peer.num("port", TRANSFER_PORT), path, body, timeout, progress)
}
