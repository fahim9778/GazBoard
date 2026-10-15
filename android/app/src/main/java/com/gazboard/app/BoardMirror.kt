package com.gazboard.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.util.AtomicFile
import com.gazboard.sync.*
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*

/**
 * A copy of every board, kept in a folder the person picked on this phone.
 *
 * GazBoard works from its own private storage, which is fast and always there -
 * but Android deletes it with the app. Uninstall to reinstall, or to move to a
 * new build, and every board went with it. So, once a folder has been chosen,
 * each board that is saved is also written there (a moment later, so a burst of
 * autosaves becomes one write), each picture once, and a deleted board is
 * removed from there too. The folder is the person's own: it stays when the app
 * goes, and after installing again "Bring boards back" reads it.
 *
 * Everything lives in a GazBoard folder inside the one picked, the same rule the
 * desktop follows, so a Documents folder full of other things is never touched:
 * nothing outside GazBoard is read, written or removed. Nothing is ever
 * overwritten on the way back in either - a board that is already on the phone
 * stays as it is.
 *
 * The private copy is always the one that counts. A copy that fails (the card
 * was taken out, the permission was withdrawn) is reported in Settings and the
 * board itself is never affected.
 */
class BoardMirror(
  private val context: Context,
  prefsName: String = "backup-folder",
  private val open: (Uri) -> Folder = { SafFolder.root(context, it) }
) : BoardStorage.Listener {
  /** One folder in the place the copy is kept. Android's document folders in the app, plain files in the tests. */
  interface Folder {
    val name: String
    fun list(): Map<String, Boolean>                 // name -> is it a folder
    fun sub(name: String, create: Boolean): Folder?
    fun read(name: String): ByteArray
    fun write(name: String, mime: String, bytes: ByteArray)
    fun delete(name: String)
  }

  private val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
  private val worker = Executors.newSingleThreadScheduledExecutor()
  private val boardsDir = File(context.filesDir, "boards")
  private val assetsDir = File(context.filesDir, "assets")
  private val idPattern = Regex("[A-Za-z0-9_-]{1,128}")
  private val CATALOGUE = "folders.json"
  private val assetPattern = Regex("[a-f0-9]{64}\\.[a-z0-9]{1,8}")

  // boards waiting to be copied: id -> its bytes, or null when it was deleted
  private val pending = LinkedHashMap<String, ByteArray?>()
  private var flushQueued = false
  @Volatile private var lastError: String? = null
  @Volatile private var lastCopied = 0L
  @Volatile private var copying = false
  @Volatile private var progressDone = 0
  @Volatile private var progressTotal = 0

  val tree: Uri? get() = prefs.getString("tree", null)?.let(Uri::parse)

  fun state(): JsonObject {
    val t = tree
    // Android can take a folder's permission away (the folder was deleted, the card removed, the
    // app's access reset). Then say so, rather than quietly copying nowhere.
    val held = t == null || t.scheme != "content" || context.contentResolver.persistedUriPermissions.any { it.uri == t && it.isWritePermission }
    return json(
      "folder" to t?.let { runCatching { label(open(it)) }.getOrNull() ?: "GazBoard" },
      "copying" to copying, "done" to progressDone, "total" to progressTotal,
      "lastCopied" to lastCopied,
      "error" to (if (!held) "GazBoard may no longer use that folder. Choose it again in Settings." else lastError))
  }

  /**
   * Start keeping the copy in this folder, and bring it up to date in the background.
   * `joining`: the folder already holds a copy (boards were just brought back from it) -
   * the boards there are left as they are, and only boards it does not have are added.
   */
  fun use(newTree: Uri, joining: Boolean = false): JsonObject {
    val root = open(newTree)
    val dir = gazFolder(root, create = true) ?: error("GazBoard could not make its folder there. Choose another folder.")
    val old = tree
    prefs.edit().putString("tree", newTree.toString()).commit()
    if (old != null && old != newTree) release(old)
    lastError = null
    copying = true
    worker.execute { copyEverything(dir, keepTheirs = joining) }
    return json("ok" to true, "folder" to label(root))
  }

  /** A folder picked and then not used: its permission is handed back (Android keeps only so many). */
  fun forget(picked: Uri) { if (picked != tree) release(picked) }

  /** Stop copying. The folder and everything in it are left exactly as they are. */
  fun stop(): Boolean {
    tree?.let { release(it) }
    prefs.edit().remove("tree").commit()
    synchronized(pending) { pending.clear() }
    lastError = null
    return true
  }

  override fun boardSaved(id: String, bytes: ByteArray) = queue(id, bytes)
  override fun boardRemoved(id: String) = queue(id, null)

  override fun assetStored(name: String, bytes: ByteArray) {
    if (tree == null) return
    worker.execute {
      val dir = folderOrNull() ?: return@execute
      attempt {
        val assets = dir.sub("assets", create = true) ?: error("Could not make the pictures folder")
        if (!assets.list().containsKey(name)) assets.write(name, mimeFor(name), bytes)
      }
    }
  }

  /*
   * The My boards folders, as the page sends them (catalogueOf in folders.js).
   * Kept here as well, so a folder chosen later starts with them, and written
   * into the GazBoard folder as folders.json - which "Bring boards back" reads.
   */
  @Volatile private var catalogue: ByteArray? = null
  private var catalogueQueued = false
  fun catalogue(text: String): Boolean {
    if (text.length > 4 * 1024 * 1024) return false
    val parsed = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return false
    if (parsed["folders"] !is JsonArray) return false
    catalogue = text.toByteArray()
    if (tree == null) return true
    synchronized(pending) { if (catalogueQueued) return true; catalogueQueued = true }
    worker.schedule({
      synchronized(pending) { catalogueQueued = false }
      val bytes = catalogue ?: return@schedule
      val dir = folderOrNull() ?: return@schedule
      attempt { dir.write(CATALOGUE, "application/json", bytes) }
    }, 800, TimeUnit.MILLISECONDS)
    return true
  }

  /** Write out what is waiting now - the app is going to the background, and may not come back. */
  fun flushSoon() { if (tree != null) worker.execute { flush() } }

  /** For the tests: wait until everything queued so far has been written. */
  fun settle(timeoutMs: Long = 10000) {
    flushSoon()
    // after anything already scheduled to run within the next second (the folders file waits 800 ms)
    worker.schedule<Unit>({ }, 1000, TimeUnit.MILLISECONDS).get(timeoutMs, TimeUnit.MILLISECONDS)
  }

  private fun queue(id: String, bytes: ByteArray?) {
    if (tree == null || !idPattern.matches(id)) return
    synchronized(pending) {
      pending[id] = bytes
      if (flushQueued) return
      flushQueued = true
    }
    worker.schedule({ flush() }, 1500, TimeUnit.MILLISECONDS)
  }

  private fun flush() {
    val batch = synchronized(pending) { flushQueued = false; LinkedHashMap(pending).also { pending.clear() } }
    if (batch.isEmpty()) return
    val dir = folderOrNull() ?: return
    attempt {
      val known = dir.list()
      for ((id, bytes) in batch) {
        val name = "$id.json"
        if (bytes != null) dir.write(name, "application/json", bytes)
        else if (known[name] == false) dir.delete(name)
      }
      lastCopied = System.currentTimeMillis()
    }
  }

  private fun copyEverything(dir: Folder, keepTheirs: Boolean = false) {
    val boards = boardsDir.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(".json") && idPattern.matches(it.name.removeSuffix(".json")) }
    val pictures = assetsDir.listFiles().orEmpty().filter { it.isFile && assetPattern.matches(it.name) }
    copying = true; progressDone = 0; progressTotal = boards.size + pictures.size
    try {
      attempt {
        val there = if (keepTheirs) dir.list() else emptyMap()
        for (f in boards) {
          if (there[f.name] == false) { progressDone++; continue }       // the folder's own copy stays as it is
          dir.write(f.name, "application/json", AtomicFile(f).readFully()); progressDone++
        }
        catalogue?.let { dir.write(CATALOGUE, "application/json", it) }
        val assets = dir.sub("assets", create = true) ?: error("Could not make the pictures folder")
        val have = assets.list()
        for (f in pictures) { if (!have.containsKey(f.name)) assets.write(f.name, mimeFor(f.name), f.readBytes()); progressDone++ }
        lastCopied = System.currentTimeMillis()
      }
    } finally { copying = false }
  }

  /**
   * Bring boards back from a folder: every board in its GazBoard folder that is
   * not already on this phone, and the pictures they need. Returns what came
   * back. Nothing on the phone is replaced.
   */
  fun restore(from: Uri, storage: BoardStorage): JsonObject {
    val dir = gazFolder(open(from), create = false)
      ?: return json("ok" to false, "error" to "There is no GazBoard folder there. Choose the folder you picked for the copy, or the GazBoard folder inside it.")
    var boards = 0; var kept = 0; var pictures = 0
    val entries = dir.list()
    for ((name, isDir) in entries) {
      if (isDir || !name.endsWith(".json")) continue
      val id = name.removeSuffix(".json")
      if (!idPattern.matches(id)) continue
      val text = runCatching { dir.read(name).toString(Charsets.UTF_8) }.getOrNull() ?: continue
      val board = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: continue
      // a board, and the one this file is named for; anything else in there is not ours to take
      if (board["objects"] == null || (board["id"] as? JsonPrimitive)?.contentOrNull != id) continue
      if (storage.has(id)) { kept++; continue }
      runCatching { storage.save(json("id" to id, "json" to text, "setLast" to false)) }.onSuccess { boards++ }
    }
    if (entries["assets"] == true) dir.sub("assets", create = false)?.let { assets ->
      for ((name, isDir) in assets.list()) {
        if (isDir || !assetPattern.matches(name) || storage.hasAsset(name)) continue
        val bytes = runCatching { assets.read(name) }.getOrNull() ?: continue
        if (storage.importAsset(name, bytes)) pictures++
      }
    }
    // the folders they were filed in: handed to the page, which adds them to its own (never replacing them)
    val folders = if (entries[CATALOGUE] == false) runCatching {
      Json.parseToJsonElement(dir.read(CATALOGUE).toString(Charsets.UTF_8)) as? JsonObject
    }.getOrNull()?.takeIf { it["folders"] is JsonArray } else null
    return json("ok" to true, "boards" to boards, "alreadyHere" to kept, "pictures" to pictures, "catalogue" to folders)
  }

  private fun folderOrNull(): Folder? {
    val t = tree ?: return null
    return try { gazFolder(open(t), create = true) ?: error("The GazBoard folder could not be made") }
      catch (e: Exception) { lastError = message(e); null }
  }

  private inline fun attempt(block: () -> Unit) {
    try { block(); lastError = null } catch (e: Exception) { lastError = message(e) }
  }

  private fun message(e: Exception) = when (e) {
    is SecurityException -> "GazBoard may no longer use that folder. Choose it again in Settings."
    else -> e.message ?: "The copy could not be written"
  }

  /** The GazBoard folder in the one picked - or the picked one itself, if that is already it. */
  private fun gazFolder(root: Folder, create: Boolean): Folder? =
    if (root.name.equals("GazBoard", ignoreCase = true)) root else root.sub("GazBoard", create)

  private fun label(root: Folder) = if (root.name.equals("GazBoard", ignoreCase = true)) root.name else "${root.name}/GazBoard"

  private fun release(t: Uri) {
    if (t.scheme != "content") return
    runCatching { context.contentResolver.releasePersistableUriPermission(t, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
  }

  private fun mimeFor(name: String) = when (name.substringAfterLast('.')) {
    "png" -> "image/png"; "jpg" -> "image/jpeg"; "webp" -> "image/webp"; "gif" -> "image/gif"
    "svg" -> "image/svg+xml"; "bmp" -> "image/bmp"; "avif" -> "image/avif"
    else -> "application/octet-stream"
  }
}

/** A folder reached through Android's document picker: the only kind the app itself uses. */
class SafFolder private constructor(private val context: Context, private val tree: Uri, private val id: String) : BoardMirror.Folder {
  companion object {
    fun root(context: Context, tree: Uri): BoardMirror.Folder {
      require(tree.scheme == "content") { "Choose the folder with Android's folder picker" }
      return SafFolder(context, tree, DocumentsContract.getTreeDocumentId(tree))
    }
  }
  private val resolver get() = context.contentResolver
  private val uri: Uri get() = DocumentsContract.buildDocumentUriUsingTree(tree, id)
  private fun docUri(docId: String) = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
  private data class Entry(val id: String, val dir: Boolean)

  override val name: String get() =
    resolver.query(uri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "Folder"

  // the folder's list, read once per use of this object and kept up to date as files are made in it
  private var cache: HashMap<String, Entry>? = null
  private fun entries(): Map<String, Entry> {
    cache?.let { return it }
    val out = HashMap<String, Entry>()
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
    resolver.query(children, arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
      while (c.moveToNext()) out[c.getString(1) ?: continue] = Entry(c.getString(0), c.getString(2) == Document.MIME_TYPE_DIR)
    }
    cache = out
    return out
  }
  override fun list(): Map<String, Boolean> = entries().mapValues { it.value.dir }
  override fun sub(name: String, create: Boolean): BoardMirror.Folder? {
    entries()[name]?.let { return if (it.dir) SafFolder(context, tree, it.id) else null }
    if (!create) return null
    val made = DocumentsContract.createDocument(resolver, uri, Document.MIME_TYPE_DIR, name) ?: return null
    val id = DocumentsContract.getDocumentId(made)
    cache?.put(name, Entry(id, true))
    return SafFolder(context, tree, id)
  }
  override fun read(name: String): ByteArray {
    val e = entries()[name]?.takeIf { !it.dir } ?: error("$name is not there")
    return resolver.openInputStream(docUri(e.id))?.use { it.readBytes() } ?: error("Could not read $name")
  }
  override fun write(name: String, mime: String, bytes: ByteArray) {
    val target = entries()[name]?.takeIf { !it.dir }?.let { docUri(it.id) }
      ?: (DocumentsContract.createDocument(resolver, uri, mime, name) ?: error("Could not create $name")).also { made ->
        // the provider may have had to change the name (a clash it could see and this list could not): read the list afresh next time
        if (DocumentsContract.getDocumentId(made).endsWith(name)) cache?.put(name, Entry(DocumentsContract.getDocumentId(made), false)) else cache = null
      }
    // "wt" empties the file first; a plain "w" on some phones leaves the end of a longer old copy behind
    val out = runCatching { resolver.openOutputStream(target, "wt") }.getOrNull() ?: resolver.openOutputStream(target, "w")
    (out ?: error("Could not write $name")).use { it.write(bytes) }
  }
  override fun delete(name: String) {
    val e = entries()[name]?.takeIf { !it.dir } ?: return
    DocumentsContract.deleteDocument(resolver, docUri(e.id))
    cache?.remove(name)
  }
}
