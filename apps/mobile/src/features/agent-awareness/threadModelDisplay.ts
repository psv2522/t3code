import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
} from "@t3tools/client-runtime/model-traits";
import {
  isProviderDriverKind,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";

import { buildModelOptions } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";

export interface ThreadModelDisplay {
  readonly label: string;
}

export type ThreadModelResolver = (thread: OrchestrationV2ThreadShell) => ThreadModelDisplay | null;

function makeResolver(config: ServerConfig): ThreadModelResolver {
  const cache = new Map<string, ThreadModelDisplay | null>();
  return (thread) => {
    const selection = thread.modelSelection;
    const key = JSON.stringify([thread.projectId, selection]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const option = buildModelOptions(
      config,
      selection,
      selection.instanceId,
      thread.projectId,
    ).find(
      (candidate) =>
        candidate.selection.instanceId === selection.instanceId &&
        candidate.selection.model === selection.model,
    );
    let display: ThreadModelDisplay | null = null;
    if (option) {
      const driver = option.providerDriver;
      const descriptors = resolveProviderOptionDescriptors({
        capabilities: option.capabilities,
        selections: selection.options,
      });
      const promptTraits = getPromptControlledTraits(descriptors, "");
      const traits = isProviderDriverKind(driver)
        ? buildTraitsTriggerDisplay({
            provider: driver,
            descriptors,
            primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
            ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
            modelSelection: selection,
          }).label
        : "";
      display = {
        label: [option.shortName ?? option.label, traits].filter(Boolean).join(" "),
      };
    }
    cache.set(key, display);
    return display;
  };
}

const resolvers = new WeakMap<ServerConfig, ThreadModelResolver>();

/** One resolver per config object, so unchanged threads keep a stable memo key. */
export function threadModelResolverFor(config: ServerConfig): ThreadModelResolver {
  let resolver = resolvers.get(config);
  if (!resolver) {
    resolver = makeResolver(config);
    resolvers.set(config, resolver);
  }
  return resolver;
}
