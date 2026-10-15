import { App } from "obsidian";
import { around } from "monkey-around";
import ObsidianVerticalTabs from "src/main";
import { SavedGroup, SavedGroupID } from "src/models/SavedGroup";
import { savedGroupStore } from "src/stores/SavedGroupStore";
import { isPathID, savedGroupManager } from "./SavedGroups";

// One command per saved group, so users can assign hotkeys to it in
// Settings → Hotkeys. The command ID uses the group's ID from its note, so a
// hotkey survives renames and works on every device that shares the vault.
const commandID = (savedGroupID: SavedGroupID) => `open-saved-group-${savedGroupID}`;
const commandName = (name: string) => `Open saved tab group: ${name}`;

export function registerSavedGroupCommands(plugin: ObsidianVerticalTabs) {
	const registered = new Map<SavedGroupID, string>();

	const update = (savedGroups: Record<SavedGroupID, SavedGroup>) => {
		for (const id of Array.from(registered.keys())) {
			if (savedGroups[id]) continue;
			plugin.removeCommand(commandID(id));
			registered.delete(id);
		}
		for (const savedGroup of Object.values(savedGroups)) {
			// Notes without an ID get one when first opened; register them then.
			if (isPathID(savedGroup.id)) continue;
			if (registered.get(savedGroup.id) === savedGroup.name) continue;
			// Re-adding under the same ID keeps the hotkey and updates the name.
			if (registered.has(savedGroup.id)) plugin.removeCommand(commandID(savedGroup.id));
			const id = savedGroup.id;
			plugin.addCommand({
				id: commandID(id),
				name: commandName(savedGroup.name),
				callback: () => void savedGroupManager.openSavedGroup(id),
			});
			registered.set(id, savedGroup.name);
		}
	};

	update(savedGroupStore.getState().savedGroups);
	plugin.register(
		savedGroupStore.subscribe((state, previous) => {
			if (state.savedGroups !== previous.savedGroups) update(state.savedGroups);
		})
	);
	watchHotkeyChanges(plugin);
}

// Obsidian has no event for hotkey changes, so watch the methods that change
// them: setting or removing a hotkey, and reloading hotkeys.json (e.g. after sync).
type HotkeyMethod = (...args: unknown[]) => unknown;
const WATCHED_HOTKEY_METHODS = ["setHotkeys", "removeHotkeys", "load"] as const;

function watchHotkeyChanges(plugin: ObsidianVerticalTabs) {
	const hotkeyManager = plugin.app.hotkeyManager as unknown as
		| Record<string, HotkeyMethod>
		| undefined;
	if (!hotkeyManager) return;
	const notify = () => savedGroupStore.getActions().bumpHotkeyRevision();
	const patches: Record<string, (old: HotkeyMethod) => HotkeyMethod> = {};
	for (const name of WATCHED_HOTKEY_METHODS) {
		if (typeof hotkeyManager[name] !== "function") continue;
		patches[name] = (old) =>
			function (this: unknown, ...args: unknown[]) {
				const result = old.apply(this, args);
				if (result instanceof Promise) void result.then(notify, notify);
				else notify();
				return result;
			};
	}
	plugin.register(around(hotkeyManager, patches));
}

// Obsidian prefixes command IDs with the plugin ID.
const fullCommandID = (savedGroupID: SavedGroupID) => `vertical-tabs:${commandID(savedGroupID)}`;

// The assigned hotkey, e.g. "⌘ + ⇧ + R", or "" if none (or if Obsidian's
// internal hotkey manager is not available).
export function getSavedGroupHotkey(app: App, savedGroupID: SavedGroupID): string {
	try {
		return app.hotkeyManager.printHotkeyForCommand(fullCommandID(savedGroupID)) ?? "";
	} catch {
		return "";
	}
}

// Opens Settings → Hotkeys filtered to the group's command.
export function openSavedGroupHotkeySettings(app: App, savedGroup: SavedGroup) {
	app.setting.open();
	app.setting.openTabById("hotkeys");
	// The filter uses Obsidian internals; if they change, the tab still opens unfiltered.
	try {
		const tab = app.setting.activeTab as unknown as {
			searchComponent?: { inputEl: HTMLInputElement; setValue(value: string): void };
		} | null;
		const search = tab?.searchComponent;
		if (!search) return;
		search.setValue(commandName(savedGroup.name));
		// setValue does not notify listeners; an input event applies the filter.
		search.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
	} catch {
		// Ignore: unfiltered is fine.
	}
}

export function getSetHotkeyTitle(app: App, savedGroupID: SavedGroupID): string {
	const hotkey = getSavedGroupHotkey(app, savedGroupID);
	return hotkey ? `Change hotkey (${hotkey})` : "Set hotkey...";
}
