import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  appVariant === "development"
    ? require("../../assets/brand-mark-dev.png")
    : appVariant === "preview"
      ? require("../../assets/brand-mark-nightly.png")
      : require("../../assets/brand-mark-prod.png");
