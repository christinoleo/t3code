import type { IssueRelations, IssueRelationTarget } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { PullRequestSection } from "../pullRequest/PullRequestSummaryTab";
import { IssueStateGlyph } from "./issuePresentation";

function IssueRelationRow({
  target,
  onSelect,
}: {
  target: IssueRelationTarget;
  onSelect: ((target: IssueRelationTarget) => void) | null;
}) {
  const body = (
    <>
      <IssueStateGlyph state={target.state} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate text-sm">{target.title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {target.displayKey}
      </span>
    </>
  );
  const className =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent";
  return onSelect ? (
    <button type="button" className={className} onClick={() => onSelect(target)}>
      {body}
    </button>
  ) : (
    <a href={target.url} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  );
}

export function IssueRelationsSection({
  relations,
  onSelect,
}: {
  relations: IssueRelations;
  /** Opens a related issue beside this one; absent, the link goes to the tracker. */
  onSelect: ((target: IssueRelationTarget) => void) | null;
}) {
  const gt = useGT();
  const groups = [
    {
      name: "parent",
      label: gt("Parent", { $context: "issue relation: the issue this one is part of" }),
      targets: relations.parent ? [relations.parent] : [],
    },
    {
      name: "children",
      label: gt("Children", { $context: "issue relation: issues that are part of this one" }),
      targets: relations.children,
    },
    {
      name: "blocked-by",
      label: gt("Blocked by", { $context: "issue relation: issues that must finish first" }),
      targets: relations.blockedBy,
    },
    {
      name: "blocking",
      label: gt("Blocking", { $context: "issue relation: issues waiting on this one" }),
      targets: relations.blocking,
    },
  ].filter((group) => group.targets.length > 0);
  if (groups.length === 0) return null;
  return (
    <PullRequestSection
      title={gt("Relations", { $context: "section title: links between issues" })}
    >
      <div className="flex flex-col gap-2">
        {groups.map((group) => (
          <div key={group.name} className="flex flex-col gap-0.5">
            <span className="px-2 text-xs font-medium text-muted-foreground">{group.label}</span>
            {group.targets.map((target) => (
              <IssueRelationRow
                key={`${target.scope} ${target.key}`}
                target={target}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </div>
    </PullRequestSection>
  );
}
