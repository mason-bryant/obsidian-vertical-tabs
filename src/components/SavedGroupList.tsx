import { CSSProperties, MouseEvent } from "react";
import { useApp } from "src/models/PluginContext";
import { SavedGroup } from "src/models/SavedGroup";
import { savedGroupStore } from "src/stores/SavedGroupStore";
import { savedGroupManager } from "src/services/SavedGroups";
import {
	getSetHotkeyTitle,
	openSavedGroupHotkeySettings,
} from "src/services/SavedGroupCommands";
import { addColorOptionsToMenu } from "src/services/Customization";
import { createVTMenu } from "src/services/Menu";
import { IconSelectionModal } from "src/views/IconSelectionModal";
import { CssClasses, toClassName } from "src/utils/CssClasses";
import { IconButton } from "./IconButton";
import { SavedGroupHotkey } from "./SavedGroupHotkey";
import { Icon } from "./Icon";

const SavedGroupItem = (props: { savedGroup: SavedGroup }) => {
	const app = useApp();
	const { savedGroup } = props;
	const { id, name, color, icon, tabs } = savedGroup;

	const open = () => void savedGroupManager.openSavedGroup(id);
	const remove = () => savedGroupManager.confirmDeleteSavedGroup(id);

	const showMenu = (event: MouseEvent) => {
		const menu = createVTMenu("vt-saved-group-menu");
		menu.addItem((item) =>
			item.setSection("open").setTitle("Open").onClick(open)
		);
		menu.addItem((item) =>
			item
				.setSection("customization")
				.setTitle("Rename")
				.onClick(() => savedGroupManager.promptToRenameSavedGroup(id))
		);
		menu.addItem((item) => {
			item.setSection("customization").setTitle("Change color");
			addColorOptionsToMenu(
				item.setSubmenu(),
				(color) => void savedGroupManager.setSavedGroupColor(id, color),
				() => void savedGroupManager.setSavedGroupColor(id, undefined)
			);
		});
		menu.addItem((item) =>
			item
				.setSection("customization")
				.setTitle("Change icon")
				.onClick(() => {
					new IconSelectionModal(
						app,
						(icon) => void savedGroupManager.setSavedGroupIcon(id, icon),
						() => void savedGroupManager.setSavedGroupIcon(id, undefined)
					).open();
				})
		);
		menu.addItem((item) =>
			item
				.setSection("hotkey")
				.setTitle(getSetHotkeyTitle(app, id))
				.onClick(() => openSavedGroupHotkeySettings(app, savedGroup))
		);
		menu.addItem((item) =>
			item
				.setSection("note")
				.setTitle("Reveal note in navigation")
				.onClick(() => savedGroupManager.revealSavedGroupNote(id))
		);
		menu.addItem((item) =>
			item
				.setSection("danger")
				.setTitle("Delete")
				.setWarning(true)
				.onClick(remove)
		);
		menu.showAtMouseEvent(event.nativeEvent);
	};

	const classes: CssClasses = {
		"tree-item": true,
		"nav-folder": true,
		"is-group": true,
		"is-collapsed": true,
		"vt-saved-group": true,
	};
	const style = { "--vt-custom-color": color } as CSSProperties;
	const count = tabs.length;

	return (
		<div className={toClassName(classes)} data-color={color} style={style}>
			<div
				className="tree-item-self is-clickable"
				onClick={open}
				onContextMenu={showMenu}
				aria-label={`Open "${name}" (${count} ${count === 1 ? "tab" : "tabs"})`}
				data-tooltip-position="right"
			>
				<Icon className="tree-item-icon" icon={icon ?? "layers"} />
				<div className="tree-item-inner">
					<div className="tree-item-inner-text">{name}</div>
				</div>
				<div
					className="tree-item-flair-outer"
					onClick={(e) => e.stopPropagation()}
				>
					<IconButton
						icon="trash-2"
						action="delete-saved-group"
						tooltip="Delete saved group"
						onClick={remove}
					/>
					<SavedGroupHotkey savedGroupID={id} />
					<span className="tree-item-flair">{count}</span>
				</div>
			</div>
		</div>
	);
};

// Saved groups that are not open on this device.
export const SavedGroupList = () => {
	const savedGroups = savedGroupStore((state) => state.savedGroups);
	const openGroups = savedGroupStore((state) => state.openGroups);
	const isCollapsed = savedGroupStore((state) => state.isListCollapsed);
	const { toggleListCollapsed } = savedGroupStore.getActions();

	const closedGroups = Object.values(savedGroups)
		.filter((savedGroup) => !openGroups[savedGroup.id])
		.sort((a, b) => a.name.localeCompare(b.name));
	if (closedGroups.length === 0) return null;

	const classes: CssClasses = {
		"tree-item": true,
		"nav-folder": true,
		"vt-saved-groups": true,
		"is-collapsed": isCollapsed,
	};

	return (
		<div className={toClassName(classes)}>
			<div
				className="tree-item-self is-clickable vt-saved-groups-header"
				onClick={toggleListCollapsed}
			>
				<Icon
					className="tree-item-icon collapse-icon"
					icon="right-triangle"
				/>
				<div className="tree-item-inner">
					<div className="tree-item-inner-text">Saved groups</div>
				</div>
				<div className="tree-item-flair-outer">
					<span className="tree-item-flair">{closedGroups.length}</span>
				</div>
			</div>
			{!isCollapsed && (
				<div className="tree-item-children">
					{closedGroups.map((savedGroup) => (
						<SavedGroupItem key={savedGroup.id} savedGroup={savedGroup} />
					))}
				</div>
			)}
		</div>
	);
};
