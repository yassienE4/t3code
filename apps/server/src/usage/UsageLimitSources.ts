import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import { makeOpenDesignUsage } from "./openDesignUsage.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

export function usageLimitSnapshotsForClient(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  openDesignUsageSources: boolean,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  if (openDesignUsageSources) return sources;
  // Legacy clients accept arbitrary driver names, but only the CLIProxy source kind.
  return sources.map((source) =>
    source.kind === "opendesign"
      ? {
          ...source,
          kind: "cliproxy",
          // Legacy clients use the account id as the label for accounts without an email.
          accounts: source.accounts.map((account) => ({ ...account, id: source.label })),
        }
      : source,
  );
}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  if (config.kind === "opendesign") return "OpenDesign";
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const openDesign = yield* makeOpenDesignUsage;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (config.kind === "opendesign") {
      const result = yield* openDesign.readAccount(config).pipe(Effect.result);
      return {
        id,
        kind: config.kind,
        label: sourceLabel(id, config),
        checkedAt,
        accounts: result._tag === "Success" ? [result.success] : [],
        ...(result._tag === "Failure" ? { error: result.failure.detail } : {}),
      };
    }
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(url && /^https?:$/.test(url.protocol)
        ? {
            origin: url.origin,
            endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
          }
        : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    if (config.kind !== "cliproxy") {
      return yield* new UsageLimitSourceError({
        detail: "This source does not support reset credits.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub answers with a usage limit only when every account it routes the driver to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  for (const source of sources) {
    for (const account of source.accounts) {
      if (account.driver !== driver) continue;
      // An unread account may be the one still blocked, so its refill is unknown.
      if (account.usageLimits.unavailable) return null;
      const spent = account.usageLimits.windows.filter(
        (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
      );
      if (spent.length === 0) return null;
      const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
      if (resets.some((reset) => !Number.isFinite(reset))) return null;
      const recoversAt = Math.max(...resets);
      if (recoversAt <= now) return null;
      earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
    }
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

/** A connection must resolve to one known subscription before its thread can be scheduled. */
export function openDesignResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  expectedSources: number,
  now: number,
): string | null {
  if (
    expectedSources === 0 ||
    sources.length !== expectedSources ||
    sources.some(
      (source) => source.kind !== "opendesign" || source.error || source.accounts.length !== 1,
    )
  )
    return null;
  const accounts = sources.flatMap((source) => source.accounts);
  if (new Set(accounts.map((account) => `${account.workspaceId}:${account.id}`)).size !== 1)
    return null;
  const account = [...accounts].sort(
    (a, b) => Date.parse(b.usageLimits.checkedAt) - Date.parse(a.usageLimits.checkedAt),
  )[0];
  const first = sources[0];
  if (!account || !first) return null;
  return hubPoolResetAt(
    [{ ...first, accounts: [account] }],
    ProviderDriverKind.make("opendesign"),
    null,
    now,
  );
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string | undefined,
    model: string | null,
    instanceId?: ProviderInstanceId,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    const settings = yield* Settings.ServerSettingsService;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(
        function* (driver, endpoint, model, instanceId) {
          if (driver === "opencode" && instanceId && model?.includes("/")) {
            const bindings = settings.getSettings.pipe(
              Effect.map((current) =>
                Object.entries(current.usageLimitSources)
                  .filter(
                    ([, config]) =>
                      config.enabled &&
                      config.kind === "opendesign" &&
                      config.opencodeInstanceId === instanceId &&
                      config.opencodeProviderId === model.slice(0, model.indexOf("/")),
                  )
                  .map(([id]) => id),
              ),
            );
            if ((yield* bindings).length > 0) {
              const refreshed = yield* sources.refresh.pipe(
                Effect.timeout("25 seconds"),
                Effect.result,
              );
              if (refreshed._tag === "Failure") return null;
              const ids = yield* bindings;
              const current = (yield* sources.current).filter((source) => ids.includes(source.id));
              return openDesignResetAt(
                current,
                ids.length,
                DateTime.toEpochMillis(yield* DateTime.now),
              );
            }
          }
          if (endpoint === undefined) return null;
          // Only the hub at the instance's endpoint serves its turns.
          const atEndpoint = Effect.map(sources.current, (current) =>
            current.filter((source) => source.origin === endpoint),
          );
          if ((yield* atEndpoint).length === 0) return null;
          // The pool usually ran out after the last poll, so the cached accounts still show room.
          yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
          return hubPoolResetAt(
            yield* atEndpoint,
            driver,
            model,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
        },
        Effect.orElseSucceed(() => null),
      ),
    };
  }),
);
