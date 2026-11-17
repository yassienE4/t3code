import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import type { UsageLimitSourceConfig } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { makeOpenDesignUsage } from "./openDesignUsage.ts";

const config: UsageLimitSourceConfig = {
  kind: "opendesign",
  cliPath: "/tools/vela",
  amrHome: "/accounts/first",
  workspaceId: "workspace-a",
  url: "https://open-design.ai/cloud/dashboard",
  managementKey: "",
  enabled: true,
};
const billing = (workspaceId = "workspace-a", member = "member-a", limit = "50000") => ({
  workspaceId,
  workspaceMemberId: member,
  generatedAt: "2026-11-17T09:00:00Z",
  codingPlan: {
    workspaceId,
    eligible: true,
    tier: "go",
    generatedAt: "2026-11-17T09:00:00Z",
    windows: [
      {
        durationSeconds: 18000,
        usedCredits: "12500",
        limitCredits: limit,
        remainingCredits: "37500",
        resetsAt: "2026-11-17T13:00:00Z",
      },
      {
        durationSeconds: 604800,
        usedCredits: "150000",
        limitCredits: "150000",
        remainingCredits: "0",
        resetsAt: "2026-11-18T09:00:00Z",
      },
    ],
  },
});
function fixture(stdout: (home: string) => string, code = 0) {
  const homes: string[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") throw new Error("Expected a literal command");
      const env = command.options.env;
      expect(env?.VELA_CONTROL_KEY).toBeUndefined();
      expect(env?.VELA_RUNTIME_KEY).toBeUndefined();
      expect(env?.OPEN_DESIGN_AMR_PROFILE).toBeUndefined();
      expect(command.options.extendEnv).toBe(false);
      const home = String(env?.AMR_HOME);
      homes.push(home);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout(home))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    homes,
    layer: Layer.mergeAll(
      NodePath.layer,
      Layer.succeed(HostProcess.HomeDirectory, "/home/test"),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HostProcess.Environment, {
        VELA_CONTROL_KEY: "inherited-secret",
        VELA_RUNTIME_KEY: "other-secret",
        OPEN_DESIGN_AMR_PROFILE: "test",
      }),
    ),
  };
}

it.effect("reads independent subscriptions without inheriting server credentials", () => {
  const f = fixture((home) =>
    JSON.stringify(home.endsWith("second") ? billing("workspace-b", "member-b") : billing()),
  );
  return Effect.gen(function* () {
    const reader = yield* makeOpenDesignUsage;
    const [a, b] = yield* Effect.all(
      [
        reader.readAccount(config),
        reader.readAccount({ ...config, amrHome: "/accounts/second", workspaceId: "workspace-b" }),
      ],
      { concurrency: 2 },
    );
    expect(new Set(f.homes)).toEqual(new Set(["/accounts/first", "/accounts/second"]));
    expect(a.usageLimits.credentialFingerprint).not.toBe(b.usageLimits.credentialFingerprint);
    expect(
      a.usageLimits.windows.map((window) => [window.kind, window.usedPercent, window.capacity]),
    ).toEqual([
      ["session", 25, 50000],
      ["weekly", 100, 150000],
    ]);
    expect(a.usageLimits.checkedAt).toBe("2026-11-17T09:00:00.000Z");
    const duplicate = yield* reader.readAccount({ ...config, amrHome: "/accounts/duplicate" });
    expect(duplicate.usageLimits.credentialFingerprint).toBe(a.usageLimits.credentialFingerprint);
    yield* reader.readAccount({ ...config, amrHome: "~/.amr" });
    expect(f.homes.at(-1)).toBe("/home/test/.amr");
    const before = f.homes.length;
    expect(
      (yield* reader.readAccount({ ...config, amrHome: "relative" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(f.homes).toHaveLength(before);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  { name: "wrong workspace", stdout: JSON.stringify(billing("another-workspace")), code: 0 },
  {
    name: "zero capacity",
    stdout: JSON.stringify(billing("workspace-a", "member-a", "0")),
    code: 0,
  },
  {
    name: "invalid credits",
    stdout: JSON.stringify(billing("workspace-a", "member-a", "NaN")),
    code: 0,
  },
  { name: "malformed response", stdout: "not-json", code: 0 },
  {
    name: "missing Coding Plan",
    stdout: JSON.stringify({ ...billing(), codingPlan: null }),
    code: 0,
  },
  {
    name: "ineligible Coding Plan",
    stdout: JSON.stringify({
      ...billing(),
      codingPlan: { ...billing().codingPlan, eligible: false },
    }),
    code: 0,
  },
  { name: "failed login", stdout: "private-error", code: 1 },
  { name: "oversized response", stdout: "x".repeat(1024 * 1024 + 1), code: 0 },
])("reports $name as unavailable without fabricated quota", ({ stdout, code }) => {
  const f = fixture(() => stdout, code);
  return Effect.gen(function* () {
    const reader = yield* makeOpenDesignUsage;
    const result = yield* reader.readAccount(config).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.detail).not.toContain("private-error");
  }).pipe(Effect.provide(f.layer));
});
