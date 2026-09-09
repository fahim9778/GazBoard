package com.gazboard.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.gazboard.sync.*
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.*

class DeviceIdentity(context: Context) : PairedStore {
  private val preferences = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
  private val disk = AtomicFile(File(context.filesDir, "paired.enc"))
  private val records = linkedMapOf<String, JsonObject>()
  val id: String = preferences.getString("id", null) ?: Protocol.deviceId().also { preferences.edit().putString("id", it).commit() }
  var name: String = preferences.getString("name", null) ?: "${Build.MANUFACTURER} ${Build.MODEL}"
    private set
  var loadError: String? = null
    private set
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey("gazboard-pairs", null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder("gazboard-pairs", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
      generateKey()
    }
  }
  init {
    if (disk.baseFile.exists()) {
      try {
        val bytes = disk.readFully()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val saved = parse(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)).jsonArray
        saved.forEach { val record = it.obj(); records[record.str("deviceId")] = record }
      } catch (_: Exception) { loadError = "Remembered device keys could not be opened. Pair those devices again." }
    }
  }
  @Synchronized fun setName(raw: String): String {
    val changed = raw.trim().take(64).ifEmpty { Build.MODEL }
    check(preferences.edit().putString("name", changed).commit()) { "Could not save device name" }
    name = changed
    return name
  }
  @Synchronized override fun get(id: String): JsonObject? = records[id]
  @Synchronized override fun all(): List<JsonObject> = records.values.toList()
  @Synchronized override fun set(id: String, record: JsonObject) {
    if (records[id] == record) return
    val next = LinkedHashMap(records).apply { put(id, record) }
    if (record.bool("remember") || records[id]?.bool("remember") == true) flush(next.values)
    records[id] = record
  }
  @Synchronized override fun remove(id: String) {
    if (records[id]?.bool("remember") == true) flush(records.filterKeys { it != id }.values)
    records.remove(id)
  }
  private fun flush(values: Collection<JsonObject>) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val plain = JsonArray(values.filter { it.bool("remember") }).toString().toByteArray()
    BoardStorage.writeAtomic(disk, cipher.iv + cipher.doFinal(plain))
    loadError = null
  }
}
