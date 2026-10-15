package com.gazboard.app

import android.app.Application
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.gazboard.sync.*
import java.util.concurrent.*
import kotlinx.serialization.json.*

class GazBoardApplication : Application() {
  val io = Executors.newFixedThreadPool(6)
  val main = Handler(Looper.getMainLooper())
  val mirror by lazy { BoardMirror(this) }
  val storage by lazy { BoardStorage(this).also { it.listener = mirror } }
  val files by lazy { BridgeFiles(this) }
  val identity by lazy { DeviceIdentity(this) }
  @Volatile var events: ((String, JsonElement) -> Unit)? = null
  @Volatile var visible = false
  private data class Question(val message: JsonObject, val answer: CompletableFuture<String?>)
  private val questions = ConcurrentHashMap<String, Question>()
  val node by lazy {
    LanNode(identity.id, identity.name, identity,
      onBoard = { board, from -> ask(board, from) },
      onPeers = { emit("peers", it) },
      onReceiving = { emit("receiving", it) })
  }
  fun emit(name: String, payload: JsonElement) { main.post { events?.invoke(name, payload) } }
  private fun ask(board: JsonObject, from: JsonObject): String? {
    val ticket = Protocol.deviceId()
    val question = Question(json("ticket" to ticket, "board" to board, "from" to from), CompletableFuture())
    questions[ticket] = question
    emit("incoming", question.message)
    if (!visible) SharingService.showIncoming(this, from.str("name"))
    return try { question.answer.get(5, TimeUnit.MINUTES) }
      catch (_: Exception) { null }
      // the "board arriving" notice stays while anyone else is still waiting for an answer
      finally { questions.remove(ticket); if (questions.isEmpty()) SharingService.clearIncoming(this) }
  }
  fun resumeQuestions() { questions.values.forEach { emit("incoming", it.message) } }
  fun answer(ticket: String, outcome: String?): Boolean = questions.remove(ticket)?.answer?.complete(outcome) ?: false
  fun stopSharing(): JsonObject {
    questions.values.forEach { it.answer.complete(null) }; questions.clear()
    val state = node.stop()
    stopService(Intent(this, SharingService::class.java))
    emit("sharingStopped", state)
    return state
  }
}
