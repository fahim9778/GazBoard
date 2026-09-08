package com.gazboard.sync

import kotlinx.serialization.json.*

// JsonObject keeps insertion order. AES-GCM authenticates JSON.stringify(aad)
// on the desktop, so a map implementation that sorts keys breaks the protocol.
fun json(vararg entries: Pair<String, Any?>): JsonObject = JsonObject(linkedMapOf(
  *entries.map { it.first to value(it.second) }.toTypedArray()
))
fun value(v: Any?): JsonElement = when (v) {
  null -> JsonNull
  is JsonElement -> v
  is Boolean -> JsonPrimitive(v)
  is Number -> JsonPrimitive(v)
  is String -> JsonPrimitive(v)
  is Iterable<*> -> JsonArray(v.map(::value))
  is Map<*, *> -> JsonObject(v.entries.associate { it.key.toString() to value(it.value) })
  else -> error("Unsupported JSON value")
}
fun parse(s: String): JsonElement = Json.parseToJsonElement(s)
fun JsonElement.obj(): JsonObject = this as? JsonObject ?: error("Expected an object")
fun JsonObject.str(key: String, fallback: String = ""): String =
  (this[key] as? JsonPrimitive)?.contentOrNull ?: fallback
fun JsonObject.num(key: String, fallback: Int = 0): Int =
  (this[key] as? JsonPrimitive)?.intOrNull ?: fallback
fun JsonObject.long(key: String, fallback: Long = 0): Long =
  (this[key] as? JsonPrimitive)?.longOrNull ?: fallback
fun JsonObject.bool(key: String, fallback: Boolean = false): Boolean =
  (this[key] as? JsonPrimitive)?.booleanOrNull ?: fallback
fun JsonObject.with(vararg entries: Pair<String, Any?>): JsonObject =
  JsonObject(this + entries.associate { it.first to value(it.second) })
