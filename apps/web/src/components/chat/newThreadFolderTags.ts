import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { readShownSidebarProjectScopeKeys } from "../../hooks/useSidebarProjectGroups";
import { newThreadCreateTags } from "../sidebar/ProjectRail.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The folder tags a new thread is created with, warning when the selected folder cannot be used. */
export function readNewThreadFolderTags() {
  const { create, unusableFolder } = newThreadCreateTags(readShownSidebarProjectScopeKeys());
  if (unusableFolder !== null) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: m(msg("Folder not applied")),
        description: m(
          msg("The folder name {folder} is not valid, so the new thread starts outside it.", {
            folder: JSON.stringify(unusableFolder),
          }),
        ),
      }),
    );
  }
  return create;
}
