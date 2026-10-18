const { withMainApplication } = require("expo/config-plugins");

// Long threads scrolled during a streaming turn livelock Fabric's ShadowTree::commit
// (Reanimated and scroll-state commits keep winning the race) until it asserts after
// 1024 attempts and aborts the app. preventShadowTreeCommitExhaustion makes the JS commit
// take the revision lock after a few failed attempts instead. loadReactNative has already
// called ReactNativeFeatureFlags.override, which may only run once, so this force-overrides
// on top of the same release-level provider before the React host reads any flag.
const ANCHOR = "loadReactNative(this)";

const OVERRIDE = `
    ReactNativeFeatureFlags.dangerouslyForceOverride(
      object : ReactNativeFeatureFlagsProvider by when (DefaultNewArchitectureEntryPoint.releaseLevel) {
        ReleaseLevel.EXPERIMENTAL -> ReactNativeFeatureFlagsOverrides_RNOSS_Experimental_Android()
        ReleaseLevel.CANARY -> ReactNativeFeatureFlagsOverrides_RNOSS_Canary_Android()
        ReleaseLevel.STABLE -> ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android()
      } {
        override fun preventShadowTreeCommitExhaustion(): Boolean = true
      }
    )`;

const IMPORTS = [
  "com.facebook.react.internal.featureflags.ReactNativeFeatureFlags",
  "com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Canary_Android",
  "com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Experimental_Android",
  "com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android",
  "com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsProvider",
];

module.exports = function withAndroidCommitExhaustionGuard(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidCommitExhaustionGuard: expected a Kotlin MainApplication.");
    }

    let contents = nextConfig.modResults.contents;
    if (contents.includes("preventShadowTreeCommitExhaustion")) {
      return nextConfig;
    }

    const index = contents.indexOf(ANCHOR);
    if (index === -1) {
      throw new Error(
        "withAndroidCommitExhaustionGuard: could not find loadReactNative(this) in MainApplication — the Expo template changed; update the plugin anchor.",
      );
    }
    const end = index + ANCHOR.length;
    contents = contents.slice(0, end) + OVERRIDE + contents.slice(end);

    const missingImports = IMPORTS.filter((name) => !contents.includes(`import ${name}\n`));
    contents = contents.replace(
      /^(package [^\n]+\n)/,
      `$1${missingImports.map((name) => `import ${name}\n`).join("")}`,
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
