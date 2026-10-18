const { withMainApplication } = require("expo/config-plugins");

// Fabric's ShadowTree::commit livelocks on long streaming threads and aborts after 1024
// attempts. preventShadowTreeCommitExhaustion makes the JS commit take the revision lock instead.
// loadReactNative already called override (once only), so force it on the release provider.
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
