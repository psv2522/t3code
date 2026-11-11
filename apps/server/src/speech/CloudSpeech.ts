import {
  CloudSpeechApiKey,
  CloudSpeechError,
  CloudSpeechModel,
  CloudSpeechModelId,
  SettingsSecretValue,
  isSecretReference,
  type SecretReference,
  type ServerSettingsError,
  type CloudSpeechKeyProvider,
  type CloudSpeechKeys,
  type CloudSpeechProvider,
  EnvironmentSpeechTranscriptionResult,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import { decodeSpeechPcm, SpeechInvalidAudioError } from "./SpeechService.ts";

const endpoints = {
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", model: "gpt-transcribe" },
  xai: { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0" },
  openrouter: { url: "https://openrouter.ai/api/v1/audio/transcriptions" },
};
const OPENROUTER_CATALOG_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true";
const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
const sameCredential = Schema.toEquivalence(SettingsSecretValue);
const OpenRouterCatalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
});

function wave(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, value: string) =>
    new Uint8Array(buffer, at, 4).set(new TextEncoder().encode(value));
  tag(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

function customBody(audio: ArrayBuffer, language: string, options: SpeechTranscriptionOptions) {
  const form = new FormData();
  form.set("model", "default");
  form.set("response_format", "json");
  if (language !== "auto") form.set("language", language);
  const prompt = options.speechCustomWords.map(({ term }) => term).join(", ");
  if (prompt) form.set("prompt", prompt);
  form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.bodyFormData(form);
}

export function customTranscriptionUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/audio/transcriptions")) url.pathname += "/audio/transcriptions";
    return url.toString();
  } catch {
    return null;
  }
}

