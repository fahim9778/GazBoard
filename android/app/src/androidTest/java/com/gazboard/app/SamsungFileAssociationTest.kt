package com.gazboard.app

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SamsungFileAssociationTest {
  private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun resolvesToGazBoard(intent: Intent): Boolean = context.packageManager
    .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
    .any { it.activityInfo.packageName == context.packageName }

  @Test fun samsungMyFilesUntypedMediaStoreIntentResolvesToGazBoard() {
    // Exact resolver shape captured from Samsung My Files for a .gazboard file:
    // ACTION_VIEW, no Intent.type, content://media/external/file/<numeric id>.
    // DISPLAY_NAME=.gazboard exists only inside the provider and is invisible to
    // Android while it is choosing which app can handle the intent.
    val intent = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("content://media/external/file/1000043387")
    ).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    assertTrue(
      "GazBoard must be discoverable for Samsung My Files' untyped MediaStore board intent",
      resolvesToGazBoard(intent)
    )
  }

  @Test fun normalTypedMediaStoreFilesAreNotClaimed() {
    val uri = Uri.parse("content://media/external/file/1000043387")
    for (mime in listOf(
      "application/pdf",
      "image/jpeg",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )) {
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      assertFalse(
        "GazBoard must not appear in Open with for typed $mime MediaStore files",
        resolvesToGazBoard(intent)
      )
    }
  }

  @Test fun arbitraryUntypedContentProviderIsStillNotClaimed() {
    val intent = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("content://com.example.files/document/opaque-id")
    ).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    assertFalse(
      "GazBoard must not claim arbitrary untyped content:// providers",
      resolvesToGazBoard(intent)
    )
  }
}
