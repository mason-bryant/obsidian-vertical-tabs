import { useMemo } from "react";
import { useApp } from "src/models/PluginContext";
import { SavedGroupID } from "src/models/SavedGroup";
import { savedGroupStore } from "src/stores/SavedGroupStore";
import { getSavedGroupHotkey } from "src/services/SavedGroupCommands";

// The hotkey assigned to a saved group, if any.
export const SavedGroupHotkey = (props: { savedGroupID: SavedGroupID }) => {
	const app = useApp();
	const revision = savedGroupStore((state) => state.hotkeyRevision);
	const hotkey = useMemo(
		() => getSavedGroupHotkey(app, props.savedGroupID),
		[app, props.savedGroupID, revision]
	);
	if (!hotkey) return null;
	return (
		<span className="vt-saved-group-hotkey" aria-label={`Hotkey: ${hotkey}`}>
			{hotkey}
		</span>
	);
};
