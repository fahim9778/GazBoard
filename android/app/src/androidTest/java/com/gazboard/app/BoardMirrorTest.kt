package com.gazboard.app

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.gazboard.sync.*
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The folder copy, against a plain folder standing in for the one picked with
 * Android's folder picker (which a test cannot press). Everything the copy
 * decides - which files, when, what comes back, what is never touched - is the
 * same code the app runs; only the last step, reading and writing a file, differs.
 */
@RunWith(AndroidJUnit4::class)
class BoardMirrorTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var picked: File

  private class PlainFolder(private val dir: File) : BoardMirror.Folder {
    override val name: String get() = dir.name
    override fun list() = dir.listFiles().orEmpty().associate { it.name to it.isDirectory }
    override fun sub(name: String, create: Boolean): BoardMirror.Folder? {
      val f = File(dir, name)
      if (!f.exists() && create) f.mkdirs()
      return if (f.isDirectory) PlainFolder(f) else null
    }
    override fun read(name: String) = File(dir, name).readBytes()
    override fun write(name: String, mime: String, bytes: ByteArray) = File(dir, name).writeBytes(bytes)
    override fun delete(name: String) { File(dir, name).delete() }
  }

  private fun mirror() = BoardMirror(context, "backup-folder-test") { PlainFolder(File(it.path!!)) }
  private fun board(id: String, name: String) = json("id" to id, "name" to name, "objects" to JsonArray(emptyList())).toString()
  private val pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  @Before fun setUp() {
    picked = File(context.cacheDir, "Documents-" + System.nanoTime()).apply { mkdirs() }
    File(picked, "package.json").writeText("""{"name":"someone else's"}""")
  }
  @After fun tearDown() {
    picked.deleteRecursively()
    context.getSharedPreferences("backup-folder-test", 0).edit().clear().commit()
  }

  @Test fun savedBoardsAndPicturesAreCopiedIntoAGazBoardFolderAndNothingElseIsTouched() {
    val storage = BoardStorage(context)
    val m = mirror()
    storage.listener = m
    val chosen = m.use(Uri.fromFile(picked))
    val id = "bMirror" + System.nanoTime()
    storage.save(json("id" to id, "json" to board(id, "Copied board"), "setLast" to false))
    val pic = storage.putAsset("data:image/png;base64,$pixel")!!.str("id")
    m.catalogue("""{"version":1,"folders":[{"id":"fMaths","name":"Maths","parent":null}],"boardFolders":{"$id":"fMaths"}}""")
    m.settle()
    val gaz = File(picked, "GazBoard")
    val copied = File(gaz, "$id.json")
    assertTrue("the board should be in ${gaz.path}: there are ${gaz.list()?.toList()}; state ${m.state()}", copied.exists())
    assertTrue("its contents: ${copied.readText()}", copied.readText().contains("Copied board"))
    assertTrue("the picture should be in GazBoard/assets: ${File(gaz, "assets").list()?.toList()}", File(gaz, "assets/$pic").exists())
    assertEquals("the folder's own files stay as they were: ${picked.list()?.toList()}",
      """{"name":"someone else's"}""", File(picked, "package.json").readText())
    assertEquals("Settings shows where: $chosen", "${picked.name}/GazBoard", chosen.str("folder"))
    val folders = File(gaz, "folders.json")
    assertTrue("the My boards folders are kept beside the boards: ${gaz.list()?.toList()}", folders.exists() && folders.readText().contains("Maths"))

    storage.remove(id)
    m.settle()
    assertFalse("a deleted board leaves the copy too: ${gaz.list()?.toList()}", copied.exists())
    storage.listener = null
  }

  @Test fun boardsComeBackAfterReinstallingWithoutReplacingAnythingAndBadPicturesAreRefused() {
    val gaz = File(picked, "GazBoard").apply { mkdirs() }
    val storage = BoardStorage(context)
    val missing = "bBack" + System.nanoTime()
    val present = "bHere" + System.nanoTime()
    storage.save(json("id" to present, "json" to board(present, "Already on the phone"), "setLast" to false))
    File(gaz, "$missing.json").writeText(board(missing, "Came back"))
    File(gaz, "$present.json").writeText(board(present, "Older copy in the folder"))
    File(gaz, "notes.json").writeText("""{"title":"not a board"}""")
    File(gaz, "folders.json").writeText("""{"version":1,"folders":[{"id":"fMaths","name":"Maths","parent":null}],"boardFolders":{"$missing":"fMaths"}}""")
    val bytes = android.util.Base64.decode(pixel, 0)
    val good = Protocol.hex(MessageDigest.getInstance("SHA-256").digest(bytes)) + ".png"
    val forged = "0".repeat(64) + ".png"
    File(gaz, "assets").mkdirs()
    File(gaz, "assets/$good").writeBytes(bytes)
    File(gaz, "assets/$forged").writeBytes(bytes)
    File(context.filesDir, "assets/$good").delete()

    val back = mirror().restore(Uri.fromFile(picked), storage)

    assertEquals("restore answered $back", true, back.bool("ok"))
    assertEquals("one board was missing and came back: $back", 1, back.num("boards").toInt())
    assertEquals("the board already on the phone was left as it is: $back", 1, back.num("alreadyHere").toInt())
    assertEquals("Came back", storage.load(missing)?.str("name"))
    assertEquals("nothing on the phone is replaced", "Already on the phone", storage.load(present)?.str("name"))
    assertTrue("the picture came back", storage.hasAsset(good))
    assertFalse("a picture whose bytes do not match its name is refused", storage.hasAsset(forged))
    assertFalse("notes.json is not a board and is not taken", storage.has("notes"))
    assertFalse("nor is the folders file", storage.has("folders"))
    val folders = back["catalogue"] as? JsonObject
    assertEquals("the folders they were filed in come back to the page: $back", "Maths",
      (folders?.get("folders") as? JsonArray)?.firstOrNull()?.obj()?.str("name"))
    storage.remove(missing); storage.remove(present)
  }

  @Test fun joiningAFolderAfterBringingBoardsBackWritesNothingOverItsCopies() {
    val gaz = File(picked, "GazBoard").apply { mkdirs() }
    val storage = BoardStorage(context)
    val both = "bBoth" + System.nanoTime()
    storage.save(json("id" to both, "json" to board(both, "Phone copy"), "setLast" to false))
    File(gaz, "$both.json").writeText(board(both, "Folder copy"))
    val m = mirror()
    m.use(Uri.fromFile(picked), joining = true)
    m.settle()
    assertTrue("the folder's own copy stays as it was: ${File(gaz, "$both.json").readText()}", File(gaz, "$both.json").readText().contains("Folder copy"))
    storage.remove(both)
  }

  @Test fun aFolderWithoutGazBoardBoardsSaysSo() {
    val back = mirror().restore(Uri.fromFile(picked), BoardStorage(context))
    assertEquals("restore answered $back", false, back.bool("ok"))
    assertTrue("and says why: $back", back.str("error").contains("GazBoard folder"))
  }
}