function audioBody(
  provider: "openai" | "xai",
  audio: ArrayBuffer,
  language: string,
  options: SpeechTranscriptionOptions,
) {
  const form = new FormData();
  form.set("model", endpoints[provider].model);
  if (language !== "auto") form.set(provider === "openai" ? "languages[]" : "language", language);
  for (const { term } of options.speechCustomWords) {
    if (provider === "openai" && /[<>\r\n]/.test(term)) continue;
    form.append(provider === "openai" ? "keywords[]" : "keyterm", term);
  }
  if (provider === "xai") {
    if (language !== "auto") form.set("format", "true");
    form.set(
      "filler_words",
      String(!options.speechRemoveFillerWords || Boolean(options.speechCorrectionWord)),
    );
    if (!options.speechSilenceFiltering) form.set("vad_threshold", "0");
  }
  // xAI ignores options that follow the file part.
  form.set("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.bodyFormData(form);
}

function openRouterBody(model: string, audio: ArrayBuffer, language: string) {
  return HttpClientRequest.bodyJsonUnsafe({
    model,
    input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
    ...(language !== "auto" ? { language } : {}),
    provider: { zdr: true },
  });
}

export class CloudSpeech extends Context.Service<
  CloudSpeech,
  {
    readonly configured: Effect.Effect<CloudSpeechKeys, ServerSettingsError>;
    /** OpenRouter's public transcription catalog, cached briefly on this server. */
    readonly models: Effect.Effect<ReadonlyArray<CloudSpeechModel>, CloudSpeechError>;
    readonly setKey: (
      provider: CloudSpeechKeyProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, ServerSettingsError>;
    readonly setCustomUrl: (url: string | null) => Effect.Effect<void, ServerSettingsError>;
    readonly transcribe: (
      provider: CloudSpeechProvider,
      pcm: Uint8Array,
      options: SpeechTranscriptionOptions,
      model?: string | undefined,
    ) => Effect.Effect<string, CloudSpeechError | SpeechInvalidAudioError | ServerSettingsError>;
  }
>()("t3/speech/CloudSpeech") {}

export const layer = Layer.effect(
  CloudSpeech,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const http = yield* HttpClient.HttpClient;
    const credentials = settings.getSettings.pipe(
      Effect.map((value) => value.cloudSpeechCredentials),
    );
    const customUrl = settings.getSettings.pipe(Effect.map((value) => value.cloudSpeechCustomUrl));
    const configured = Effect.all([credentials, customUrl]).pipe(
      Effect.map(([{ openai, xai, openrouter }, custom]) => ({
        openai: Boolean(openai),
        xai: Boolean(xai),
        openrouter: Boolean(openrouter),
        custom: Boolean(custom),
      })),
    );
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
    const fetchCatalog = Effect.fn("CloudSpeech.catalog")(function* () {
      const unavailable = () =>
        new CloudSpeechError({ provider: "openrouter", reason: "unavailable" });
      const response = yield* execute(HttpClientRequest.get(OPENROUTER_CATALOG_URL)).pipe(
        Effect.mapError(unavailable),
      );
      if (response.status < 200 || response.status >= 300) return yield* unavailable();
      const { data } = yield* HttpClientResponse.schemaBodyJson(OpenRouterCatalog)(response).pipe(
        Effect.mapError(unavailable),
      );
      return data.flatMap(({ id, name }) =>
        isModelId(id) ? [{ id, name: name?.trim() || id }] : [],
      );
    });
    // The catalog is public, so the cache holds no credential or consent state.
    const models = yield* Effect.cachedWithTTL(
      fetchCatalog().pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(new CloudSpeechError({ provider: "openrouter", reason: "unavailable" })),
        }),
      ),
      (exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
    );
    const setCustomUrl = Effect.fn("CloudSpeech.setCustomUrl")(function* (url: string | null) {
      yield* settings.updateSettings({ cloudSpeechCustomUrl: url ?? "" });
    });
    const setKey = Effect.fn("CloudSpeech.setKey")(function* (
      provider: CloudSpeechKeyProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) {
      yield* settings.updateSettings({
        cloudSpeechCredentials: {
          [provider]: Redacted.isRedacted(key) ? Redacted.value(key) : (key ?? ""),
        },
      });
    });
    const transcribeCustom = Effect.fnUntraced(function* (
      pcm: Uint8Array,
      options: SpeechTranscriptionOptions,
    ) {
      const configuredUrl = yield* customUrl;
      const target = configuredUrl ? customTranscriptionUrl(configuredUrl) : null;
      if (!target)
        return yield* new CloudSpeechError({ provider: "custom", reason: "missing-key" });
      const samples = yield* Effect.try({
        try: () => decodeSpeechPcm(pcm),
        catch: () =>
          new SpeechInvalidAudioError({
            byteLength: pcm.byteLength,
            message: "Invalid PCM audio.",
          }),
      });
      const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
      const unavailable = () => new CloudSpeechError({ provider: "custom", reason: "unavailable" });
      const request = HttpClientRequest.post(target).pipe(
        customBody(wave(samples), language, options),
      );
      const current = yield* customUrl;
      if (current !== configuredUrl)
        return yield* new CloudSpeechError({ provider: "custom", reason: "key-changed" });
      const response = yield* execute(request).pipe(Effect.mapError(unavailable));
      if (response.status < 200 || response.status >= 300)
        return yield* new CloudSpeechError({
          provider: "custom",
          reason:
            response.status === 429
              ? "rate-limit"
              : [401, 403].includes(response.status)
                ? "rejected-key"
                : response.status === 404
                  ? "model-unavailable"
                  : "unavailable",
        });
      const { text } = yield* HttpClientResponse.schemaBodyJson(
        EnvironmentSpeechTranscriptionResult,
      )(response).pipe(Effect.mapError(unavailable));
      const corrected = applySpeechAliases(text, options.speechCustomWords);
      return (
        options.speechRemoveFillerWords
          ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
          : corrected
      ).trim();
    });
    const transcribe = Effect.fn("CloudSpeech.transcribe")(
      function* (
        provider: CloudSpeechProvider,
        pcm: Uint8Array,
        options: SpeechTranscriptionOptions,
        model?: string,
      ) {
        if (provider === "custom") return yield* transcribeCustom(pcm, options);
        const source = (yield* credentials)[provider];
        if (!source) return yield* new CloudSpeechError({ provider, reason: "missing-key" });
        if (provider === "openrouter" && (!model || !isModelId(model)))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        const samples = yield* Effect.try({
          try: () => decodeSpeechPcm(pcm),
          catch: () =>
            new SpeechInvalidAudioError({
              byteLength: pcm.byteLength,
              message: "Invalid PCM audio.",
            }),
        });
        const language = effectiveSpeechLanguage(cloudSpeechLanguages, options.speechLanguage);
        if (provider === "openrouter" && !(yield* models).some((entry) => entry.id === model))
          return yield* new CloudSpeechError({ provider, reason: "model-unavailable" });
        // A vault that locked since the last recording must not authorize a new upload.
        if (isSecretReference(source)) yield* resolver.invalidate([source]);
        const unreadable = () => new CloudSpeechError({ provider, reason: "unreadable-key" });
        const key = yield* requireSettingsSecret(resolver, source).pipe(
          Effect.mapError(unreadable),
        );
        if (!isApiKey(key)) return yield* unreadable();
        const audio = wave(samples);
        const request = HttpClientRequest.post(endpoints[provider].url).pipe(
          HttpClientRequest.bearerToken(Redacted.make(key)),
          provider === "openrouter"
            ? openRouterBody(model!, audio, language)
            : audioBody(provider, audio, language, options),
        );
        const unavailable = () => new CloudSpeechError({ provider, reason: "unavailable" });
        // A catalog fetch or vault lookup may have outlived the credential it started with.
        const current = (yield* credentials)[provider];
        if (!current || !sameCredential(source, current))
          return yield* new CloudSpeechError({
            provider,
            reason: current ? "key-changed" : "missing-key",
          });
        const response = yield* execute(request).pipe(Effect.mapError(unavailable));
        if (response.status < 200 || response.status >= 300)
          return yield* new CloudSpeechError({
            provider,
            reason:
              response.status === 429
                ? "rate-limit"
                : [401, 402, 403].includes(response.status)
                  ? "rejected-key"
                  : response.status === 404 && provider === "openrouter"
                    ? "model-unavailable"
                    : "unavailable",
          });
        const { text } = yield* HttpClientResponse.schemaBodyJson(
          EnvironmentSpeechTranscriptionResult,
        )(response).pipe(Effect.mapError(unavailable));
        const corrected = applySpeechAliases(text, options.speechCustomWords);
        return (
          options.speechRemoveFillerWords
            ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
            : corrected
        ).trim();
      },
      (effect, provider) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(new CloudSpeechError({ provider, reason: "unavailable" })),
          }),
        ),
    );
    return CloudSpeech.of({ configured, models, setKey, setCustomUrl, transcribe });
  }),
);
