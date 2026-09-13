package com.gazboard.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoardFilenameTest {
  @Test fun duplicateBoardNamesKeepTheExtensionLast() {
    assertEquals("My ! Styboard (1).gazboard",
      BridgeFiles.normalizeBoardDuplicateName("My ! Styboard.gazboard (1)"))
    assertEquals("Lesson (27).openboard",
      BridgeFiles.normalizeBoardDuplicateName("Lesson.openboard (27)"))
    assertEquals("Already good (1).gazboard",
      BridgeFiles.normalizeBoardDuplicateName("Already good (1).gazboard"))
    assertEquals("photo.jpg (1)",
      BridgeFiles.normalizeBoardDuplicateName("photo.jpg (1)"))
  }
}
