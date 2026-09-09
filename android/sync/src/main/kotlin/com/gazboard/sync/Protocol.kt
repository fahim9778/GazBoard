package com.gazboard.sync

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonObject
import org.bouncycastle.math.ec.rfc7748.X25519

/** Wire-compatible with sync/protocol.js. See ProtocolTest's Node interop. */
object Protocol {
  const val VERSION = 1
  const val CODE_TTL_MS = 300_000L
  const val MAX_ATTEMPTS = 5
  const val ROOM_FAILURES = 20
  private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  private val random = SecureRandom()
  private val spki = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00)
  data class Keys(val privateKey: ByteArray, val publicKey: String)

  fun bytes(count: Int): ByteArray = ByteArray(count).also(random::nextBytes)
  fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
  fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)
  fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 255) }
  fun deviceId(): String = hex(bytes(16))
  fun normaliseCode(s: String): String = s.uppercase(Locale.ROOT).replace(Regex("[^A-Z0-9]"), "")
  fun generateCode(): String = List(8) { ALPHABET[random.nextInt(ALPHABET.length)] }.joinToString("").chunked(4).joinToString("-")
  fun keys(): Keys {
    val secret = ByteArray(32).also { X25519.generatePrivateKey(random, it) }
    val public = ByteArray(32).also { X25519.generatePublicKey(secret, 0, it, 0) }
    return Keys(secret, b64(spki + public))
  }
  fun validPublicKey(s: String): Boolean = runCatching { publicBytes(s); true }.getOrDefault(false)
  private fun publicBytes(s: String): ByteArray {
    val der = unb64(s)
    require(der.size == 44 && der.copyOfRange(0, 12).contentEquals(spki)) { "Invalid pairing key" }
    return der.copyOfRange(12, 44)
  }
  fun transcript(a: JsonObject, b: JsonObject): String {
    val ends = listOf("${a.str("deviceId")}|${a.str("publicKey")}", "${b.str("deviceId")}|${b.str("publicKey")}").sorted()
    return "gazboard-pair/v1\n${ends[0]}\n${ends[1]}"
  }
  private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
    init(SecretKeySpec(key, "HmacSHA256"))
    doFinal(data)
  }
  fun confirmation(code: String, a: JsonObject, b: JsonObject, label: String): String =
    b64(hmac(normaliseCode(code).toByteArray(), "$label\n${transcript(a, b)}".toByteArray()))
  fun matches(expected: String, actual: String): Boolean = runCatching {
    val left = unb64(expected)
    val right = unb64(actual)
    left.isNotEmpty() && MessageDigest.isEqual(left, right)
  }.getOrDefault(false)
  fun deriveKey(keys: Keys, theirPublicKey: String, a: JsonObject, b: JsonObject): ByteArray {
    val shared = ByteArray(32)
    require(X25519.calculateAgreement(keys.privateKey, 0, publicBytes(theirPublicKey), 0, shared, 0)) { "Invalid pairing key" }
    val extracted = hmac(transcript(a, b).toByteArray(), shared)
    shared.fill(0)
    return hmac(extracted, "gazboard-device-key".toByteArray() + byteArrayOf(1)).also { extracted.fill(0) }
  }
  fun seal(key: ByteArray, aad: JsonObject, plain: ByteArray): JsonObject {
    require(key.size == 32)
    val iv = bytes(12)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    cipher.updateAAD(aad.toString().toByteArray())
    val sealed = cipher.doFinal(plain)
    return json("v" to VERSION, "iv" to b64(iv), "tag" to b64(sealed.takeLast(16).toByteArray()),
      "aad" to aad, "body" to b64(sealed.copyOfRange(0, sealed.size - 16)))
  }
  fun open(key: ByteArray, envelope: JsonObject): ByteArray? = runCatching {
    require(envelope.num("v") == VERSION && key.size == 32)
    val iv = unb64(envelope.str("iv"))
    val tag = unb64(envelope.str("tag"))
    require(iv.size == 12 && tag.size == 16)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    cipher.updateAAD(envelope["aad"]!!.obj().toString().toByteArray())
    cipher.doFinal(unb64(envelope.str("body")) + tag)
  }.getOrNull()
  fun fingerprint(key: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(key))
    .take(12).uppercase(Locale.ROOT).chunked(4).joinToString("-")
}
