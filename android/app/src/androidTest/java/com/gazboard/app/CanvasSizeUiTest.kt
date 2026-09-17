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
    val state = js(scenario, """
      JSON.stringify({
        boardId: app?.store?.doc?.id || null,
        expectedBoardId: window.__androidCanvasTestBoardId || null,
        page: app?.store?.page || null,
        objects: app?.store?.objects?.length ?? null,
        hasNear: app?.store?.has?.('near') ?? false,
        hasFar: app?.store?.has?.('far') ?? false,
        immediate: window.__androidCanvasImmediate ?? null,
        offPage: app?.offPageObjects?.().length ?? null,
        panelOpen: document.getElementById('panel')?.classList.contains('open') ?? false,
        buttons: [...document.querySelectorAll('#panelBody .bg-sizes .btn')]
          .map(b => ({ label:b.textContent.trim(), primary:b.classList.contains('primary') }))
      })
    """.trimIndent())
    fail("Android canvas UI did not satisfy: $expression; state=$state")
  }

  @Test fun canvasMenuUpdatesFitsAndRemembersOnlyNewBoards() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && window.__gazboardAndroidCanvasUi === true")

      js(scenario, """
        app.settings.rememberCanvas = false;
        delete app.settings.canvasDefaults;
        app.saveSettings();

        // App construction starts restoreLastBoard() without awaiting it. The
        // restore may already have passed its boardOpenedExplicitly checks by
        // the time instrumentation gets here, so merely setting the flag cannot
        // cancel a loadBoard() that is already in flight. Keep one id plus two
        // sentinel objects for the board this test owns. A late startup load can
        // replace the contents while preserving an id through persistence, so
        // identity alone is not enough to prove that the test board survived.
        app.boardOpenedExplicitly = true;
        window.prepareAndroidCanvasTest = () => {
          app.newBoard(true);
          window.__androidCanvasTestBoardId = app.store.doc.id;
          window.__androidCanvasImmediate = false;
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
          const a4 = window.androidCanvasButton('A4');
          if (!a4) throw new Error('A4 canvas button was not rendered');
          a4.click();
          // The Android acknowledgement is synchronous: this records the state
          // before setPageSize() finishes and the shared panel rerenders.
          window.__androidCanvasImmediate = a4.classList.contains('primary');
        };
        window.prepareAndroidCanvasTest();
      """.trimIndent())

      until(scenario,
        "(() => { " +
          "const owns = app.store.doc.id === window.__androidCanvasTestBoardId && " +
            "app.store.has('near') && app.store.has('far') && " +
            "document.getElementById('panel')?.classList.contains('open') && " +
            "typeof window.androidCanvasButton === 'function' && window.androidCanvasButton('A4'); " +
          "if (!owns) { window.prepareAndroidCanvasTest(); return false; } " +
          "return window.__androidCanvasImmediate === true && !!app.store.page && " +
            "window.androidCanvasButton('A4').classList.contains('primary') && " +
            "[...document.querySelectorAll('#panelBody button')].some(b => /Fit .* onto the page/.test(b.textContent)); " +
        "})()")

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

      // Do not leak the preference or test helpers into another instrumentation test.
      js(scenario, """
        app.settings.rememberCanvas = false;
        delete app.settings.canvasDefaults;
        delete window.prepareAndroidCanvasTest;
        delete window.__androidCanvasTestBoardId;
        delete window.__androidCanvasImmediate;
        delete window.androidCanvasButton;
        app.saveSettings();
      """.trimIndent())
    }
  }
}
