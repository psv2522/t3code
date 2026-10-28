# Local Nightly Android APK

`scripts/build-android-apk.py` is a standalone Python 3.12+ builder for native
macOS and Linux. Install git, a JDK compatible with the selected revision (17+
for the tested revision), and Android SDK command-line tools first. Set
`ANDROID_HOME` and `JAVA_HOME`, or pass `--sdk` and `--java-home`. Accept the SDK
licenses with `sdkmanager --licenses`. Allow at least 16 GiB total memory and
sufficient free disk space for dependencies and native outputs. The builder uses
two Gradle workers, a 3 GiB heap, and in-process Kotlin. It does not depend on a
custom memory-cap helper and does not enable WSL.

Build the current custom branch's committed source in a separate persistent
checkout:

```sh
python3 scripts/build-android-apk.py \
  --source "$PWD" --ref p2code/custom \
  --checkout "${PWD}-android-build" \
  --confirm-arm64 'realme P3 Ultra 5G; Dimensity 8350 ARM64' \
  --output "$HOME/Downloads"
```

With no `--source` or `--ref`, it selects the latest upstream versioned nightly
tag. `--tag v…-nightly.…` selects one explicitly. It fetches that tag alone,
avoiding the moving `android-nightly` tag. `--abi` accepts React Native's
comma-separated ABI names; ARM64-only builds require `--confirm-arm64` evidence.
Neither mode incorporates uncommitted source changes. A dirty build checkout
stops the script; it never stashes or resets unrelated work.

Use `--output "$HOME/Downloads"` to deliver only the APK there. Receipts stay in
`<state-dir>/receipts`, and v4 signing is disabled to avoid `.idsig` sidecars.
The default persistent state is `~/.cache/t3-android`. It contains pinned
Node/pnpm downloads, a Gradle user cache, a private signing identity, and APKs.
Keep the signing directory and its protected password file backed up securely.
The script generates your key on first use and verifies the same certificate on
subsequent builds. This certificate differs from the official signing key:
you cannot update an official installation in place with it. The script never
uninstalls apps, clears phone data, or installs the APK.

Missing public Connect identifiers are copied from that revision's `.env.example`
into the build checkout's `.env`, preserving existing assignments. Existing
`.env.local` and environment overrides still apply; disabled or inconsistent
sign-in configuration fails validation. No private EAS credentials are needed.

Each revision gets a frozen, filtered workspace install with its exact pinned
pnpm. Native inputs, environment, and tool changes trigger clean Expo generation
while preserving only `android/.gradle` and `android/app/.cxx`. Generated build
outputs are discarded on regeneration. Unchanged native inputs skip prebuild.
Each invocation gets a separate disk-backed Metro temp directory, removed on
exit. Gradle build caching stays enabled; configuration caching stays disabled.
`--no-daemon` prevents a persistent Gradle JVM; it is not a compilation speed claim.

The generated preview app uses `com.t3tools.t3code.preview`. Validation checks
its signing certificate, launchable activity, ABIs, embedded preview and Connect
configuration, 16 KiB ZIP alignment, and deflated Hermes bundle/native libraries.
A `.receipt.json` in `<state-dir>/receipts` records provenance, versions, checks, size, hash,
cache state, and measured duration. A successful APK build does not verify phone
installation or launch. Compressed native libraries are extracted at install
time, so download savings do not imply equal installed-storage savings.

Rerun the same command to reuse caches. Do not routinely clean or rerun every
Gradle task. Compare equivalent builds before making speed claims.
