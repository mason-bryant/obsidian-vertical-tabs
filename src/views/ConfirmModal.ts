import { App, Modal, Setting } from "obsidian";

interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText: string;
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
		const { title, message, confirmText, onConfirm } = this.options;
		titleEl.setText(title);
		contentEl.createEl("p", { text: message });
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						onConfirm();
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
