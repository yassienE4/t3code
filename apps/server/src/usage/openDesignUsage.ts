import {
  ProviderDriverKind,
  TrimmedNonEmptyString,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Credit = Schema.String.check(
  Schema.makeFilter(
    (value: string) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0,
  ),
);
const Billing = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  workspaceMemberId: TrimmedNonEmptyString,
  generatedAt: Schema.String,
  codingPlan: Schema.NullOr(
    Schema.Struct({
      workspaceId: TrimmedNonEmptyString,
      generatedAt: Schema.String,
      eligible: Schema.Boolean,
      tier: TrimmedNonEmptyString,
      windows: Schema.Array(
        Schema.Struct({
          durationSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
          limitCredits: Credit,
          remainingCredits: Credit,
          usedCredits: Credit,
          resetsAt: Schema.String,
        }),
      ),
    }),
  ),
});

const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);
const decodeBilling = Schema.decodeUnknownEffect(Schema.fromJsonString(Billing));

export const makeOpenDesignUsage = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnv = yield* HostProcess.Environment;
  const expand = (value: string) =>
    value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;

  const readAccount = Effect.fn("OpenDesignUsage.readAccount")(
    function* (config: UsageLimitSourceConfig) {
      if (!config.cliPath || !config.workspaceId) {
        return yield* new UsageLimitSourceError({
          detail: "Set the OpenDesign CLI path and workspace ID.",
        });
      }
      const amrHome = expand(config.amrHome ?? "~/.amr");
      if (!path.isAbsolute(amrHome)) {
        return yield* new UsageLimitSourceError({
          detail: "The OpenDesign login directory must be an absolute path.",
        });
      }
      // Account isolation must outrank credentials and endpoint bindings inherited from the server.
      const env = Object.fromEntries(
        Object.entries(hostEnv).filter(
          ([key]) =>
            !key.startsWith("VELA_") &&
            !key.startsWith("OPEN_DESIGN_AMR_") &&
            !key.startsWith("OD_VELA_") &&
            key !== "AMR_HOME",
        ),
      );
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(
            expand(config.cliPath),
            ["billing", "preflight", "--workspace-id", config.workspaceId, "--format", "json"],
            {
              env: { ...env, AMR_HOME: amrHome, VELA_PROFILE: "prod" },
              extendEnv: false,
              stdin: "ignore",
              stderr: "ignore",
              forceKillAfter: "1 second",
            },
          ),
        )
        .pipe(
          Effect.mapError(
            () =>
              new UsageLimitSourceError({
                detail:
                  "Could not start the OpenDesign CLI. Check its path and executable permissions.",
              }),
          ),
        );
      const [stdout, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.mapAccum(
              () => 0,
              (size, chunk) =>
                [size + chunk.length, [{ size: size + chunk.length, chunk }]] as const,
            ),
            Stream.mapEffect(({ size, chunk }) =>
              size > 1024 * 1024
                ? Effect.fail(
                    new UsageLimitSourceError({
                      detail: "OpenDesign returned too much billing data.",
                    }),
                  )
                : Effect.succeed(chunk),
            ),
            Stream.mkString,
          ),
          handle.exitCode,
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(
          () =>
            new UsageLimitSourceError({ detail: "Could not read the OpenDesign CLI response." }),
        ),
      );
      if (exitCode !== 0) {
        return yield* new UsageLimitSourceError({
          detail:
            "OpenDesign billing failed. Check the workspace ID and sign in using this account's AMR_HOME directory.",
        });
      }
      const billing = yield* decodeBilling(stdout).pipe(
        Effect.mapError(
          () =>
            new UsageLimitSourceError({
              detail: "OpenDesign returned an unsupported billing response.",
            }),
        ),
      );
      const plan = billing.codingPlan;
      if (
        billing.workspaceId !== config.workspaceId ||
        (plan && plan.workspaceId !== config.workspaceId)
      ) {
        return yield* new UsageLimitSourceError({
          detail: "OpenDesign returned billing for a different workspace.",
        });
      }
      if (!plan?.eligible || plan.windows.length === 0) {
        return yield* new UsageLimitSourceError({
          detail: "No Coding Plan quota is available for this account and workspace.",
        });
      }
      const checkedAt = DateTime.make(plan.generatedAt);
      if (
        Option.isNone(checkedAt) ||
        plan.windows.some(
          (window) =>
            Number(window.limitCredits) <= 0 || Option.isNone(DateTime.make(window.resetsAt)),
        )
      ) {
        return yield* new UsageLimitSourceError({
          detail: "OpenDesign returned invalid quota limits or timestamps.",
        });
      }
      const windows = plan.windows.map((window) => {
        const seconds = window.durationSeconds;
        return {
          id: `opendesign-${seconds}`,
          kind: seconds === 18000 ? "session" : seconds === 604800 ? "weekly" : "other",
          label:
            seconds === 18000
              ? "5-hour limit"
              : seconds === 604800
                ? "Weekly limit"
                : `${seconds / 3600}-hour limit`,
          usedPercent: Math.max(
            0,
            Math.min(100, (100 * Number(window.usedCredits)) / Number(window.limitCredits)),
          ),
          capacity: Number(window.limitCredits),
          windowDurationMins: Math.ceil(seconds / 60),
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt)),
        } as const;
      });
      if (new Set(windows.map((window) => window.id)).size !== windows.length) {
        return yield* new UsageLimitSourceError({
          detail: "OpenDesign returned ambiguous quota windows.",
        });
      }
      return {
        id: billing.workspaceMemberId,
        driver: ProviderDriverKind.make("opendesign"),
        plan: plan.tier,
        workspaceId: billing.workspaceId,
        usageLimits: {
          checkedAt: DateTime.formatIso(checkedAt.value),
          credentialFingerprint: `opendesign:${billing.workspaceId}:${billing.workspaceMemberId}`,
          windows,
        },
      } satisfies UsageLimitSourceAccount;
    },
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.mapError((cause) =>
      isUsageLimitSourceError(cause)
        ? cause
        : new UsageLimitSourceError({
            detail: "OpenDesign billing timed out or could not be read.",
          }),
    ),
  );
  return { readAccount };
});
