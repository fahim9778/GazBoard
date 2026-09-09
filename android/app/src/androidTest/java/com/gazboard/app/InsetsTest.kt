package com.gazboard.app

import android.graphics.Bitmap
import android.content.pm.ActivityInfo
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InsetsTest {
  private fun js(scenario: ActivityScenario<MainActivity>, code: String): String {
    val result = CompletableFuture<String>()
    scenario.onActivity { it.web.evaluateJavascript(code) { value -> result.complete(value ?: "null") } }
    return result.get(10, TimeUnit.SECONDS)
  }
  private fun until(message: String, condition: () -> Boolean) {
    val start = System.currentTimeMillis()
    while (System.currentTimeMillis() - start < 30000) {
      if (condition()) return
      Thread.sleep(100)
    }
    fail(message)
  }
  private fun ready(scenario: ActivityScenario<MainActivity>) {
    until("Editor did not load") { js(scenario, "!!window.app && !!document.getElementById('toolbar').children.length") == "true" }
    js(scenario, "app.commitTextEdit(); app.dismissOverlay(); app.panels.close(); app.setTool('pen');")
  }
  private fun keyboardVisible(scenario: ActivityScenario<MainActivity>): Boolean {
    var visible = false
    scenario.onActivity { visible = ViewCompat.getRootWindowInsets(it.frame)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
    return visible
  }
  private fun screenshot(name: String) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
      File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
      }
      bitmap.recycle()
    }
  }
  private fun layout(scenario: ActivityScenario<MainActivity>): JsonObject = Json.parseToJsonElement(js(scenario, """
    (() => {
      const bar = document.getElementById('toolbar');
      const stage = document.getElementById('stage').getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const style = getComputedStyle(document.getElementById('app'));
      return { gap: stage.bottom - b.bottom, bottom: innerHeight - stage.bottom,
        padding: parseFloat(style.paddingBottom), visibleHeight: visualViewport.height,
        height: innerHeight, phone: bar.classList.contains('phone'),
        expected: bar.classList.contains('phone') ? 10 : (matchMedia('(max-height: 620px)').matches ? 8 : 14),
        fits: b.left >= stage.left && b.right <= stage.right && b.height > 0 };
    })()
  """.trimIndent())).jsonObject
  private fun checkGap(data: JsonObject) {
    assertEquals("Toolbar must keep only its small design margin: $data",
      data.getValue("expected").jsonPrimitive.double, data.getValue("gap").jsonPrimitive.double, 1.0)
    assertTrue("Toolbar must fit inside the canvas: $data", data.getValue("fits").jsonPrimitive.boolean)
  }

  @Test fun nativePaddingDoesNotReachWebViewAgain() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      ready(scenario)
      scenario.onActivity { activity ->
        val bars = WindowInsetsCompat.Type.systemBars()
        val cutout = WindowInsetsCompat.Type.displayCutout()
        val ime = WindowInsetsCompat.Type.ime()
        var received: WindowInsetsCompat? = null
        ViewCompat.setOnApplyWindowInsetsListener(activity.web) { _, insets -> received = insets; insets }
        try {
          // Gesture navigation, three-button navigation, landscape cutout,
          // keyboard opening and closing. Dimensions are native pixels here.
          for ((navigation, left, keyboard) in listOf(
            Triple(24, 0, 0), Triple(96, 0, 0), Triple(24, 80, 0),
            Triple(96, 0, 600), Triple(96, 0, 0)
          )) {
            val source = WindowInsetsCompat.Builder()
              .setInsets(bars, Insets.of(0, 64, 0, navigation))
              .setInsets(cutout, Insets.of(left, 0, 0, 0))
              .setInsets(ime, Insets.of(0, 0, 0, keyboard))
              .setVisible(bars, true).setVisible(ime, keyboard > 0).build()
            received = null
            ViewCompat.dispatchApplyWindowInsets(activity.frame, source)
            assertEquals(64, activity.frame.paddingTop)
            assertEquals(left, activity.frame.paddingLeft)
            assertEquals(maxOf(navigation, keyboard), activity.frame.paddingBottom)
            assertNotNull("Inset changes must still reach the WebView", received)
            assertEquals(Insets.NONE, received!!.getInsets(bars or cutout or ime))
            assertFalse("Do not block later keyboard updates with CONSUMED", received!!.isConsumed)
          }
        } finally {
          ViewCompat.setOnApplyWindowInsetsListener(activity.web, null)
          ViewCompat.requestApplyInsets(activity.frame)
        }
      }
    }
  }

  @Test fun toolbarReturnsToTheBottomAfterTheKeyboardCloses() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      ready(scenario)
      until("Keyboard should start closed") { !keyboardVisible(scenario) }
      val before = layout(scenario)
      checkGap(before)
      assertEquals("Native padding already protects the page", 0.0, before.getValue("padding").jsonPrimitive.double, 1.0)
      screenshot("android-toolbar.png")
      js(scenario, "document.getElementById('boardTitle').focus();")
      scenario.onActivity { activity ->
        activity.web.requestFocus()
        WindowCompat.getInsetsController(activity.window, activity.web).show(WindowInsetsCompat.Type.ime())
      }
      until("Keyboard did not open") { keyboardVisible(scenario) }
      until("Editor did not resize above the keyboard") {
        layout(scenario).getValue("height").jsonPrimitive.double < before.getValue("height").jsonPrimitive.double - 80
      }
      until("Zoom must stay compact and visible above the keyboard") { js(scenario, """
        (() => {
          const zoom = document.getElementById('zoombar');
          const box = zoom.getBoundingClientRect();
          return box.height > 0 && box.height < 70 && box.top >= 0 && box.bottom <= innerHeight
            && (!matchMedia('(max-height: 460px)').matches || getComputedStyle(zoom).bottom === 'auto');
        })()
      """.trimIndent()) == "true" }
      js(scenario, "document.getElementById('boardTitle').blur();")
      scenario.onActivity { WindowCompat.getInsetsController(it.window, it.web).hide(WindowInsetsCompat.Type.ime()) }
      until("Keyboard did not close") { !keyboardVisible(scenario) }
      until("Editor retained keyboard space") {
        kotlin.math.abs(layout(scenario).getValue("height").jsonPrimitive.double - before.getValue("height").jsonPrimitive.double) < 1
      }
      val after = layout(scenario)
      checkGap(after)
      assertEquals(after.getValue("height").jsonPrimitive.double, after.getValue("visibleHeight").jsonPrimitive.double, 1.0)
      assertEquals(0.0, after.getValue("bottom").jsonPrimitive.double, 1.0)
      screenshot("android-toolbar-keyboard-closed.png")
    }
  }

  @Test fun landscapeKeepsZoomAboveThePens() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      ready(scenario)
      scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
      until("Landscape viewport did not settle") { js(scenario, "innerWidth > innerHeight") == "true" }
      until("Zoom did not follow the toolbar") { js(scenario, """
        (() => {
          const bar = document.getElementById('toolbar').getBoundingClientRect();
          const zoom = document.getElementById('zoombar').getBoundingClientRect();
          return zoom.bottom <= bar.top && bar.top - zoom.bottom < 45;
        })()
      """.trimIndent()) == "true" }
      screenshot("android-toolbar-landscape.png")
    }
  }

  @Test fun webSafeAreaIsReservedOnceAroundTheStage() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      ready(scenario)
      // Exercise the actual CSS in a real browser with nonzero web insets,
      // as a PWA has them. Android normally zeroes them before CSS sees them.
      js(scenario, """
        window.safeAreaTestReady = false;
        (async () => {
          const css = await (await fetch('./css/app.css')).text();
          const style = document.createElement('style');
          style.id = 'testSafeAreas';
          style.textContent = css.replace(/env\(safe-area-inset-(top|right|bottom|left), 0px\)/g,
            (_, edge) => ({ top: '24px', right: '16px', bottom: '48px', left: '16px' })[edge]);
          document.head.appendChild(style);
          window.safeAreaTestReady = true;
        })();
      """.trimIndent())
      try {
        until("Test safe areas did not load") { js(scenario, "window.safeAreaTestReady") == "true" }
        val data = layout(scenario)
        assertEquals(48.0, data.getValue("padding").jsonPrimitive.double, 1.0)
        assertEquals("Only the app frame reserves the inset", 48.0, data.getValue("bottom").jsonPrimitive.double, 1.0)
        checkGap(data)
      } finally { js(scenario, "document.getElementById('testSafeAreas')?.remove();") }
    }
  }
}
