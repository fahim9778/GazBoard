package com.gazboard.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShareMimeTest {
  @Test fun boardFilesKeepGazBoardMimeWhenShared() {
    assertEquals("application/x-gazboard",
      preferredShareMime("Lesson.gazboard", "application/octet-stream"))
    assertEquals("application/x-gazboard",
      preferredShareMime("Legacy.OPENBOARD", null))
  }

  @Test fun unrelatedFilesKeepTheirProviderMime() {
    assertEquals("application/pdf", preferredShareMime("notes.pdf", "application/pdf"))
    assertEquals("application/octet-stream", preferredShareMime("mystery.bin", null))
  }
}
