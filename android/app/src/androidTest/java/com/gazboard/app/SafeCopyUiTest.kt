package com.gazboard.app

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The safe copy as a person meets it, on a real phone: My boards offers it,
 * the switch at its foot answers from Android itself, and Settings shows the
 * very same switch. (Choosing the folder is Android's own picker, which a test
 * cannot press; what happens after it is covered in BoardMirrorTest.)
 */
@RunWith(AndroidJUnit4::class)
class SafeCopyUiTest {
  private fun js(scenario: ActivityScenario<MainActivity>, code: String): String {
    val answer = CompletableFuture<String>()
    scenario.onActivity { it.web.evaluateJavascript(code) { value -> answer.complete(value ?: "null") } }
    return answer.get(10, TimeUnit.SECONDS)
  }
  private fun until(scenario: ActivityScenario<MainActivity>, expression: String, timeout: Long = 30000) {
    val start = System.currentTimeMillis()
    while (System.currentTimeMillis() - start < timeout) {
      if (js(scenario, expression) == "true") return
      Thread.sleep(150)
    }
    fail("Did not satisfy: $expression; on screen: " + js(scenario, "document.body.innerText.slice(0,1500)"))
  }

  @Test fun myBoardsOffersTheSafeCopyAndSettingsShowsTheSameSwitch() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && window.app.startupSettled === true")
      js(scenario, "app.settings.updateCheck = false; app.settings.safeCopyAsked = 0; app.saveSettings(); board.backup.stop(); true")
      js(scenario, "app.panels.boards(); true")
      until(scenario, "!!document.querySelector('.safe-copy-offer')")
      until(scenario, "!!document.querySelector('#boardList .safe-copy input')")
      assertEquals("the switch in My boards starts off, as Android says: " + js(scenario, "JSON.stringify(app.backupState)"),
        "false", js(scenario, "document.querySelector('#boardList .safe-copy input').checked"))
      // "Later" puts the offer away and remembers it
      js(scenario, "[...document.querySelectorAll('.safe-copy-offer button')].pop().click(); true")
      until(scenario, "!document.querySelector('.safe-copy-offer') && app.settings.safeCopyAsked === 1")
      js(scenario, "app.panels.close(); app.panels.settings(); true")
      until(scenario, "!!document.querySelector('.safe-copy input')")
      assertEquals("Settings shows the same switch, off: " + js(scenario, "document.querySelector('.safe-copy')?.textContent"),
        "false", js(scenario, "document.querySelector('.safe-copy input').checked"))
      js(scenario, "app.panels.close(); app.settings.safeCopyAsked = 0; app.saveSettings(); true")
    }
  }
}
