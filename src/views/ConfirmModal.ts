import { App, Modal, Setting } from "obsidian";

interface ConfirmModalOptions {
	title: string;
	message: string;
	items?: string[];
	confirmText: string;
	cancelText?: string;
	// Destructive actions get a red button; others the accent color.
	isDestructive?: boolean;
	onConfirm: () => void;
}

export class ConfirmModal extends Modal {
	private options: ConfirmModalOptions;

	constructor(app: App, options: ConfirmModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen() {
		const { titleEl, contentEl } = this;
		const { title, message, items, confirmText, onConfirm } = this.options;
		const isDestructive = this.options.isDestructive ?? true;
		titleEl.setText(title);
		contentEl.createEl("p", { text: message });
		if (items && items.length > 0) {
			const list = contentEl.createEl("ul");
			items.forEach((item) => list.createEl("li", { text: item }));
		}
		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(confirmText).onClick(() => {
					this.close();
					onConfirm();
				});
				if (isDestructive) button.setWarning();
				else button.setCta();
			})
			.addButton((button) =>
				button
					.setButtonText(this.options.cancelText ?? "Cancel")
					.onClick(() => this.close())
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
