import groovy.json.JsonSlurper

plugins {
  id("com.android.application")
  kotlin("android")
}
val product = JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>
val productVersion = product["version"].toString()

android {
  namespace = "com.gazboard.app"
  compileSdk = 36
  defaultConfig {
    applicationId = "com.gazboard.app"
    minSdk = 26
    targetSdk = 36
    versionCode = 2060501
    versionName = "$productVersion-android.1"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  buildFeatures { buildConfig = true }
  buildTypes {
    release {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
