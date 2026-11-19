package com.gazboard.app

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.Ink
import com.gazboard.sync.*
import kotlinx.serialization.json.*
import java.util.concurrent.TimeUnit

/**
 * "Convert to text" on Android: lassoed handwriting read on the phone by Google's ML Kit.
 *
 * The ink never leaves the phone. What does come over the network, once, is the
 * language pack itself - about 20 MB from Google - and only after the page has
 * asked the person (recognize answers needs-model until it is here; download
 * fetches it). Every call runs on the bridge's worker threads, never the main
 * thread, so waiting on ML Kit's tasks here is safe.
 */
class HandwritingReader {
  private val models = RemoteModelManager.getInstance()

  /** The model for a language tag: the exact tag if ML Kit has it, else the first model for that language. */
  private fun identifier(tag: String): DigitalInkRecognitionModelIdentifier? {
    val want = tag.ifBlank { "en-US" }
    runCatching { DigitalInkRecognitionModelIdentifier.fromLanguageTag(want) }.getOrNull()?.let { return it }
    val lang = want.substringBefore('-').lowercase()
    val all = DigitalInkRecognitionModelIdentifier.allModelIdentifiers()
    return all.firstOrNull { it.languageSubtag.equals(lang, true) && it.regionSubtag == null && it.scriptSubtag == null }
      ?: all.firstOrNull { it.languageSubtag.equals(lang, true) && !it.languageTag.contains("-x-") }
  }

  private fun model(tag: String): DigitalInkRecognitionModel? =
    identifier(tag)?.let { DigitalInkRecognitionModel.builder(it).build() }

  fun recognize(request: JsonObject): JsonObject {
    val tag = request.str("lang")
    val id = identifier(tag) ?: return json("ok" to false, "code" to "unsupported-language", "error" to "No handwriting model for $tag")
    val model = DigitalInkRecognitionModel.builder(id).build()
    if (!Tasks.await(models.isModelDownloaded(model), 15, TimeUnit.SECONDS))
      return json("ok" to false, "code" to "needs-model", "language" to id.languageTag)
    val recognizer = DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(model).build())
    try {
      val lines = (request["lines"] as? JsonArray ?: JsonArray(emptyList())).map { line ->
        val ink = Ink.builder()
        for (s in (line as? JsonArray ?: JsonArray(emptyList()))) {
          val stroke = Ink.Stroke.builder()
          for (p in (s as? JsonArray ?: JsonArray(emptyList()))) {
            val a = p as? JsonArray ?: continue
            val x = (a.getOrNull(0) as? JsonPrimitive)?.floatOrNull ?: continue
            val y = (a.getOrNull(1) as? JsonPrimitive)?.floatOrNull ?: continue
            stroke.addPoint(Ink.Point.create(x, y))
          }
          ink.addStroke(stroke.build())
        }
        val result = Tasks.await(recognizer.recognize(ink.build()), 30, TimeUnit.SECONDS)
        result.candidates.firstOrNull()?.text ?: ""
      }
      return json("ok" to true, "lines" to lines, "language" to id.languageTag)
    } finally {
      recognizer.close()
    }
  }

  fun download(tag: String): JsonObject {
    val model = model(tag) ?: return json("ok" to false, "error" to "No handwriting model for $tag")
    return try {
      Tasks.await(models.download(model, DownloadConditions.Builder().build()), 10, TimeUnit.MINUTES)
      json("ok" to true)
    } catch (e: Exception) {
      json("ok" to false, "error" to (e.cause?.message ?: e.message ?: "Download failed"))
    }
  }
}
