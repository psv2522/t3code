import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as MobilePreferences from "../persistence/mobile-preferences";
import * as Runtime from "../lib/runtime";

interface OptimisticPreferences {
  readonly values: Partial<MobilePreferences.Preferences>;
  readonly versions: Partial<Record<keyof MobilePreferences.Preferences, number>>;
}

type PreferencesUpdate =
  | Partial<MobilePreferences.Preferences>
  | {
      readonly transform: (
        current: MobilePreferences.Preferences,
      ) => Partial<MobilePreferences.Preferences>;
    };

/** Keep optimistic patches separate so hydration cannot overwrite pending writes. */
export function createMobilePreferencesState(
  runtime: Atom.AtomRuntime<MobilePreferences.MobilePreferencesStore>,
) {
  const storedPreferencesAtom = runtime
    .atom(
      MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.load),
        Effect.map((preferences) => ({ preferences, loadedSuccessfully: true })),
        Effect.catch((error) =>
          Effect.logWarning("Could not load mobile preferences.", error).pipe(
            Effect.as({
              preferences: {} as MobilePreferences.Preferences,
              loadedSuccessfully: false,
            }),
          ),
        ),
      ),
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences:stored"));

  const optimisticPatchAtom = Atom.make<OptimisticPreferences>({ values: {}, versions: {} }).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:optimistic-patch"),
  );
  const confirmedPreferencesAtom = Atom.make<MobilePreferences.Preferences>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:preferences:confirmed"),
  );
  let nextPatchVersion = 0;

  const preferencesAtom = Atom.make((get) => {
    const stored = get(storedPreferencesAtom);
    const confirmed = get(confirmedPreferencesAtom);
    const optimistic = get(optimisticPatchAtom);
    return AsyncResult.map(stored, (preferences) => ({
      ...preferences.preferences,
      ...confirmed,
      ...optimistic.values,
    }));
  }).pipe(Atom.keepAlive, Atom.withLabel("mobile:preferences"));

  const settlePatch = (
    registry: AtomRegistry.AtomRegistry,
    patch: Partial<MobilePreferences.Preferences>,
    version: number,
  ) => {
    const optimistic = registry.get(optimisticPatchAtom);
    const values = { ...optimistic.values } as Record<string, unknown>;
    const versions = { ...optimistic.versions } as Record<string, unknown>;
    for (const key of Object.keys(patch) as Array<keyof MobilePreferences.Preferences>) {
      if (optimistic.versions[key] === version) {
        delete values[key];
        delete versions[key];
      }
    }
    registry.set(optimisticPatchAtom, {
      values: values as Partial<MobilePreferences.Preferences>,
      versions: versions as Partial<Record<keyof MobilePreferences.Preferences, number>>,
    });
  };

  // The optimistic patch lands when a save starts, before the store finishes writing.
  const stage = (update: PreferencesUpdate, registry: AtomRegistry.AtomRegistry) => {
    const currentPreferences = registry.get(preferencesAtom);
    const patch =
      "transform" in update
        ? update.transform(
            AsyncResult.isSuccess(currentPreferences) ? currentPreferences.value : {},
          )
        : update;
    const version = ++nextPatchVersion;
    const current = registry.get(optimisticPatchAtom);
    const versions = { ...current.versions };
    for (const key of Object.keys(patch) as Array<keyof MobilePreferences.Preferences>) {
      versions[key] = version;
    }
    registry.set(optimisticPatchAtom, { values: { ...current.values, ...patch }, versions });
    return { patch, version } as const;
  };

  const save = Effect.fn("MobilePreferencesState.save")(function* (
    update: PreferencesUpdate,
    registry: AtomRegistry.AtomRegistry,
  ) {
    const store = yield* MobilePreferences.MobilePreferencesStore;
    const staged = yield* Effect.sync(() => stage(update, registry));
    return yield* (
      "transform" in update ? store.update(update.transform) : store.savePatch(staged.patch)
    ).pipe(
      Effect.tap((saved) => Effect.sync(() => registry.set(confirmedPreferencesAtom, saved))),
      Effect.ensuring(Effect.sync(() => settlePatch(registry, staged.patch, staged.version))),
    );
  });

  // One command gives every caller its own settled result, even when saves overlap.
  const savePreferences = createRuntimeCommand(runtime, {
    label: "mobile:preferences:save",
    execute: save,
  });

  const loadedSuccessfullyAtom = Atom.make(
    (get) =>
      AsyncResult.getOrElse(get(storedPreferencesAtom), () => null)?.loadedSuccessfully === true,
  ).pipe(Atom.withLabel("mobile:preferences:loaded-successfully"));

  const savingAtom = Atom.make((get) => Object.keys(get(optimisticPatchAtom).values).length > 0).pipe(
    Atom.withLabel("mobile:preferences:saving"),
  );

  return { preferencesAtom, save, savePreferences, loadedSuccessfullyAtom, savingAtom } as const;
}

const mobilePreferencesRuntime = Atom.runtime(Runtime.layer);
const mobilePreferencesState = createMobilePreferencesState(mobilePreferencesRuntime);

export const mobilePreferencesAtom = mobilePreferencesState.preferencesAtom;
export const saveMobilePreferences = mobilePreferencesState.savePreferences;

export const mobilePreferencesLoadedSuccessfullyAtom =
  mobilePreferencesState.loadedSuccessfullyAtom;
export const mobilePreferencesSavingAtom = mobilePreferencesState.savingAtom;
