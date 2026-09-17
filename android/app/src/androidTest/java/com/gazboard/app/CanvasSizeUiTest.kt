package com.gazboard.app

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/** Android-only coverage for the Canvas menu and new-board defaults. */
@RunWith(AndroidJUnit4::class)
class CanvasSizeUiTest {
  private fun js(scenario: ActivityScenario<MainActivity>, code: String): String {
    val answer = CompletableFuture<String>()
    scenario.onActivity { activity ->
      activity.web.evaluateJavascript(code) { value -> answer.complete(value ?: "null") }
    }
    return answer.get(10, TimeUnit.SECONDS)
  }

  private fun until(
    scenario: ActivityScenario<MainActivity>,
    expression: String,
    timeout: Long = 10_000
  ) {
    val started = System.currentTimeMillis()
    while (System.currentTimeMillis() - started < timeout) {
      if (js(scenario, expression) == "true") return
      Thread.sleep(50)
    }
    fail("Android canvas UI did not satisfy: $expression")
  }

  @Test fun canvasMenuUpdatesFitsAndRemembersOnlyNewBoards() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && window.__gazboardAndroidCanvasUi === true")

      js(scenario, """
        app.settings.rememberCanvas = false;
        delete app.settings.canvasDefaults;
        app.saveSettings();
        app.newBoard(true);
        app.store.add({ id:'near', type:'shape', kind:'rect', x:0, y:0,
          w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });
        app.store.add({ id:'far', type:'shape', kind:'rect', x:4000, y:3000,
          w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });
        // ActivityScenario can restore a panel left open by an earlier device
        // test. background() toggles an already-open panel closed, so reset the
        // panel state before opening the Canvas panel this test owns.
        app.panels.close?.();
        app.panels.background();
        window.androidCanvasButton = (label) =>
          [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
            .find(b => b.textContent.trim() === label);
        const pressedA4 = window.androidCanvasButton('A4');
        pressedA4.click();
        // Keep the answer from this exact JavaScript turn. A second call races
        // the shared async handler, which is allowed to replace the whole panel
        // with its authoritative rerender as soon as setPageSize() completes.
        window.androidA4AcknowledgedImmediately =
          pressedA4.classList.contains('primary');
      """.trimIndent())

      // The Android helper acknowledges the tap before setPageSize finishes.
      assertEquals("true", js(scenario,
        "window.androidA4AcknowledgedImmediately === true"))

      until(scenario, "!!app.store.page && " +
        "window.androidCanvasButton('A4').classList.contains('primary') && " +
        "[...document.querySelectorAll('#panelBody button')].some(b => /Fit .* onto the page/.test(b.textContent))")

      // The permanent in-menu action matters on Android because the temporary
      // toast may be gone before someone opens the Canvas panel.
      js(scenario, """
        [...document.querySelectorAll('#panelBody button')]
          .find(b => /Fit .* onto the page/.test(b.textContent)).click();
      """.trimIndent())
      until(scenario, "app.offPageObjects().length === 0 && " +
        "![...document.querySelectorAll('#panelBody button')].some(b => /Fit .* onto the page/.test(b.textContent))")

      // Turning memory on adopts the canvas currently on screen.
      js(scenario, """
        app.store.setBackground({ color:'#2b2b2b', pattern:'dots' });
        const remember = document.querySelector('#panelBody .toggle input[type=checkbox]');
        remember.checked = true;
        remember.dispatchEvent(new Event('change', { bubbles:true }));
      """.trimIndent())
      until(scenario, "app.settings.rememberCanvas === true && " +
        "app.settings.canvasDefaults?.paper === 'a4' && " +
        "app.settings.canvasDefaults?.color === '#2b2b2b' && " +
        "app.settings.canvasDefaults?.pattern === 'dots'")

      // The remembered look belongs to boards created after the choice.
      js(scenario, "app.newBoard(true)")
      until(scenario, "!!app.store.page && " +
        "app.store.doc.background.color === '#2b2b2b' && " +
        "app.store.doc.background.pattern === 'dots'")

      // Loading an older board must never repaint it with today's defaults.
      js(scenario, """
        app.store.load({
          id:'older-board', name:'Older board', schema:2,
          background:{ color:'#ffffff', pattern:'none' },
          pages:[], objects:[], order:[]
        });
      """.trimIndent())
      assertEquals("true", js(scenario,
        "!app.store.page && app.store.doc.background.color === '#ffffff'"))

      // Do not leak the preference into another instrumentation test.
      js(scenario, """
        app.settings.rememberCanvas = false;
        delete app.settings.canvasDefaults;
        app.saveSettings();
      """.trimIndent())
    }
  }
}
