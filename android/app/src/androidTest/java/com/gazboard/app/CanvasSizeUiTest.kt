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
        setupError: window.__androidCanvasSetupError ?? null,
        offPage: window.app?.offPageObjects?.().length ?? null,
        panelOpen: document.getElementById('panel')?.classList.contains('open') ?? false,
        buttons: [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
          .map(b => ({ label:b.textContent.trim(), primary:b.classList.contains('primary') }))
      })
    """.trimIndent()) ?: "WebView unavailable"
    fail("Android canvas UI did not satisfy: $expression; state=$state")
  }

  /**
   * Build an isolated in-memory document for the Canvas UI assertions.
   *
   * This deliberately does not call app.newBoard(). newBoard() also updates
   * native persistence (the resume pointer), which is unrelated to the Canvas
   * behaviour under test and can overlap the asynchronous startup restore on a
   * slow emulator. The real newBoard() path is still exercised later, after the
   * app is settled, to verify remembered Canvas defaults on newly created boards.
   */
  private fun prepareCanvasTest(scenario: ActivityScenario<MainActivity>) {
    val result = js(scenario, """
      (() => {
        try {
          window.__androidCanvasSetupError = null;
          app.settings.rememberCanvas = false;
          delete app.settings.canvasDefaults;
          app.saveSettings();

          // Prevent a restore that has not yet committed from claiming ownership
          // after this point. If one was already in flight, the Kotlin loop below
          // detects the lost sentinels and simply installs this in-memory fixture
          // again without touching Android persistence.
          app.boardOpenedExplicitly = true;
          app.store.load({
            id:'android-canvas-device-test',
            name:'Android canvas device test',
            schema:2,
            background:{ color:'#ffffff', pattern:'none' },
            pages:[], objects:[], order:[]
          });
          window.__androidCanvasTestBoardId = app.store.doc.id;
          window.__androidCanvasImmediate = false;
          app.store.add({ id:'near', type:'shape', kind:'rect', x:0, y:0,
            w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });
          app.store.add({ id:'far', type:'shape', kind:'rect', x:4000, y:3000,
            w:120, h:90, rotation:0, stroke:'#000', fill:'none', lineWidth:2 });
          app.syncUI();
          app.surface.invalidate();

          // background() toggles an already-open panel closed, so always close
          // any panel left by another instrumentation test before opening Canvas.
          app.panels.close?.();
          app.panels.background();
          const a4 = [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
            .find(b => b.textContent.trim() === 'A4');
          if (!a4) throw new Error('A4 canvas button was not rendered');
          a4.click();

          // The panel paints the press synchronously, before the shared async
          // setPageSize() work finishes and rerenders. That feedback lives in
          // panels.js and so is the same on every platform - there is no
          // Android-only script to wait for.
          window.__androidCanvasImmediate = a4.classList.contains('primary');
          return true;
        } catch (error) {
          window.__androidCanvasSetupError = String(error?.stack || error);
          return false;
        }
      })()
    """.trimIndent())
    if (result != "true") {
      throw IllegalStateException(
        "Canvas fixture setup failed: " +
          (maybeJs(scenario, "window.__androidCanvasSetupError || 'unknown error'") ?: "WebView unavailable")
      )
    }
  }

  private fun untilCanvasSetupSurvives(
    scenario: ActivityScenario<MainActivity>,
    timeout: Long = 20_000
  ) {
    val started = System.currentTimeMillis()
    while (System.currentTimeMillis() - started < timeout) {
      val ready = maybeJs(scenario,
        "!!window.app && !!window.app.store && !!window.app.panels") == "true"
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
          // Startup can still be changing the board between the readiness probe
          // and fixture installation. Retry until the document is stable.
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
        panelsReady: !!window.app?.panels,
        boardId: window.app?.store?.doc?.id || null,
        expectedBoardId: window.__androidCanvasTestBoardId || null,
        page: window.app?.store?.page || null,
        objects: window.app?.store?.objects?.length ?? null,
        hasNear: window.app?.store?.has?.('near') ?? false,
        hasFar: window.app?.store?.has?.('far') ?? false,
        immediate: window.__androidCanvasImmediate ?? null,
        setupError: window.__androidCanvasSetupError ?? null,
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
      until(scenario, "!!window.app && !!window.app.store && !!window.app.panels")
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

      // The remembered look belongs to real boards created after the choice.
      // By here startup restoration is long finished, so this exercises the
      // production newBoard() path without using it as test-fixture machinery.
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
        delete window.__androidCanvasSetupError;
        app.saveSettings();
      """.trimIndent())
    }
  }
}
