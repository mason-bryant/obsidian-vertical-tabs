import { App, Modal, Setting, TextComponent } from "obsidian";
import { DEFAULT_GROUP_TITLE } from "src/constants/Predefined";

interface GroupNameModalOptions {
	title?: string;
	value?: string;
	confirmText?: string;
}

export class GroupNameModal extends Modal {
	private groupName: string;
	private onSubmit: (name: string) => void;
	private options: GroupNameModalOptions;

	constructor(
		app: App,
		onSubmit: (name: string) => void,
		options: GroupNameModalOptions = {}
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.options = options;
		this.groupName = options.value ?? "";
	}

	onOpen() {
		const { titleEl, contentEl, containerEl } = this;
		containerEl.addClass("vt-group-name-modal");
		titleEl.setText(this.options.title ?? "Create new tab group");

		const input = new TextComponent(contentEl)
			.setPlaceholder(DEFAULT_GROUP_TITLE)
			.setValue(this.groupName)
			.onChange((value) => (this.groupName = value));
		input.inputEl.addEventListener("keydown", (event) => {
			if (event.isComposing || event.key === "Enter") {
				this.confirm();
			}
		});
		if (this.groupName) window.setTimeout(() => input.inputEl.select());

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.options.confirmText ?? "Confirm")
					.setCta()
					.onClick(this.confirm.bind(this))
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(this.dismiss.bind(this))
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private confirm() {
		this.close();
		this.onSubmit(this.groupName.trim() || DEFAULT_GROUP_TITLE);
	}

	private dismiss() {
		this.close();
	}
}
