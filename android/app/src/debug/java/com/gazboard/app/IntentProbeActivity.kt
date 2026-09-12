package com.gazboard.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns

/** Debug-only inspector for file-manager intents. Never packaged in release builds. */
class IntentProbeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val incoming = intent
    val uri = when (incoming.action) {
      Intent.ACTION_VIEW -> incoming.data
      Intent.ACTION_SEND -> if (android.os.Build.VERSION.SDK_INT >= 33)
        incoming.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else @Suppress("DEPRECATION") incoming.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    }

    var displayName: String? = null
    if (uri != null && uri.scheme == "content") {
      runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) displayName = cursor.getString(0)
        }
      }
    }

    val providerMime = uri?.let { runCatching { contentResolver.getType(it) }.getOrNull() }
    val resolvedMime = runCatching { incoming.resolveType(contentResolver) }.getOrNull()
    val categories = incoming.categories?.sorted()?.joinToString() ?: "(none)"
    val report = buildString {
      appendLine("Action: ${incoming.action ?: "(null)"}")
      appendLine("Intent.type: ${incoming.type ?: "(null)"}")
      appendLine("Resolver type: ${resolvedMime ?: "(null)"}")
      appendLine("Provider type: ${providerMime ?: "(null)"}")
      appendLine("DISPLAY_NAME: ${displayName ?: "(null)"}")
      appendLine("URI: ${uri ?: "(null)"}")
      appendLine("Scheme: ${uri?.scheme ?: "(null)"}")
      appendLine("Authority: ${uri?.authority ?: "(null)"}")
      appendLine("Path: ${uri?.path ?: "(null)"}")
      appendLine("Categories: $categories")
      append("Flags: 0x${incoming.flags.toUInt().toString(16)}")
    }

    val dialog = AlertDialog.Builder(this)
      .setTitle("GazBoard MIME Probe")
      .setMessage(report)
      .setNeutralButton("Copy") { _, _ ->
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("GazBoard intent diagnostic", report))
        finish()
      }
      .setNegativeButton("Close") { _, _ -> finish() }

    if (uri != null) {
      dialog.setPositiveButton("Open in GazBoard") { _, _ ->
        val forward = Intent(this, MainActivity::class.java).apply {
          action = Intent.ACTION_VIEW
          if (incoming.type != null) setDataAndType(uri, incoming.type) else data = uri
          flags = incoming.flags
          clipData = incoming.clipData
        }
        startActivity(forward)
        finish()
      }
    }

    dialog.setOnCancelListener { finish() }
    dialog.show()
  }
}
