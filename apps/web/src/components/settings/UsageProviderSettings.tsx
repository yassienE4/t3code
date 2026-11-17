import { T } from "gt-react";
import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddOpenDesignUsageDialog } from "./AddOpenDesignUsageDialog";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [addingOpenDesign, setAddingOpenDesign] = useState(false);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(sources);

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setAddingOpenDesign(true)}>
                <T>Add OpenDesign</T>
              </Button>
              <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon className="size-3" aria-hidden />
                Add hub
              </Button>
            </div>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={<T>No usage sources configured.</T>} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.kind === "opendesign" ? "OpenDesign" : "CLI Proxy"}
                    {source.enabled ? "" : " · Disabled"}
                    {source.kind === "opendesign"
                      ? ` · ${source.amrHome ?? "~/.amr"}`
                      : label !== source.url
                        ? ` · ${source.url}`
                        : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            usageLimitSources: { [id]: { ...source, enabled: !source.enabled } },
                          })
                        }
                      >
                        {source.enabled ? <T>Disable</T> : <T>Enable</T>}
                      </Button>
                      <RemoveUsageProviderButton
                        label={label}
                        onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {addingOpenDesign && !readOnly ? (
        <AddOpenDesignUsageDialog
          environmentId={environmentId}
          sources={sources}
          onOpenChange={setAddingOpenDesign}
        />
      ) : null}
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This source leaves the Limits view. OpenDesign login files remain on the server; hub
                management keys stored by T3 are deleted.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove source</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
