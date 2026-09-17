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

  private fun maybeJs(scenario: ActivityScenario<MainActivity>, code: String): String? =
    try { js(scenario, code) } catch (_: Exception) { null }

  private fun until(
    scenario: ActivityScenario<MainActivity>,
    expression: String,
    timeout: Long = 10_000
  ) {
    val started = System.currentTimeMillis()
    while (System.currentTimeMillis() - started < timeout) {
      if (maybeJs(scenario, expression) == "true") return
      Thread.sleep(50)
    }
    val state = maybeJs(scenario, """
      JSON.stringify({
        boardId: window.app?.store?.doc?.id || null,
        expectedBoardId: window.__androidCanvasTestBoardId || null,
        page: window.app?.store?.page || null,
        objects: window.app?.store?.objects?.length ?? null,
        hasNear: window.app?.store?.has?.('near') ?? false,
        hasFar: window.app?.store?.has?.('far') ?? false,
        immediate: window.__androidCanvasImmediate ?? null,
        offPage: window.app?.offPageObjects?.().length ?? null,
        panelOpen: document.getElementById('panel')?.classList.contains('open') ?? false,
        buttons: [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
          .map(b => ({ label:b.textContent.trim(), primary:b.classList.contains('primary') }))
      })
    """.trimIndent()) ?: "WebView unavailable"
    fail("Android canvas UI did not satisfy: $expression; state=$state")
  }

  /**
   * Establish the state owned by this test inside whichever WebView document is
   * currently alive. The recovery code deliberately lives in Kotlin rather than
   * on window: if Android reloads/replaces the document during startup, every
   * window helper disappears with it but instrumentation is still alive and can
   * simply inject the setup again into the replacement document.
   */
  private fun prepareCanvasTest(scenario: ActivityScenario<MainActivity>) {
    js(scenario, """
      app.settings.rememberCanvas = false;
      delete app.settings.canvasDefaults;
      app.saveSettings();

      // App construction starts restoreLastBoard() without awaiting it. Mark an
      // explicit owner as soon as this document is ready, then create sentinels
      // that let Kotlin detect either a late board restore or a whole-document
      // replacement without relying on any JS helper surviving the event.
      app.boardOpenedExplicitly = true;
      app.newBoard(true);
      window.__androidCanvasTestBoardId = app.store.doc.id;
      window.__androidCanvasImmediate = false;
      app.store.add({ id:'near', type:'shape', kind:'rect', x:0, y:0,
        w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });
      app.store.add({ id:'far', type:'shape', kind:'rect', x:4000, y:3000,
        w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });

      // background() toggles an already-open panel closed, so always close any
      // panel restored by another instrumentation test before opening Canvas.
      app.panels.close?.();
      app.panels.background();
      const a4 = [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
        .find(b => b.textContent.trim() === 'A4');
      if (!a4) throw new Error('A4 canvas button was not rendered');
      a4.click();

      // android-canvas-ui.js acknowledges the tap synchronously, before the
      // shared async setPageSize() work completes and rerenders the panel.
      window.__androidCanvasImmediate = a4.classList.contains('primary');
    """.trimIndent())
  }

  private fun untilCanvasSetupSurvives(
    scenario: ActivityScenario<MainActivity>,
    timeout: Long = 20_000
  ) {
    val started = System.currentTimeMillis()
    while (System.currentTimeMillis() - started < timeout) {
      val ready = maybeJs(scenario,
        "!!window.app && window.__gazboardAndroidCanvasUi === true") == "true"
      if (!ready) {
        Thread.sleep(50)
        continue
      }

      val owns = maybeJs(scenario, """
        (() => {
          const a4 = [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
            .find(b => b.textContent.trim() === 'A4');
          return app.store.doc.id === window.__androidCanvasTestBoardId &&
            app.store.has('near') && app.store.has('far') &&
            document.getElementById('panel')?.classList.contains('open') && !!a4;
        })()
      """.trimIndent()) == "true"

      if (!owns) {
        try { prepareCanvasTest(scenario) } catch (_: Exception) {
          // The document may have changed between the readiness probe and this
          // injection. The next iteration waits for the replacement to settle.
        }
        Thread.sleep(100)
        continue
      }

      val complete = maybeJs(scenario, """
        (() => {
          const a4 = [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
            .find(b => b.textContent.trim() === 'A4');
          return window.__androidCanvasImmediate === true && !!app.store.page &&
            !!a4 && a4.classList.contains('primary') &&
            [...document.querySelectorAll('#panelBody button')]
              .some(b => /Fit .* onto the page/.test(b.textContent));
        })()
      """.trimIndent()) == "true"
      if (complete) return

      Thread.sleep(50)
    }

    val state = maybeJs(scenario, """
      JSON.stringify({
        ready: !!window.app,
        androidUi: window.__gazboardAndroidCanvasUi ?? null,
        boardId: window.app?.store?.doc?.id || null,
        expectedBoardId: window.__androidCanvasTestBoardId || null,
        page: window.app?.store?.page || null,
        objects: window.app?.store?.objects?.length ?? null,
        hasNear: window.app?.store?.has?.('near') ?? false,
        hasFar: window.app?.store?.has?.('far') ?? false,
        immediate: window.__androidCanvasImmediate ?? null,
        offPage: window.app?.offPageObjects?.().length ?? null,
        panelOpen: document.getElementById('panel')?.classList.contains('open') ?? false,
        buttons: [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
          .map(b => ({ label:b.textContent.trim(), primary:b.classList.contains('primary') }))
      })
    """.trimIndent()) ?: "WebView unavailable"
    fail("Android canvas test never reached a stable owned setup; state=$state")
  }

  @Test fun canvasMenuUpdatesFitsAndRemembersOnlyNewBoards() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && window.__gazboardAndroidCanvasUi === true")
      prepareCanvasTest(scenario)
      untilCanvasSetupSurvives(scenario)

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

      // Do not leak the preference or test markers into another instrumentation test.
      js(scenario, """
        app.settings.rememberCanvas = false;
        delete app.settings.canvasDefaults;
        delete window.__androidCanvasTestBoardId;
        delete window.__androidCanvasImmediate;
        app.saveSettings();
      """.trimIndent())
    }
  }
}
