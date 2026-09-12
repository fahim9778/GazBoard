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
  @Test fun dismissesSelectionAndExportsAPortableBoard() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && !!window.app.store")
      until(scenario, "document.getElementById('savedBadge').textContent !== 'Saving…'")
      lateinit var copy: File
      lateinit var handle: String
      scenario.onActivity { activity ->
        copy = File(File(activity.cacheDir, "exports").apply { mkdirs() }, "storage-test.gazboard")
        copy.writeText("")
        val uri = FileProvider.getUriForFile(activity, BuildConfig.APPLICATION_ID + ".files", copy)
        handle = (activity.application as GazBoardApplication).files.register(uri, writable = true)
      }
      try {
        js(scenario, """
          window.storageTestDone = false;
          (async () => {
            try {
              app.settings.inkWithMouse = 'yes'; app.settings.inkWithFinger = 'yes';
              app.settings.inkToShape = false;
              await app.loadBoard({ id: 'selection-storage-test', name: 'Portable বাংলা', objects: [],
                pages: [], camera: { x: 0, y: 0, z: 1 } });
              app.store.add({ id: 'selected-note', type: 'note', x: 100, y: 100, w: 160, h: 160,
                color: '#ffd94a', text: 'Before', rotation: 0, align: 'center', font: 'ui' });
              const canvas = document.getElementById('c');
              let index = 0;
              for (const tool of ['pen', 'highlighter']) for (const pointerType of ['pen', 'touch', 'mouse']) {
                const tap = () => {
                  const r = canvas.getBoundingClientRect();
                  const p = app.surface.cam.toScreen(450 + index * 24, 320);
                  for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, {
                    pointerId: 51, pointerType, isPrimary: true, bubbles: true, button: 0,
                    clientX: r.left + p.x, clientY: r.top + p.y,
                    buttons: type === 'pointerup' ? 0 : 1, pressure: .5
                  }));
                };
                app.setTool(tool); app.setSelection(['selected-note']);
                const before = app.store.count, undo = app.store.undoStack.length;
                tap();
                if (app.store.count !== before || app.store.undoStack.length !== undo) throw Error(pointerType + ' dismissal left ink');
                if (app.selection.size || app.surface.wet) throw Error('Selection or wet ink remained');
                if (document.getElementById('ctxbar').classList.contains('show')) throw Error('Selection bar remained');
                app.setSelection(['selected-note']); app.armToolRestore(); app.setTool('select');
                app.beginTextEdit(app.store.get('selected-note'));
                app.textEditor.el.value = 'Saved words ' + index;
                tap();
                if (app.textEditor.active || app.selection.size || app.tool !== tool) throw Error('Text edit did not finish');
                if (app.store.count !== before || app.store.undoStack.length !== undo + 1) throw Error('Text dismissal left ink');
                if (app.store.get('selected-note').text !== 'Saved words ' + index) throw Error('Text was lost');
                tap();
                if (app.store.count !== before + 1) throw Error('Intentional dot was swallowed');
                index++;
              }
              const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=';
              app.store.add({ id: 'copy-image', type: 'image', x: 700, y: 100, w: 50, h: 50, rotation: 0, src: image });
              await app.persist();
              await app.panels.boards();
              for (let n = 0; n < 50 && !document.getElementById('boardList').textContent.includes('private storage'); n++)
                await new Promise(resolve => setTimeout(resolve, 100));
              const host = document.getElementById('boardList');
              if (host.textContent.includes('browser persistence') || !host.textContent.includes('private storage')) throw Error('Wrong Android storage description');
              const save = [...host.querySelectorAll('button')].find(b => b.textContent === 'Save current board…');
              if (!save) throw Error('Save a copy is missing');
              const originalDialog = board.saveDialog, originalWrite = board.writeFile;
              let finish, reject;
              const written = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
              // Supply the same granted content handle as the Android picker.
              // The real exporter, message bridge and content-provider write run below.
              board.saveDialog = async () => ${JsonPrimitive(handle)};
              board.writeFile = async (...args) => {
                try { const result = await originalWrite(...args); finish(); return result; }
                catch (e) { reject(e); throw e; }
              };
              try { save.click(); await written; }
              finally { board.saveDialog = originalDialog; board.writeFile = originalWrite; }
              const exported = JSON.parse(new TextDecoder().decode(await board.readFile(${JsonPrimitive(handle)})));
              if (exported.name !== 'Portable বাংলা' || exported.objects.length !== app.store.count) throw Error('Export lost board contents');
              if (exported.objects.find(o => o.id === 'copy-image').src !== image) throw Error('Export lost its image');
              await app.loadBoard(exported);
              if (app.store.get('copy-image').src !== image) throw Error('Copy did not reopen');
              const activeId = app.store.doc.id;
              await board.boards.save({ id: 'zip-other', json: JSON.stringify({
                id: 'zip-other', name: 'Second board', objects: [{ id: 'zip-text', type: 'text', text: 'Other board' }]
              }), setLast: false });
              board.saveDialog = async () => ${JsonPrimitive(handle)};
              try {
                const { exportBoards } = await import(new URL('./js/board-export.js', location.href).href);
                await exportBoards(app, ['zip-other', activeId]);
                const zip = await window.JSZip.loadAsync(await board.readFile(${JsonPrimitive(handle)}));
                if (Object.keys(zip.files).length !== 2) throw Error('ZIP lost a selected board');
                const other = JSON.parse(await zip.file('Second board.gazboard').async('string'));
                if (other.id !== 'zip-other' || app.store.doc.id !== activeId) throw Error('ZIP exported the wrong board');
              } finally { board.saveDialog = originalDialog; await board.boards.remove('zip-other'); }
              await app.showAbout();
              const about = document.getElementById('overlayCard').textContent;
              if (!about.includes('Runtime: Android') || about.includes('IndexedDB')) throw Error('About mislabels Android storage');
              app.dismissOverlay();
              window.storageTestDone = true;
            } catch (e) { window.storageTestError = e.stack; }
          })();
        """.trimIndent())
        until(scenario, "window.storageTestDone === true || !!window.storageTestError")
        assertEquals("null", js(scenario, "window.storageTestError || null"))
        assertTrue("Export must reach its chosen document provider", copy.length() > 0)
      } finally { copy.delete() }
    }
  }
  @Test fun holdingShowsOnlyQuickActionsUntilMoreIsTapped() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && !!window.app.store")
      js(scenario, """
        (async () => {
          try {
            await app.loadBoard({ id: 'hold-resize-test', name: 'Hold and resize', objects: [], pages: [], camera: { x: 0, y: 0, z: 1 } });
            const canvas = document.getElementById('c');
            const pointer = (type, device, x, y) => {
              const r = canvas.getBoundingClientRect();
              canvas.dispatchEvent(new PointerEvent(type, { pointerId: 71, pointerType: device, bubbles: true,
                isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: .5,
                clientX: r.left + x, clientY: r.top + y }));
            };
            for (const finger of ['yes', 'no']) for (const device of ['touch', 'pen']) for (const resizeWith of ['touch', 'pen']) {
              app.hideMenus(); app.setTool('pen'); app.settings.inkWithFinger = finger;
              app.store.add({ id: 'hold-note', type: 'note', x: 60, y: 70, w: 150, h: 150,
                rotation: 0, text: 'Resize me', color: '#ffd94a', font: 'ui', align: 'center' });
              const before = app.store.count, undo = app.store.undoStack.length;
              pointer('pointerdown', device, 130, 140);
              await new Promise(resolve => setTimeout(resolve, 520));
              if (document.querySelector('.pop .menu') || !app.selection.has('hold-note') || !document.querySelector('#ctxbar.show')) throw Error('Hold must show only quick actions: ' + device + finger);
              pointer('pointermove', device, 150, 160);
              pointer('pointerup', device, 150, 160);
              if (app.store.get('hold-note').x <= 60) throw Error('Holding did not allow dragging');
              canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
              if (document.querySelector('.pop .menu')) throw Error('Release or native contextmenu opened expanded actions');
              const more = document.querySelector('#ctxbar [title="More actions"]');
              if (!more) throw Error('Quick actions must offer More');
              more.click();
              if (!document.querySelector('.pop .menu') || !app.selection.has('hold-note')) throw Error('More did not expand actions for the selection');
              app.hideMenus();
              if (app.store.undoStack.length !== undo + 1) throw Error('Hold and drag should record only the move');
              const box = app.surface.selectionScreenBox();
              pointer('pointerdown', resizeWith, box.x + box.w, box.y + box.h);
              pointer('pointermove', resizeWith, box.x + box.w + 35, box.y + box.h + 35);
              pointer('pointerup', resizeWith, box.x + box.w + 35, box.y + box.h + 35);
              if (app.store.get('hold-note').w <= 150 || app.tool !== 'pen') throw Error('Resize did not work with the pen chosen');
              if (app.store.count !== before) throw Error('Resizing left ink');
              app.store.remove(['hold-note']); app.setSelection([]);
            }
            app.store.add({ id: 'locked-note', type: 'note', x: 60, y: 70, w: 150, h: 150,
              rotation: 0, locked: true, text: 'Locked', color: '#ffd94a', font: 'ui', align: 'center' });
            pointer('pointerdown', 'pen', 130, 140);
            await new Promise(resolve => setTimeout(resolve, 520));
            pointer('pointerup', 'pen', 130, 140);
            if (document.querySelector('.pop .menu')) throw Error('Locked hold opened expanded actions');
            document.querySelector('#ctxbar [title="More actions"]').click();
            if (!document.querySelector('.pop .menu')?.textContent.includes('Unlock')) throw Error('Locked actions must remain available through More');
            window.holdTestDone = true;
          } catch (e) { window.holdTestError = e.stack; }
        })();
      """.trimIndent())
      until(scenario, "window.holdTestDone === true || !!window.holdTestError")
      assertEquals("null", js(scenario, "window.holdTestError || null"))
    }
  }
  @Test fun movingStylusCancelsHoldSelectionAndKeepsWriting() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      until(scenario, "!!window.app && !!window.app.store")
      js(scenario, """
        (async () => {
          try {
            await app.loadBoard({ id: 'stylus-pause-test', name: 'Pause and write', objects: [], pages: [], camera: { x: 0, y: 0, z: 1 } });
            const canvas = document.getElementById('c');
            const pointer = (type, x, y) => {
              const r = canvas.getBoundingClientRect();
              canvas.dispatchEvent(new PointerEvent(type, { pointerId: 72, pointerType: 'pen', bubbles: true,
                isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: .5,
                clientX: r.left + x, clientY: r.top + y }));
            };
            app.store.add({ id: 'pause-note', type: 'note', x: 60, y: 70, w: 150, h: 150,
              rotation: 0, text: 'Write over me', color: '#ffd94a', font: 'ui', align: 'center' });
            const note = JSON.stringify(app.store.get('pause-note'));
            for (const tool of ['pen', 'highlighter']) for (const finger of ['yes', 'no']) {
              app.hideMenus(); app.setSelection([]); app.setTool(tool); app.settings.inkWithFinger = finger;
              const before = app.store.count;
              pointer('pointerdown', 130, 140);
              pointer('pointermove', 150, 160);
              await new Promise(resolve => setTimeout(resolve, 700));
              if (document.querySelector('.pop .menu') || app.selection.size) throw Error('Stylus pause selected an object');
              if (app.interaction.action?.type !== 'draw' || !app.surface.wet) throw Error('Stylus pause lost the stroke');
              pointer('pointerup', 150, 160);
              const stroke = app.store.objects.at(-1);
              if (app.store.count !== before + 1 || stroke.type !== 'stroke' || stroke.tool !== tool || stroke.bbox.w <= 4) throw Error('Writing did not resume: ' + tool + finger);
              if (app.tool !== tool || app.selection.size || app.surface.wet) throw Error('Writing changed the active tool or selection');
              if (JSON.stringify(app.store.get('pause-note')) !== note) throw Error('Stylus moved or changed the note');
            }
            window.stylusPauseDone = true;
          } catch (e) { window.stylusPauseError = e.stack; }
        })();
      """.trimIndent())
      until(scenario, "window.stylusPauseDone === true || !!window.stylusPauseError")
      assertEquals("null", js(scenario, "window.stylusPauseError || null"))
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
