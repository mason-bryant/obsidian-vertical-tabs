import { App, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import { SavedGroup } from "src/models/SavedGroup";
import { savedGroupStore } from "src/stores/SavedGroupStore";

export class SavedGroupSuggestModal extends FuzzySuggestModal<SavedGroup> {
	private onChoose: (savedGroup: SavedGroup) => void;

	constructor(app: App, onChoose: (savedGroup: SavedGroup) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Open a saved tab group...");
		this.emptyStateText = "No saved tab groups.";
	}

	getItems(): SavedGroup[] {
		return Object.values(savedGroupStore.getState().savedGroups).sort(
			(a, b) => a.name.localeCompare(b.name)
		);
	}

	getItemText(savedGroup: SavedGroup): string {
		return savedGroup.name;
	}

	renderSuggestion(match: FuzzyMatch<SavedGroup>, el: HTMLElement) {
		super.renderSuggestion(match, el);
		const savedGroup = match.item;
		const isOpen = !!savedGroupStore.getState().openGroups[savedGroup.id];
		const count = savedGroup.tabs.length;
		const details = `${count} ${count === 1 ? "tab" : "tabs"}`;
		el.createDiv({
			cls: "vt-saved-group-suggestion-note",
			text: isOpen ? `${details} · open` : details,
		});
	}

	onChooseItem(savedGroup: SavedGroup) {
		this.onChoose(savedGroup);
	}
}
