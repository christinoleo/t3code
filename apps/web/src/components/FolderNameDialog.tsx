import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { folderFromMenuAction, parseFolderName } from "./threadActionMenu.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface FolderNameRequestCopy {
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly initialName: string;
}

const NEW_FOLDER: FolderNameRequestCopy = {
  title: "New folder",
  description: "Moved threads leave their project and show under this folder.",
  submitLabel: "Move",
  initialName: "",
};

type Request = FolderNameRequestCopy & { readonly resolve: (name: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

function requestFolderName(copy: FolderNameRequestCopy): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...copy, resolve } }));
}

/** Asks for a folder's new name; `null` when cancelled. */
export function requestFolderRename(current: string): Promise<string | null> {
  return requestFolderName({
    title: "Rename folder",
    description: "Renaming onto an existing folder merges the two.",
    submitLabel: "Rename",
    initialName: current,
  });
}

/** Maps a clicked Folder submenu item to its target; `null` when cancelled. */
export async function resolveFolderMenuAction(
  action: string,
): Promise<{ readonly folder: string | null } | null> {
  if (action === "folder-new") {
    const name = await requestFolderName(NEW_FOLDER);
    return name === null ? null : { folder: name };
  }
  const folder = folderFromMenuAction(action);
  return folder === undefined ? null : { folder };
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function FolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending folder name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <FolderNameDialog request={request} /> : null;
}

function FolderNameDialog({ request }: { request: FolderNameRequestCopy }) {
  const id = useId();
  const [value, setValue] = useState(request.initialName);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const name = parseFolderName(value);
            if (name === null) {
              setError("Use a single line of at most 64 characters.");
              return;
            }
            finish(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>{request.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={`${id}-name`}>
              Name
              <Input
                nativeInput
                id={`${id}-name`}
                autoFocus
                required
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
            </Label>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
