module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        "babel-preset-expo",
        { unstable_transformImportMeta: true, worklets: false, reanimated: false },
      ],
    ],
    plugins: [
      [
        "react-native-worklets/plugin",
        {
          bundleMode: true,
          strictGlobal: true,
          importForwarding: { relativePaths: ["src/features/review/shikiWorker.native.ts"] },
        },
      ],
    ],
  };
};
