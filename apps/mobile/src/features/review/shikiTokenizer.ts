import {
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
  type RegexEngine,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import type { Spec } from "react-native-shiki-engine";

import {
  resolveReviewHighlighterEngine,
  resolveReviewHighlighterEnginePreference,
} from "./reviewHighlighterEngine";
import type { ReviewHighlightedToken } from "./reviewHighlightedToken.types";

export type HighlightTheme =
  | "github-light-default"
  | "github-dark-default"
  | "t3-pierre-light"
  | "t3-pierre-dark";

export interface TokenizeRequest {
  readonly code: string;
  readonly path: string;
  readonly languageHint: string | null;
  readonly theme: HighlightTheme;
}

export type NativeRegexEngineFunctions = Pick<
  Spec,
  "createScanner" | "findNextMatchSync" | "destroyScanner"
>;

const ENGINE_PREFERENCE = resolveReviewHighlighterEnginePreference(
  process.env.EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE ??
    (process.env.NODE_ENV === "test" ? "javascript" : "native"),
);
const TOKENIZE_BATCH_CHARACTERS = 8_000;
const TOKENIZE_MAX_LINE_LENGTH = 1_000;
const NATIVE_SCANNER_CACHE_SIZE = 1_000;

const PIERRE_LIGHT_THEME = {
  name: "t3-pierre-light",
  type: "light" as const,
  fg: "#070707",
  bg: "#ffffff",
  settings: [
    { settings: { foreground: "#070707", background: "#ffffff" } },
    { scope: "comment, punctuation.definition.comment", settings: { foreground: "#84848A" } },
    {
      scope: "keyword, storage, storage.type, keyword.operator.expression",
      settings: { foreground: "#FC2B73" },
    },
    {
      scope: "entity.name.function, support.function, meta.function-call",
      settings: { foreground: "#7B43F8" },
    },
    {
      scope: "entity.name.type, support.type, support.class",
      settings: { foreground: "#C635E4" },
    },
    {
      scope: "string, constant.character, punctuation.definition.string",
      settings: { foreground: "#199F43" },
    },
    {
      scope: "constant.numeric, constant.language, constant.other",
      settings: { foreground: "#1CA1C7" },
    },
    {
      scope: "variable.parameter, variable.other.readwrite, meta.object-literal.key",
      settings: { foreground: "#D47628" },
    },
    {
      scope: "entity.name.tag, support.class.component",
      settings: { foreground: "#199F43" },
    },
    {
      scope: "punctuation, meta.brace, meta.delimiter",
      settings: { foreground: "#79797F" },
    },
    { scope: "invalid", settings: { foreground: "#D52C36" } },
  ],
};

const PIERRE_DARK_THEME = {
  name: "t3-pierre-dark",
  type: "dark" as const,
  fg: "#adadb1",
  bg: "#0a0a0a",
  settings: [
    { settings: { foreground: "#adadb1", background: "#0a0a0a" } },
    { scope: "comment, punctuation.definition.comment", settings: { foreground: "#84848A" } },
    {
      scope: "keyword, storage, storage.type, keyword.operator.expression",
      settings: { foreground: "#FF678D" },
    },
    {
      scope: "entity.name.function, support.function, meta.function-call",
      settings: { foreground: "#9D6AFB" },
    },
    {
      scope: "entity.name.type, support.type, support.class",
      settings: { foreground: "#D568EA" },
    },
    {
      scope: "string, constant.character, punctuation.definition.string",
      settings: { foreground: "#5ECC71" },
    },
    {
      scope: "constant.numeric, constant.language, constant.other",
      settings: { foreground: "#68CDF2" },
    },
    {
      scope: "variable.parameter, variable.other.readwrite, meta.object-literal.key",
      settings: { foreground: "#FFA359" },
    },
    {
      scope: "entity.name.tag, support.class.component",
      settings: { foreground: "#5ECC71" },
    },
    {
      scope: "punctuation, meta.brace, meta.delimiter",
      settings: { foreground: "#79797F" },
    },
    { scope: "invalid", settings: { foreground: "#FF6762" } },
  ],
};

const INITIAL_LANGUAGE_MODULES = [
  () => import("@shikijs/langs/bash"),
  () => import("@shikijs/langs/diff"),
  () => import("@shikijs/langs/javascript"),
  () => import("@shikijs/langs/json"),
  () => import("@shikijs/langs/jsx"),
  () => import("@shikijs/langs/tsx"),
  () => import("@shikijs/langs/typescript"),
  () => import("@shikijs/langs/yaml"),
] satisfies Parameters<typeof createHighlighterCore>[0]["langs"];
const loadedLanguages = new Set<string>([
  "text",
  "bash",
  "diff",
  "javascript",
  "json",
  "jsx",
  "tsx",
  "typescript",
  "yaml",
]);
const languageLoadingPromises = new Map<string, Promise<boolean>>();
const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  "objective-c": () => import("@shikijs/langs/objective-c"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  r: () => import("@shikijs/langs/r"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  clojure: () => import("@shikijs/langs/clojure"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  erlang: () => import("@shikijs/langs/erlang"),
  zig: () => import("@shikijs/langs/zig"),
  nim: () => import("@shikijs/langs/nim"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  xml: () => import("@shikijs/langs/xml"),
  svg: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  bash: () => import("@shikijs/langs/bash"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  fish: () => import("@shikijs/langs/fish"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  docker: () => import("@shikijs/langs/docker"),
  hcl: () => import("@shikijs/langs/hcl"),
  nix: () => import("@shikijs/langs/nix"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  tex: () => import("@shikijs/langs/tex"),
  diff: () => import("@shikijs/langs/diff"),
  regex: () => import("@shikijs/langs/regex"),
  viml: () => import("@shikijs/langs/viml"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  groovy: () => import("@shikijs/langs/groovy"),
};

const languageAliases: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  vim: "viml",
  objc: "objective-c",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  ml: "ocaml",
  fs: "fsharp",
  tf: "hcl",
  make: "makefile",
  plain: "text",
  plaintext: "text",
  txt: "text",
};

type LoadedLanguageModule = {
  default: Parameters<HighlighterCore["loadLanguage"]>[0];
};

let nativeRegexEngine: NativeRegexEngineFunctions | undefined;
let highlighterPromise: Promise<HighlighterCore> | null = null;

export function installNativeRegexEngine(functions: NativeRegexEngineFunctions): void {
  nativeRegexEngine = functions;
}

function createNativeRegexEngine(native: NativeRegexEngineFunctions): RegexEngine {
  return {
    createScanner(patterns) {
      const scannerId = native.createScanner(
        patterns.map((pattern) => (typeof pattern === "string" ? pattern : pattern.source)),
        NATIVE_SCANNER_CACHE_SIZE,
      );
      return {
        findNextMatchSync(string, startPosition) {
          const match = native.findNextMatchSync(
            scannerId,
            typeof string === "string" ? string : string.content,
            startPosition,
          );
          return match && { index: match.index, captureIndices: [...match.captureIndices] };
        },
        dispose() {
          native.destroyScanner(scannerId);
        },
      };
    },
    createString(content) {
      return { content };
    },
  };
}

async function createHighlighter(): Promise<HighlighterCore> {
  const options = {
    themes: [githubLightDefault, githubDarkDefault, PIERRE_LIGHT_THEME, PIERRE_DARK_THEME],
    langs: INITIAL_LANGUAGE_MODULES,
  };
  const engine = resolveReviewHighlighterEngine(ENGINE_PREFERENCE, nativeRegexEngine !== undefined);
  if (engine === "native" && nativeRegexEngine) {
    try {
      return await createHighlighterCore({
        ...options,
        engine: createNativeRegexEngine(nativeRegexEngine),
      });
    } catch (error) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.error("[shiki] native engine failed; falling back to javascript", error);
      }
    }
  }
  return createHighlighterCore({ ...options, engine: createJavaScriptRegexEngine() });
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighter().catch((error: unknown) => {
    highlighterPromise = null;
    throw error;
  });
  return highlighterPromise;
}

async function loadLanguage(highlighter: HighlighterCore, language: string): Promise<boolean> {
  if (loadedLanguages.has(language)) {
    return true;
  }

  const existingPromise = languageLoadingPromises.get(language);
  if (existingPromise) {
    return existingPromise;
  }

  const importer = languageImports[language];
  if (!importer) {
    return false;
  }

  const loadingPromise = (async () => {
    try {
      const languageModule = (await importer()) as LoadedLanguageModule;
      await highlighter.loadLanguage(languageModule.default);
      loadedLanguages.add(language);
      return true;
    } catch {
      return false;
    } finally {
      languageLoadingPromises.delete(language);
    }
  })();

  languageLoadingPromises.set(language, loadingPromise);
  return loadingPromise;
}

async function resolveLanguage(
  highlighter: HighlighterCore,
  path: string,
  languageHint: string | null,
): Promise<string> {
  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path);
  if (!detectedLanguage) {
    return "text";
  }

  const normalized = detectedLanguage.toLowerCase();
  const candidate = languageAliases[normalized] ?? normalized;
  if (candidate === "text" || candidate === "ansi" || !(candidate in languageImports)) {
    return "text";
  }

  return (await loadLanguage(highlighter, candidate)) ? candidate : "text";
}

export async function tokenizeCode(
  request: TokenizeRequest,
  isCancelled: () => boolean = () => false,
): Promise<Array<Array<ReviewHighlightedToken>>> {
  const highlighter = await getHighlighter();
  const lang = await resolveLanguage(highlighter, request.path, request.languageHint);
  const lines = request.code.split("\n");
  const highlighted: Array<Array<ReviewHighlightedToken>> = [];
  let grammarState: GrammarState | undefined;
  let start = 0;

  while (start < lines.length) {
    if (isCancelled()) return [];

    // Skipping this line leaves its ending grammar state unknown. Resume from a
    // fresh state rather than leaving the rest plain: highlighted diff rows are
    // cached for the sheet's lifetime, so a plain tail would stick.
    if (lines[start]!.length > TOKENIZE_MAX_LINE_LENGTH) {
      highlighted.push([{ content: lines[start]!, color: null, fontStyle: null }]);
      grammarState = undefined;
      start += 1;
      continue;
    }

    let end = start;
    let characters = 0;
    while (end < lines.length) {
      const length = lines[end]!.length;
      if (
        length > TOKENIZE_MAX_LINE_LENGTH ||
        (end > start && characters + length + 1 > TOKENIZE_BATCH_CHARACTERS)
      ) {
        break;
      }
      characters += length + (end > start ? 1 : 0);
      end += 1;
    }

    const tokenLines = highlighter.codeToTokensBase(lines.slice(start, end).join("\n"), {
      lang,
      theme: request.theme,
      grammarState,
    });
    grammarState = highlighter.getLastGrammarState(tokenLines);
    for (const line of tokenLines) {
      highlighted.push(
        line.map((token) => ({
          content: token.content,
          color: token.color ?? null,
          fontStyle: token.fontStyle ?? null,
        })),
      );
    }
    start = end;
  }

  return isCancelled() ? [] : highlighted;
}
