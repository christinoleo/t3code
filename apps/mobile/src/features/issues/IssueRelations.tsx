import { StackActions, useNavigation } from "@react-navigation/native";
import type { IssueRelations, IssueRelationTarget } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import { issueIdentity, type IssueParams } from "./issueParams";
import { issueStatus } from "./issuePresentation";

function IssueRelationRow(props: {
  readonly params: IssueParams;
  readonly target: IssueRelationTarget;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const status = issueStatus(props.target.state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{status} issue {key}, {title}", {
        status: status.label,
        key: props.target.displayKey,
        title: props.target.title,
      })}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("Issue", {
            ...issueIdentity(props.params),
            scope: props.target.scope,
            issueKey: props.target.key,
          }),
        )
      }
      className="flex-row items-center gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
    >
      <SymbolView name={status.icon} size={15} tintColorClassName={status.tint} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm" numberOfLines={2}>
          {props.target.title}
        </Text>
        <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
          {props.target.displayKey}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

export function IssueRelationsSection(props: {
  readonly params: IssueParams;
  readonly relations: IssueRelations;
}) {
  const gt = useGT();
  const { relations } = props;
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
    <View className="gap-2">
      {groups.map((group) => (
        <View key={group.name} className="gap-2">
          <PullRequestSectionHeading>{group.label}</PullRequestSectionHeading>
          {group.targets.map((target) => (
            <IssueRelationRow
              key={`${target.scope} ${target.key}`}
              params={props.params}
              target={target}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
