plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
  implementation("org.bouncycastle:bcprov-jdk18on:1.84")
  testImplementation(kotlin("test-junit5"))
  testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.11.4")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
}
tasks.test {
  useJUnitPlatform()
  workingDir(rootProject.projectDir.parentFile)
  testLogging { events("passed", "skipped", "failed") }
}
