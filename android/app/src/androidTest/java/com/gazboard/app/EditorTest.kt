package com.gazboard.app

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.gazboard.sync.*
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EditorTest {
  private fun js(scenario: ActivityScenario<MainActivity>, code: String): String {
    val answer = CompletableFuture<String>()
    scenario.onActivity { it.web.evaluateJavascript(code) { value -> answer.complete(value ?: "null") } }
    return answer.get(10, TimeUnit.SECONDS)
  }
  private fun until(scenario: ActivityScenario<MainActivity>, expression: String, timeout: Long = 30000) {
    val start = System.currentTimeMillis()
    while (System.currentTimeMillis() - start < timeout) {
      if (js(scenario, expression) == "true") return
      Thread.sleep(100)
    }
    fail("Editor did not satisfy: $expression; " + js(scenario, "document.body.innerText.slice(0,1500)"))
  }
  @Test fun drawsUndoesSavesAndReopensThroughNativeBridge() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && !!window.app.store")
      until(scenario, "document.getElementById('savedBadge').textContent !== 'Saving…'")
      js(scenario, """
        window.testDone = false;
        (async () => {
          try {
            const info = await board.info();
            if (info.platform !== 'android') throw Error('Wrong platform');
            if ((await board.sync.state()).running) throw Error('Sharing opened without consent');
            app.settings.updateCheck = false; app.saveSettings();
            app.store.rename('Android test বাংলা');
            app.setTool('pen');
            const canvas = document.getElementById('c');
            const rect = canvas.getBoundingClientRect();
            const before = app.store.objects.length;
            const pointer = (type, x, y, pressure = .6) => canvas.dispatchEvent(new PointerEvent(type, {
              pointerId: 37, pointerType: 'pen', isPrimary: true, bubbles: true,
              clientX: rect.left + x, clientY: rect.top + y, button: 0,
              buttons: type === 'pointerup' ? 0 : 1, pressure
            }));
            pointer('pointerdown', 100, 180);
            for (let i = 1; i <= 20; i++) pointer('pointermove', 100 + i * 12, 180 + Math.sin(i / 3) * 40);
            pointer('pointerup', 340, 195, 0);
            if (app.store.objects.length !== before + 1) throw Error('Pen did not create one stroke');
            app.command('undo');
            if (app.store.objects.length !== before) throw Error('Undo failed');
            app.command('redo');
            if (app.store.objects.length !== before + 1) throw Error('Redo failed');
            await app.persist();
            const saved = await board.boards.load(app.store.doc.id);
            if (!saved || saved.name !== 'Android test বাংলা') throw Error('Native save failed');
            const resumed = await board.boards.resume();
            if (resumed.board.id !== saved.id) throw Error('Resume pointer lost');
            let rejected = false;
            try { await board.readFile('/data/data/com.gazboard.app/files/paired.enc'); } catch { rejected = true; }
            if (!rejected) throw Error('Arbitrary file access permitted');
            window.testSavedId = saved.id;
            window.testDone = true;
          } catch (e) { window.testError = e.stack; }
        })();
      """.trimIndent())
      until(scenario, "window.testDone === true || !!window.testError")
      assertEquals("null", js(scenario, "window.testError || null"))
      val id = js(scenario, "window.testSavedId")
      scenario.recreate()
      until(scenario, "!!window.app && window.app.store.doc.id === $id")
      assertEquals("\"Android test বাংলা\"", js(scenario, "app.store.doc.name"))
      assertEquals("true", js(scenario, "app.store.objects.some(o => o.type === 'stroke')"))
      InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "android-editor.png").outputStream().use {
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
      }
    }
  }
  @Test fun boardStoragePreservesBackgroundImportsAndImages() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val storage = BoardStorage(context)
    val first = "test-" + Protocol.deviceId()
    val second = "test-" + Protocol.deviceId()
    try {
      storage.save(json("id" to first, "name" to "Main lesson", "objects" to emptyList<Any>()))
      storage.save(json("id" to second, "json" to json("id" to second, "name" to "Incoming", "objects" to emptyList<Any>()).toString(), "setLast" to false))
      assertEquals(first, BoardStorage(context).resume()["board"]!!.obj().str("id"))
      val image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII="
      val asset = storage.putAsset(image)!!
      assertEquals(image, BoardStorage(context).getAsset(asset.str("id")))
      assertEquals(asset, storage.putAsset(image))
      assertNull(storage.load("../paired"))
      assertNull(storage.getAsset("../paired.enc"))
    } finally { storage.remove(first); storage.remove(second) }
  }
  @Test fun convertsWordAndTextToReadableMultipagePdf() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && !!window.app.store")
      lateinit var activity: MainActivity
      scenario.onActivity { activity = it }
      val app = activity.application as GazBoardApplication
      val folder = File(activity.cacheDir, "exports").apply { mkdirs() }
      val paragraphs = (1..90).joinToString("") { "<w:p><w:r><w:t>GazBoard lesson $it. A whiteboard for every classroom.</w:t></w:r></w:p>" }
      val document = File(folder, "conversion-test.docx")
      ZipOutputStream(document.outputStream()).use { zip ->
        fun entry(name: String, text: String) { zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry() }
        entry("[Content_Types].xml", """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""")
        entry("_rels/.rels", """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""")
        entry("word/document.xml", """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>$paragraphs</w:body></w:document>""")
      }
      val text = File(folder, "conversion-test.txt").apply { writeText((1..150).joinToString("\n") { "GazBoard page test: paragraph $it" }) }
      for (source in listOf(document, text)) {
        val uri = FileProvider.getUriForFile(activity, BuildConfig.APPLICATION_ID + ".files", source)
        val handle = app.files.register(uri)
        val result = activity.convertDocument(handle)
        assertTrue(result.bool("ok"))
        val token = result.str("token")
        try {
          PdfRenderer(ParcelFileDescriptor.open(app.files.file(token), ParcelFileDescriptor.MODE_READ_ONLY)).use { pdf ->
            assertTrue("Document must paginate", pdf.pageCount >= 2)
            for (index in listOf(0, pdf.pageCount - 1)) {
              pdf.openPage(index).use { page ->
                val bitmap = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                var ink = 0
                for (y in 0 until bitmap.height step 2) for (x in 0 until bitmap.width step 2) {
                  val pixel = bitmap.getPixel(x, y)
                  if (Color.red(pixel) < 180 && Color.green(pixel) < 180 && Color.blue(pixel) < 180) ink++
                }
                assertTrue("Converted page $index is blank", ink > 50)
                bitmap.recycle()
              }
            }
          }
        } finally { app.files.release(token); source.delete() }
      }
    }
  }
}
