import { WorkspaceParent } from "obsidian";
import { MouseEvent, useState } from "react";
import { useApp, useSettings } from "src/models/PluginContext";
import { SavedTab } from "src/models/SavedGroup";
import { savedGroupStore } from "src/stores/SavedGroupStore";
import { savedGroupManager } from "src/services/SavedGroups";
import { createVTMenu } from "src/services/Menu";
import { CssClasses, toClassName } from "src/utils/CssClasses";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

const ClosedTab = (props: { group: WorkspaceParent; tab: SavedTab }) => {
	const app = useApp();
	const { group, tab } = props;
	const label =
		tab.kind === "url"
			? tab.title || tab.target
			: app.vault.getFileByPath(tab.target)?.basename ??
			  tab.target.split("/").pop() ??
			  tab.target;
	const reopen = () => void savedGroupManager.reopenClosedTab(group, tab);
	const forget = () => savedGroupManager.forgetClosedTabs(group, [tab.key]);
	return (
		<div className="tree-item vt-recently-closed-tab">
			<div className="tree-item-self is-clickable" onClick={reopen} aria-label={tab.target}>
				<Icon className="tree-item-icon" icon={tab.kind === "url" ? "globe" : "file"} />
				<div className="tree-item-inner">
					<div className="tree-item-inner-text">{label}</div>
				</div>
				<div className="tree-item-flair-outer" onClick={(e) => e.stopPropagation()}>
					<IconButton
						icon="x"
						action="forget-closed-tab"
						tooltip="Remove from recently closed"
						onClick={forget}
					/>
				</div>
			</div>
		</div>
	);
};

// Recently closed tabs of a group, at the end of its tab list. Collapsed by default.
export const RecentlyClosedTabs = (props: { group: WorkspaceParent | null }) => {
	const { group } = props;
	const limit = useSettings((state) => state.recentlyClosedLimit);
	const source = savedGroupStore((state) => {
		if (!group) return undefined;
		const savedGroupID = state.links[group.id];
		const savedGroup = savedGroupID ? state.savedGroups[savedGroupID] : undefined;
		return savedGroup ? savedGroup.recentlyClosed : state.recentlyClosed[group.id];
	});
	const [isExpanded, setIsExpanded] = useState(false);
	if (!group || !source || limit <= 0) return null;
	const openKeys = savedGroupManager.getOpenTabKeys(group);
	const tabs = source
		.filter((tab) => !openKeys.has(tab.key))
		.slice(0, savedGroupManager.getRecentlyClosedLimit());
	if (tabs.length === 0) return null;

	const showMenu = (event: MouseEvent) => {
		const menu = createVTMenu("vt-recently-closed-menu");
		menu.addItem((item) =>
			item
				.setTitle("Clear recently closed")
				.onClick(() =>
					savedGroupManager.forgetClosedTabs(group, tabs.map((tab) => tab.key))
				)
		);
		menu.showAtMouseEvent(event.nativeEvent);
	};

	const classes: CssClasses = {
		"tree-item": true,
		"vt-recently-closed": true,
		"is-collapsed": !isExpanded,
	};
	return (
		<div className={toClassName(classes)}>
			<div
				className="tree-item-self is-clickable vt-recently-closed-header"
				onClick={() => setIsExpanded(!isExpanded)}
				onContextMenu={showMenu}
			>
				<Icon className="tree-item-icon collapse-icon" icon="right-triangle" />
				<div className="tree-item-inner">
					<div className="tree-item-inner-text">Recently closed</div>
				</div>
				<div className="tree-item-flair-outer">
					<span className="tree-item-flair">{tabs.length}</span>
				</div>
			</div>
			{isExpanded && (
				<div className="tree-item-children">
					{tabs.map((tab) => (
						<ClosedTab key={tab.key} group={group} tab={tab} />
					))}
				</div>
			)}
		</div>
	);
};
