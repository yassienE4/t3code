import * as Schema from "effect/Schema";
import { T } from "gt-react";
import {
  type EnvironmentId,
  type UnifiedSettings,
  UsageLimitSourceId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const isInstanceId = Schema.is(ProviderInstanceId);

export function AddOpenDesignUsageDialog({
  environmentId,
  sources,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState("");
  const [cliPath, setCliPath] = useState("vela");
  const [amrHome, setAmrHome] = useState("~/.amr");
  const [workspaceId, setWorkspaceId] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [providerId, setProviderId] = useState("");
  const validBinding =
    (!instanceId.trim() && !providerId.trim()) ||
    (isInstanceId(instanceId.trim()) && !!providerId.trim() && !providerId.includes("/"));
  const save = () => {
    if (!validBinding || !label.trim() || !cliPath.trim() || !amrHome.trim() || !workspaceId.trim())
      return;
    let id = "opendesign";
    for (let suffix = 2; id in sources; suffix += 1) id = `opendesign-${suffix}`;
    updateSettings({
      usageLimitSources: {
        [UsageLimitSourceId.make(id)]: {
          kind: "opendesign",
          label: label.trim(),
          cliPath: cliPath.trim(),
          amrHome: amrHome.trim(),
          workspaceId: workspaceId.trim(),
          ...(instanceId.trim() && providerId.trim()
            ? {
                opencodeInstanceId: ProviderInstanceId.make(instanceId.trim()),
                opencodeProviderId: providerId.trim(),
              }
            : {}),
          url: "https://open-design.ai/cloud/dashboard",
          managementKey: "",
          enabled: true,
        },
      },
    });
    onOpenChange(false);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Add an OpenDesign subscription</T>
          </DialogTitle>
          <DialogDescription>
            <T>Read this account's quota using its own login directory.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-label`}>
                <T>Account label</T>
              </Label>
              <Input
                id={`${formId}-label`}
                autoFocus
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-cli`}>
                <T>Vela executable</T>
              </Label>
              <Input
                id={`${formId}-cli`}
                value={cliPath}
                onChange={(event) => setCliPath(event.target.value)}
                placeholder="/absolute/path/to/vela"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-home`}>
                <T>Login directory</T>
              </Label>
              <Input
                id={`${formId}-home`}
                value={amrHome}
                onChange={(event) => setAmrHome(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                <T>
                  Sign in with AMR_HOME set to this directory before adding the account. Use a
                  different directory for each login.
                </T>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-workspace`}>
                <T>Workspace ID</T>
              </Label>
              <Input
                id={`${formId}-workspace`}
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-instance`}>
                <T>OpenCode instance ID (optional)</T>
              </Label>
              <Input
                id={`${formId}-instance`}
                value={instanceId}
                onChange={(event) => setInstanceId(event.target.value)}
                placeholder="opencode"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-provider`}>
                <T>OpenCode model provider ID (optional)</T>
              </Label>
              <Input
                id={`${formId}-provider`}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                placeholder="opendesign"
              />
              <p className="text-xs text-muted-foreground">
                <T>Fill both IDs to enable resume after quota resets for this subscription.</T>
              </p>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={
              !validBinding ||
              ![label, cliPath, amrHome, workspaceId].every((value) => value.trim())
            }
          >
            <T>Add subscription</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
