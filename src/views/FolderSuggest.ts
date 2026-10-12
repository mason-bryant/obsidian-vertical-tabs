import { AbstractInputSuggest, App, TFolder } from "obsidian";

// Suggests vault folders for a text input.
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private onChoose: (folder: TFolder) => void;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		onChoose: (folder: TFolder) => void
	) {
		super(app, inputEl);
		this.onChoose = onChoose;
	}

	protected getSuggestions(query: string): TFolder[] {
		const lowerQuery = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((folder) => folder.path.toLowerCase().includes(lowerQuery))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder) {
		this.setValue(folder.path);
		this.onChoose(folder);
		this.close();
	}
}
