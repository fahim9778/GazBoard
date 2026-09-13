package com.gazboard.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle

/**
 * Temporary resolver diagnostics for the side-by-side Probe build.
 *
 * Samsung My Files collapses all of this package's resolver entries into one
 * "GazBoard Probe" choice, so the chooser cannot tell us which manifest rule
 * actually matched. Each probe alias therefore targets a different tiny
 * activity. The activity names the rule that won, then forwards the untouched
 * VIEW intent to the real editor.
 */
abstract class ResolverProbeActivity : Activity() {
  protected abstract val resolverName: String

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    showResult(intent)
  }

  private fun showResult(source: Intent) {
    val details = buildString {
      append("Matched resolver: ").append(resolverName)
      append("\n\nAction: ").append(source.action ?: "(none)")
      append("\nType: ").append(source.type ?: "(none)")
      append("\nURI: ").append(source.data?.toString() ?: "(none)")
    }

    AlertDialog.Builder(this)
      .setTitle("GazBoard resolver probe")
      .setMessage(details)
      .setCancelable(false)
      .setNegativeButton("Close") { _, _ -> finish() }
      .setPositiveButton("Open board") { _, _ ->
        startActivity(Intent(source).apply {
          setClass(this@ResolverProbeActivity, MainActivity::class.java)
        })
        finish()
      }
      .show()
  }
}

class ProbeGazboardMimeActivity : ResolverProbeActivity() {
  override val resolverName = "MIME"
}

class ProbeOctetStreamActivity : ResolverProbeActivity() {
  override val resolverName = "Binary"
}

class ProbeMediaStoreActivity : ResolverProbeActivity() {
  override val resolverName = "MediaStore"
}

class ProbeSuffixActivity : ResolverProbeActivity() {
  override val resolverName = "Suffix"
}

class ProbeAnyTypedContentActivity : ResolverProbeActivity() {
  override val resolverName = "Any typed"
}

class ProbeAnyUntypedContentActivity : ResolverProbeActivity() {
  override val resolverName = "Any untyped"
}
