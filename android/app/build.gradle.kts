import groovy.json.JsonSlurper

plugins {
  id("com.android.application")
  kotlin("android")
}
val product = JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>
val productVersion = product["version"].toString()

/*
 * The Android build number, and the key that signs a release.
 *
 * The board code's own version comes from package.json and is shared with the
 * desktop app. An Android-only release does not move that number - it is the
 * same board, packaged again - so the Android build number is separate and
 * rides alongside it: 2.6.5 build 1 is "2.6.5-android.1".
 *
 * Both come from the environment when the release workflow sets them, and fall
 * back to sensible values so a plain `assembleRelease` on a laptop still works.
 */
val androidBuild = (System.getenv("ANDROID_BUILD_NUMBER") ?: "1").toInt()
val androidVersionName = System.getenv("ANDROID_VERSION_NAME") ?: "$productVersion-android.$androidBuild"
val androidVersionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: run {
  // 2.6.5 build 1 -> 2 06 05 01. Two digits each, so it only ever increases.
  val parts = productVersion.split(".").map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
  val major = parts.getOrElse(0) { 0 }
  val minor = parts.getOrElse(1) { 0 }
  val patch = parts.getOrElse(2) { 0 }
  ((major * 100 + minor) * 100 + patch) * 100 + androidBuild
}

/*
 * Signing.
 *
 * The keystore is a private key and never lives in this repository. CI writes it
 * to a file from an encrypted secret and points ANDROID_KEYSTORE_PATH at it; on
 * a laptop you can set the same variables, or gazboard.keystore in
 * ~/.gradle/gradle.properties, to build a signed APK by hand.
 *
 * When nothing is configured the release build is simply left unsigned rather
 * than failing. That keeps `assembleRelease` working in ordinary CI, where it
 * exists to prove the code compiles and shrinks - and the release workflow
 * refuses to publish anything still carrying "unsigned" in its name.
 */
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
  ?: project.findProperty("gazboard.keystore") as String?
val keystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
  ?: project.findProperty("gazboard.keystorePassword") as String?
val releaseKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")
  ?: project.findProperty("gazboard.keyAlias") as String?
val releaseKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD") ?: keystorePassword
val signingReady = keystorePath != null && file(keystorePath).exists() &&
  keystorePassword != null && releaseKeyAlias != null

android {
  namespace = "com.gazboard.app"
  compileSdk = 36
  defaultConfig {
    applicationId = "com.gazboard.app"
    minSdk = 26
    targetSdk = 36
    versionCode = androidVersionCode
    versionName = androidVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  buildFeatures { buildConfig = true }
  signingConfigs {
    if (signingReady) {
      create("release") {
        storeFile = file(keystorePath!!)
        storePassword = keystorePassword
        keyAlias = releaseKeyAlias
        keyPassword = releaseKeyPassword
        // Both signature schemes: v1 for Android 6 and older, v2 for the rest.
        enableV1Signing = true
        enableV2Signing = true
      }
    }
  }
  buildTypes {
    release {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.findByName("release")
    }
  }
  /*
   * A filename somebody can recognise in a Downloads folder.
   *
   * "app-release.apk" tells a person nothing, and every Android app on earth
   * produces one. GazBoard-2.6.5-android-v1.apk says which board code it was
   * built from and which Android build of that code this is.
   */
  applicationVariants.all {
    val variant = this
    outputs.all {
      /*
       * An unsigned build keeps "unsigned" in its name.
       *
       * Gradle's own naming does this and it matters: an unsigned APK installs
       * nowhere and tells the person only "there was a problem parsing the
       * package". Renaming it to look like a finished release would hide that
       * until it was in somebody's hands. So the name follows the signature,
       * and the release workflow refuses to publish a file that admits it.
       */
      val signed = variant.signingConfig != null
      val suffix = when {
        variant.buildType.name != "release" -> "-" + variant.buildType.name
        !signed -> "-unsigned"
        else -> ""
      }
      (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
        "GazBoard-$productVersion-android-v$androidBuild$suffix.apk"
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/boardAssets"))
  packaging { resources.excludes += setOf("META-INF/versions/**", "META-INF/*.kotlin_module") }
}
kotlin { jvmToolchain(17) }

// One editor, one set of fonts and importers. Nothing is fetched at app launch.
val boardAssets by tasks.registering(Sync::class) {
  from(rootProject.file("../src")) {
    exclude("sw.js", "manifest.webmanifest", "**/.DS_Store")
    filesMatching(listOf("**/*.html", "**/*.js", "**/*.css")) {
      filter { line: String -> line.replace("app://board/", "https://appassets.androidplatform.net/assets/board/") }
    }
  }
  into(layout.buildDirectory.dir("generated/boardAssets/board"))
}
tasks.named("preBuild") { dependsOn(boardAssets) }

dependencies {
  implementation(project(":sync"))
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
  implementation("androidx.activity:activity-ktx:1.10.1")
  implementation("androidx.core:core-ktx:1.16.0")
  implementation("androidx.webkit:webkit:1.14.0")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test:rules:1.6.1")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
