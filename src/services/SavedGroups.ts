import {
	App,
	getFrontMatterInfo,
	ItemView,
	normalizePath,
	Notice,
	parseYaml,
	Platform,
	stringifyYaml,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	WorkspaceParent,
	WorkspaceWindow,
	WorkspaceWindowInitData,
} from "obsidian";
import { nanoid } from "nanoid";
import { around } from "monkey-around";
import ObsidianVerticalTabs from "src/main";
import {
	DEFAULT_SAVED_GROUPS_FOLDER,
	SAVED_GROUP_COLOR_KEY,
	SAVED_GROUP_ICON_KEY,
	SAVED_GROUP_ID_KEY,
	SAVED_GROUP_NAME_KEY,
	SAVED_GROUP_WINDOW_KEY,
	SavedGroup,
	SavedGroupID,
	SavedGroupPlacement,
	SavedGroupWindow,
	SavedTab,
	setPinnedInLine,
	TabState,
	toTabStates,
	dedupeTabs,
	fileTabKey,
	haveSameTabs,
	isPinnedLine,
	mergeTabs,
	parseListItemLink,
	parseSavedGroupWindow,
	resolveGroupName,
	replaceTabList,
	sanitizeGroupName,
	unresolvedTabKey,
	urlTabKey,
} from "src/models/SavedGroup";
import { getGroupType, GroupType, Identifier } from "src/models/VTWorkspace";
import { DEFAULT_GROUP_TITLE } from "src/constants/Predefined";
import { savedGroupStore } from "src/stores/SavedGroupStore";
import { tabCacheStore } from "src/stores/TabCacheStore";
import { managedLeafStore } from "src/stores/ManagedLeafStore";
import { GroupNameModal } from "src/views/GroupNameModal";
import { ConfirmModal } from "src/views/ConfirmModal";
import { SavedGroupSuggestModal } from "src/views/SavedGroupSuggestModal";
import { iterateRootOrFloatingLeaves } from "./GetTabs";
import { makeLeafNonEphemeral } from "./EphemeralTabs";
import { runWithCanSplit } from "./PlatformCanSplit";
import { isPointOnScreen } from "./Displays";
import { useViewState } from "src/models/ViewState";
import { useSettings } from "src/models/PluginContext";

const SYNC_DELAY = 1000;
const REINDEX_DELAY = 500;
const PLACEMENT_INTERVAL = 1000;

type FrontMatter = Record<string, unknown>;

// Notes in the folder without an ID get a temporary one derived from their path.
// A real ID is written to the note the first time it is opened.
const pathID = (path: string): SavedGroupID => `path:${path}`;
export const isPathID = (id: SavedGroupID) => id.startsWith("path:");

const basenameOf = (path: string) =>
	(path.split("/").pop() ?? path).replace(/\.md$/, "");

function mainWindowDebounce(callback: () => void, delay: number) {
	let timer: number | null = null;
	const run = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			callback();
		}, delay);
	};
	run.cancel = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	};
	return run;
}

const isEmptyFolder = (folder: TFolder): boolean =>
	folder.children.every((child) => child instanceof TFolder && isEmptyFolder(child));

function splitFrontMatter(content: string) {
	const info = getFrontMatterInfo(content);
	let frontmatter: FrontMatter = {};
	if (info.exists) {
		try {
			const parsed: unknown = parseYaml(info.frontmatter);
			if (parsed && typeof parsed === "object") {
				frontmatter = parsed as FrontMatter;
			}
		} catch {
			// Malformed frontmatter: treat it as empty.
		}
	}
	const offset = info.contentStart;
	return { frontmatter, offset, body: content.slice(offset) };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatURL(url: string) {
	return /[\s()<>]/.test(url) ? `<${encodeURI(url)}>` : url;
}

function escapeLinkText(text: string) {
	return text.replace(/([[\]])/g, "\\$1");
}

class SavedGroupManager {
	private plugin: ObsidianVerticalTabs | null = null;
	private isReady = false;
	// Tab group ID -> tab keys this device last synced. Used to tell local edits
	// apart from edits made to the note elsewhere.
	private snapshots = new Map<Identifier, TabState[]>();
	// Tab group ID -> whether it was in its own window when last checked. Used
	// to tell when the group was moved on this device.
	private windowModes = new Map<Identifier, boolean>();
	// Tab groups that are being populated from a saved group; not synced yet.
	private restoring = new Set<Identifier>();
	private queue: Promise<void> = Promise.resolve();

	// Obsidian's debounce schedules its timer on the active window. If that is a
	// popout or the settings window and it closes first, the timer never fires and
	// the debouncer stays pending for good. These timers live on the main window.
	private requestSync = mainWindowDebounce(
		() => void this.enqueue(() => this.syncAll()),
		SYNC_DELAY
	);

	private requestReindex = mainWindowDebounce(
		() => void this.enqueue(() => this.indexAll()),
		REINDEX_DELAY
	);

	// The last tab each leaf was serialized as, for while its view is loading.
	private lastKnownTabs = new WeakMap<WorkspaceLeaf, SavedTab>();

	private get app(): App {
		if (!this.plugin) throw new Error("[VerticalTabs] Saved groups not initialized.");
		return this.plugin.app;
	}

	init(plugin: ObsidianVerticalTabs) {
		this.plugin = plugin;
		savedGroupStore.getActions().hydrate();
		plugin.register(() => {
			this.requestSync.cancel();
			this.requestReindex.cancel();
			this.isReady = false;
		});
		this.registerCommands(plugin);
		plugin.app.workspace.onLayoutReady(() => {
			this.registerEvents(plugin);
			void this.enqueue(async () => {
				await this.indexAll();
				this.isReady = true;
				this.refreshOpenGroups();
			});
		});
	}

	reindexSoon() {
		this.requestReindex();
	}

	// Called after the folder setting changed. Offers to move the saved groups
	// left in the previous folder, since they no longer show up otherwise.
	onFolderChanged(previous: string) {
		const next = this.getFolder();
		if (previous === next) return;
		void this.enqueue(() => this.indexAll());
		const files = this.getSavedGroupFilesToMove(previous, next);
		if (files.length === 0) return;
		const count = files.length;
		const noun = count === 1 ? "saved tab group" : "saved tab groups";
		new ConfirmModal(this.app, {
			title: "Move saved tab groups?",
			message: `"${previous}" has ${count} ${noun}. Move ${count === 1 ? "it" : "them"} to "${next}"? Otherwise ${count === 1 ? "it stays" : "they stay"} where ${count === 1 ? "it is" : "they are"} and won't appear until you switch the folder back.`,
			items: files.map((file) => this.getNameOfNote(file)),
			confirmText: "Move",
			cancelText: "Leave them",
			isDestructive: false,
			onConfirm: () => void this.moveSavedGroups(previous, next),
		}).open();
	}

	private getNameOfNote(file: TFile): string {
		const noteName = asString(
			this.app.metadataCache.getFileCache(file)?.frontmatter?.[SAVED_GROUP_NAME_KEY]
		);
		return resolveGroupName(noteName, file.basename, DEFAULT_GROUP_TITLE);
	}

	// Notes under `from`, except those already in the new folder (e.g. when it is a subfolder).
	private getSavedGroupFilesToMove(from: string, to: string): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(`${from}/`))
			.filter((file) => !file.path.startsWith(`${to}/`));
	}

	private moveSavedGroups(from: string, to: string): Promise<void> {
		return this.enqueue(async () => {
			const files = this.getSavedGroupFilesToMove(from, to);
			for (const file of files) {
				// Keep subfolders.
				const relativeFolder = file.parent?.path.slice(from.length) ?? "";
				const folder = await this.ensureFolder(normalizePath(`${to}${relativeFolder}`));
				const path = this.getAvailablePath(folder, file.basename);
				await this.app.fileManager.renameFile(file, path);
			}
			const oldFolder = this.app.vault.getFolderByPath(from);
			if (oldFolder && isEmptyFolder(oldFolder)) {
				await this.app.fileManager.trashFile(oldFolder);
			}
			const noun = files.length === 1 ? "saved tab group" : "saved tab groups";
			new Notice(`Moved ${files.length} ${noun} to "${to}"`);
		});
	}

	/* Folder */

	getFolder(): string {
		const folder = normalizePath(
			this.plugin?.settings.savedGroupsFolder?.trim() ||
				DEFAULT_SAVED_GROUPS_FOLDER
		);
		return folder === "/" ? DEFAULT_SAVED_GROUPS_FOLDER : folder;
	}

	private isSavedGroupPath(path: string) {
		return path.endsWith(".md") && path.startsWith(`${this.getFolder()}/`);
	}

	private async ensureFolder(folder = this.getFolder()): Promise<string> {
		const existing = this.app.vault.getAbstractFileByPath(folder);
		if (!existing) {
			await this.app.vault.createFolder(folder);
		} else if (!(existing instanceof TFolder)) {
			throw new Error(`"${folder}" is not a folder.`);
		}
		return folder;
	}

	private getAvailablePath(folder: string, name: string, currentPath?: string) {
		const base = sanitizeGroupName(name) || DEFAULT_GROUP_TITLE;
		const parent = this.app.vault.getFolderByPath(folder);
		const taken = new Set(
			(parent?.children ?? [])
				.map((child) => child.path.toLowerCase())
				.filter((path) => path !== currentPath?.toLowerCase())
		);
		for (let index = 0; ; index++) {
			const fileName = index === 0 ? base : `${base} ${index}`;
			const path = normalizePath(`${folder}/${fileName}.md`);
			if (!taken.has(path.toLowerCase())) return path;
		}
	}

	/* Reading notes */

	private resolveTabs(body: string, sourcePath: string): SavedTab[] {
		const tabs: SavedTab[] = [];
		for (const line of body.split("\n")) {
			const link = parseListItemLink(line);
			if (!link) continue;
			if (link.type === "url") {
				const { url, title } = link;
				const pinned = isPinnedLine(line);
				tabs.push({ key: urlTabKey(url), kind: "url", target: url, title, pinned, line });
				continue;
			}
			const file = this.app.metadataCache.getFirstLinkpathDest(
				link.linkpath,
				sourcePath
			);
			const pinned = isPinnedLine(line);
			if (file) {
				const target = file.path;
				tabs.push({ key: fileTabKey(target), kind: "file", target, pinned, line });
			} else {
				const target = link.linkpath;
				tabs.push({ key: unresolvedTabKey(target), kind: "unresolved", target, pinned, line });
			}
		}
		return dedupeTabs(tabs);
	}

	private parseSavedGroup(file: TFile, content: string): SavedGroup {
		const { frontmatter, body } = splitFrontMatter(content);
		const noteName = asString(frontmatter[SAVED_GROUP_NAME_KEY]);
		return {
			id: asString(frontmatter[SAVED_GROUP_ID_KEY]) ?? pathID(file.path),
			path: file.path,
			name: resolveGroupName(noteName, file.basename, DEFAULT_GROUP_TITLE),
			noteName,
			color: asString(frontmatter[SAVED_GROUP_COLOR_KEY]),
			icon: asString(frontmatter[SAVED_GROUP_ICON_KEY]),
			window: parseSavedGroupWindow(frontmatter[SAVED_GROUP_WINDOW_KEY]),
			tabs: this.resolveTabs(body, file.path),
		};
	}

	private async readSavedGroup(file: TFile): Promise<SavedGroup> {
		const content = await this.app.vault.cachedRead(file);
		return this.parseSavedGroup(file, content);
	}

	private async indexAll() {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.isSavedGroupPath(file.path))
			.sort((a, b) => a.stat.ctime - b.stat.ctime);
		const savedGroups: Record<SavedGroupID, SavedGroup> = {};
		for (const file of files) {
			const savedGroup = await this.readSavedGroup(file);
			// A copied note shares the ID of the original; the older note keeps it.
			if (savedGroups[savedGroup.id]) savedGroup.id = pathID(file.path);
			savedGroups[savedGroup.id] = savedGroup;
		}
		savedGroupStore.setState({ savedGroups });
		if (this.isReady) this.refreshOpenGroups();
	}

	private async indexFile(file: TFile) {
		const savedGroup = await this.readSavedGroup(file);
		const existing = savedGroupStore.getState().savedGroups[savedGroup.id];
		if (
			existing &&
			existing.path !== file.path &&
			this.app.vault.getFileByPath(existing.path)
		) {
			savedGroup.id = pathID(file.path);
		}
		savedGroupStore.getActions().setSavedGroup(savedGroup);
		this.refreshOpenGroups();
	}

	/* Vault events */

	private registerEvents(plugin: ObsidianVerticalTabs) {
		const { workspace, vault } = this.app;
		plugin.registerEvent(
			workspace.on("layout-change", () => this.onLayoutChange())
		);
		plugin.registerEvent(
			workspace.on("file-open", () => this.onLayoutChange())
		);
		// Pinning a tab does not change the layout, so watch it directly.
		const onPinnedChange = (leaf: WorkspaceLeaf) => this.onPinnedChange(leaf);
		plugin.register(
			around(WorkspaceLeaf.prototype, {
				setPinned(old) {
					return function (this: WorkspaceLeaf, pinned: boolean) {
						const result = old.call(this, pinned);
						onPinnedChange(this);
						return result;
					};
				},
			})
		);
		plugin.registerInterval(
			window.setInterval(() => this.recordPopoutPlacements(), PLACEMENT_INTERVAL)
		);
		plugin.registerEvent(vault.on("create", (file) => this.onFileChange(file)));
		plugin.registerEvent(vault.on("modify", (file) => this.onFileChange(file)));
		plugin.registerEvent(vault.on("delete", (file) => this.onFileDelete(file)));
		plugin.registerEvent(
			vault.on("rename", (file, oldPath) => this.onFileRename(file, oldPath))
		);
	}

	private onPinnedChange(leaf: WorkspaceLeaf) {
		if (!this.isReady || !leaf.parent) return;
		if (savedGroupStore.getActions().isGroupSaved(leaf.parent.id)) this.requestSync();
	}

	private onLayoutChange() {
		if (!this.isReady) return;
		this.refreshOpenGroups();
		this.requestSync();
	}

	private onFileChange(file: TAbstractFile) {
		if (!(file instanceof TFile) || !this.isSavedGroupPath(file.path)) return;
		void this.indexFile(file);
	}

	private onFileDelete(file: TAbstractFile) {
		const { savedGroups, openGroups } = savedGroupStore.getState();
		const deleted = Object.values(savedGroups).filter(
			(savedGroup) =>
				savedGroup.path === file.path ||
				savedGroup.path.startsWith(`${file.path}/`)
		);
		for (const savedGroup of deleted) {
			// Keep the link: a sync tool may delete and re-create the note when it is
			// renamed elsewhere, and the open group should reconnect when it comes back.
			// Until then, the open group keeps its name, color, and icon.
			const groupID = openGroups[savedGroup.id];
			if (groupID) this.copyAppearanceToGroup(groupID, savedGroup);
			savedGroupStore.getActions().removeSavedGroup(savedGroup.id);
		}
		if (deleted.length > 0) this.refreshOpenGroups();
	}

	private onFileRename(file: TAbstractFile, oldPath: string) {
		if (file instanceof TFolder) {
			// Follow the folder (or one of its parents) when it is renamed or moved.
			const folder = this.getFolder();
			if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
				const savedGroupsFolder = file.path + folder.slice(oldPath.length);
				useSettings.getState().setSettings({ savedGroupsFolder });
			}
			this.requestReindex();
			return;
		}
		if (!(file instanceof TFile)) return;
		const actions = savedGroupStore.getActions();
		const isSavedGroup = this.isSavedGroupPath(file.path);
		if (this.isSavedGroupPath(oldPath)) {
			const existing = Object.values(savedGroupStore.getState().savedGroups).find(
				(savedGroup) => savedGroup.path === oldPath
			);
			if (existing && isSavedGroup) {
				const name = resolveGroupName(existing.noteName, file.basename, DEFAULT_GROUP_TITLE);
				actions.setSavedGroup({ ...existing, path: file.path, name });
			} else {
				actions.removeSavedGroupAtPath(oldPath);
			}
		}
		if (isSavedGroup) void this.indexFile(file);
		else this.refreshOpenGroups();
	}

	/* Tab groups */

	private getLiveGroups(): Map<Identifier, WorkspaceParent> {
		const groups = new Map<Identifier, WorkspaceParent>();
		const { isManagedLeaf } = managedLeafStore.getActions();
		iterateRootOrFloatingLeaves(this.app, (leaf) => {
			if (isManagedLeaf(this.app, leaf)) return;
			const group = leaf.parent;
			if (group && !groups.has(group.id)) groups.set(group.id, group);
		});
		return groups;
	}

	private serializeLeaf(leaf: WorkspaceLeaf): SavedTab | null {
		// getViewState also works for deferred (not yet loaded) tabs.
		const viewState = leaf.getViewState();
		const state = viewState.state ?? {};
		const pinned = !!viewState.pinned;
		const remember = (tab: SavedTab) => {
			this.lastKnownTabs.set(leaf, tab);
			return tab;
		};
		// While a tab is loading (e.g. right after a deferred tab is activated),
		// its state briefly has no file or URL. Keep its last known entry, or a
		// sync at that moment would treat the tab as closed.
		const whileLoading = () => {
			const lastKnown = this.lastKnownTabs.get(leaf);
			return lastKnown ? { ...lastKnown, pinned } : null;
		};
		if (viewState.type === "webviewer") {
			const url = state.url;
			if (typeof url !== "string" || !url) return whileLoading();
			if (!/^https?:\/\//i.test(url)) return null;
			const title = leaf.getDisplayText() || undefined;
			return remember({ key: urlTabKey(url), kind: "url", target: url, title, pinned });
		}
		const path = state.file;
		if (typeof path !== "string" || !path) {
			return viewState.type === "empty" ? null : whileLoading();
		}
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		return remember({ key: fileTabKey(file.path), kind: "file", target: file.path, pinned });
	}

	private serializeGroup(group: WorkspaceParent): SavedTab[] {
		const tabs = group.children
			.map((leaf) => this.serializeLeaf(leaf))
			.filter((tab): tab is SavedTab => tab !== null);
		return dedupeTabs(tabs);
	}

	private formatTab(tab: SavedTab, sourcePath: string): string {
		return setPinnedInLine(this.formatTabLink(tab, sourcePath), !!tab.pinned);
	}

	private formatTabLink(tab: SavedTab, sourcePath: string): string {
		if (tab.kind === "url") {
			const url = formatURL(tab.target);
			return tab.title
				? `- [${escapeLinkText(tab.title)}](${url})`
				: `- <${tab.target}>`;
		}
		const file =
			tab.kind === "file" ? this.app.vault.getFileByPath(tab.target) : null;
		if (!file) return tab.line ?? `- [[${tab.target}]]`;
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath);
		return `- ${link.replace(/^!/, "")}`;
	}

	private formatTabs(tabs: SavedTab[], existing: SavedTab[], sourcePath: string) {
		const lines = new Map(existing.map((tab) => [tab.key, tab.line]));
		return tabs.map((tab) => {
			const existingLine = lines.get(tab.key) ?? tab.line;
			const line =
				existingLine !== undefined
					? setPinnedInLine(existingLine, !!tab.pinned)
					: this.formatTab(tab, sourcePath);
			return { ...tab, line };
		});
	}

	// Recomputes which saved groups are open on this device.
	private refreshOpenGroups() {
		const live = this.getLiveGroups();
		const { links } = savedGroupStore.getState();
		const openGroups: Record<SavedGroupID, Identifier> = {};
		for (const [groupID, savedGroupID] of Object.entries(links)) {
			if (live.has(groupID) && !openGroups[savedGroupID]) {
				openGroups[savedGroupID] = groupID;
			}
		}
		for (const groupID of Array.from(this.snapshots.keys())) {
			if (!live.has(groupID)) this.snapshots.delete(groupID);
		}
		for (const groupID of Array.from(this.windowModes.keys())) {
			if (!live.has(groupID)) this.windowModes.delete(groupID);
		}
		// A group seen for the first time (e.g. restored on startup) is taken as-is,
		// so a stale layout on this device does not overwrite newer remote edits.
		for (const groupID of Object.values(openGroups)) {
			const group = live.get(groupID);
			if (!group || this.snapshots.has(groupID) || this.restoring.has(groupID)) {
				continue;
			}
			this.snapshots.set(groupID, toTabStates(this.serializeGroup(group)));
		}
		savedGroupStore.getActions().setOpenGroups(openGroups);
		this.recordPlacements(live, openGroups);
	}

	isInOwnWindow(group: WorkspaceParent): boolean {
		return group.getContainer() instanceof WorkspaceWindow;
	}

	private getPlacement(group: WorkspaceParent): SavedGroupPlacement {
		const container = group.getContainer();
		if (!(container instanceof WorkspaceWindow)) return { popout: false };
		const { screenX, screenY, outerWidth, outerHeight } = container.win;
		return {
			popout: true,
			x: screenX,
			y: screenY,
			width: outerWidth,
			height: outerHeight,
		};
	}

	private recordPlacements(
		live: Map<Identifier, WorkspaceParent>,
		openGroups: Record<SavedGroupID, Identifier>
	) {
		const { setPlacement } = savedGroupStore.getActions();
		for (const [savedGroupID, groupID] of Object.entries(openGroups)) {
			const group = live.get(groupID);
			if (!group || this.restoring.has(groupID)) continue;
			const placement = this.getPlacement(group);
			// Window bounds are per device; whether it is a window at all is shared.
			if (placement.popout) setPlacement(savedGroupID, placement);
			const previous = this.windowModes.get(groupID);
			this.windowModes.set(groupID, placement.popout);
			// A group seen for the first time keeps the note's setting, as with tabs.
			if (previous !== undefined && previous !== placement.popout) {
				void this.setSavedGroupWindow(savedGroupID, placement.popout ? "popout" : "main");
			}
		}
	}

	// Moving a window fires no event, and a closing window is already detached
	// when Obsidian reports it, so the bounds of saved groups in their own
	// windows are checked periodically instead. Only changes are stored.
	private recordPopoutPlacements() {
		if (!this.isReady) return;
		const { getSavedGroupOf, setPlacement } = savedGroupStore.getActions();
		const seen = new Set<Identifier>();
		this.app.workspace.iterateLeaves(this.app.workspace.floatingSplit, (leaf) => {
			const group = leaf.parent;
			if (!group || seen.has(group.id)) return;
			seen.add(group.id);
			const savedGroup = getSavedGroupOf(group.id);
			if (savedGroup) setPlacement(savedGroup.id, this.getPlacement(group));
		});
	}

	private async syncAll() {
		if (!this.isReady) return;
		const live = this.getLiveGroups();
		const { openGroups } = savedGroupStore.getState();
		for (const [savedGroupID, groupID] of Object.entries(openGroups)) {
			const group = live.get(groupID);
			if (group) await this.syncGroup(savedGroupID, group);
		}
	}

	// Writes local changes of an open group to its note.
	private async syncGroup(savedGroupID: SavedGroupID, group: WorkspaceParent) {
		if (this.restoring.has(group.id)) return;
		const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
		if (!savedGroup) return;
		const local = this.serializeGroup(group);
		const localStates = toTabStates(local);
		const base = this.snapshots.get(group.id);
		if (!base) {
			this.snapshots.set(group.id, localStates);
			return;
		}
		if (haveSameTabs(base, localStates)) return;
		const file = this.app.vault.getFileByPath(savedGroup.path);
		if (!file) return;
		this.snapshots.set(group.id, localStates);
		let tabs = savedGroup.tabs;
		await this.app.vault.process(file, (content) => {
			const { offset, body } = splitFrontMatter(content);
			const remote = this.resolveTabs(body, file.path);
			tabs = this.formatTabs(mergeTabs(base, local, remote), remote, file.path);
			if (haveSameTabs(toTabStates(tabs), toTabStates(remote))) return content;
			const lines = tabs.map((tab) => tab.line ?? "");
			return content.slice(0, offset) + replaceTabList(body, lines);
		});
		savedGroupStore.getActions().setSavedGroup({ ...savedGroup, tabs });
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.queue.then(task).catch((error) => {
			console.error("[VerticalTabs] Saved tab groups:", error);
			new Notice(`Vertical Tabs: ${error instanceof Error ? error.message : String(error)}`);
		});
		this.queue = run;
		return run;
	}

	private copyAppearanceToGroup(groupID: Identifier, savedGroup: SavedGroup) {
		void tabCacheStore.getActions().saveGroupMetadata(groupID, {
			title: savedGroup.name,
			color: savedGroup.color,
			icon: savedGroup.icon,
		});
	}

	// Tabs of a saved group must not be auto-closed as ephemeral tabs, including
	// after a restart, so their non-ephemeral state is also remembered.
	private keepTab(leaf: WorkspaceLeaf) {
		makeLeafNonEphemeral(leaf);
		useViewState.getState().rememberNonephemeralTab(this.app, leaf.id);
	}

	/* Actions */

	getCurrentGroup(): WorkspaceParent | null {
		const { workspace } = this.app;
		const isRootGroup = (leaf: WorkspaceLeaf | null | undefined) =>
			!!leaf?.parent &&
			getGroupType(this.app, leaf.parent) === GroupType.RootSplit;
		const active = workspace.getActiveViewOfType(ItemView)?.leaf;
		const leaf = isRootGroup(active) ? active : workspace.getMostRecentLeaf();
		return leaf && isRootGroup(leaf) ? leaf.parent : null;
	}

	promptToSaveGroup(group: WorkspaceParent) {
		const title = tabCacheStore.getState().groupMetadata.get(group.id)?.title;
		new GroupNameModal(this.app, (name) => void this.saveGroup(group, name), {
			title: "Save tab group",
			value: title ?? "",
			confirmText: "Save",
		}).open();
	}

	saveGroup(group: WorkspaceParent, name: string): Promise<void> {
		return this.enqueue(async () => {
			const actions = savedGroupStore.getActions();
			if (actions.isGroupSaved(group.id)) return;
			const folder = await this.ensureFolder();
			const displayName = name.trim() || DEFAULT_GROUP_TITLE;
			const path = this.getAvailablePath(folder, displayName);
			const noteName = basenameOf(path) === displayName ? undefined : displayName;
			const metadata = tabCacheStore.getState().groupMetadata.get(group.id);
			const id = nanoid();
			const frontmatter: FrontMatter = { [SAVED_GROUP_ID_KEY]: id };
			if (noteName) frontmatter[SAVED_GROUP_NAME_KEY] = noteName;
			if (metadata?.color) frontmatter[SAVED_GROUP_COLOR_KEY] = metadata.color;
			if (metadata?.icon) frontmatter[SAVED_GROUP_ICON_KEY] = metadata.icon;
			const isPopout = this.isInOwnWindow(group);
			const window: SavedGroupWindow = isPopout ? "popout" : "main";
			frontmatter[SAVED_GROUP_WINDOW_KEY] = window;
			group.children.forEach((leaf) => this.keepTab(leaf));
			const tabs = this.formatTabs(this.serializeGroup(group), [], path);
			const body = tabs.map((tab) => tab.line).join("\n");
			const content = `---\n${stringifyYaml(frontmatter)}---\n${body}\n`;
			const file = await this.app.vault.create(path, content);
			actions.setSavedGroup({
				id,
				path: file.path,
				name: displayName,
				noteName,
				color: metadata?.color,
				icon: metadata?.icon,
				window,
				tabs,
			});
			actions.link(group.id, id);
			this.snapshots.set(group.id, toTabStates(tabs));
			this.windowModes.set(group.id, isPopout);
			new Notice(`Saved tab group "${displayName}"`);
		});
	}

	openSavedGroup(
		savedGroupID: SavedGroupID,
		options: { window?: SavedGroupWindow; activeKey?: string } = {}
	): Promise<void> {
		return this.enqueue(async () => {
			const { openGroups, savedGroups } = savedGroupStore.getState();
			const openGroup = this.getLiveGroups().get(openGroups[savedGroupID] ?? "");
			if (openGroup) {
				this.focusGroup(openGroup);
				return;
			}
			const savedGroup = savedGroups[savedGroupID];
			const file = savedGroup && this.app.vault.getFileByPath(savedGroup.path);
			if (!savedGroup || !file) return;
			const id = isPathID(savedGroupID)
				? await this.assignID(savedGroup, file)
				: savedGroupID;
			const { frontmatter, body } = splitFrontMatter(await this.app.vault.read(file));
			const tabs = this.resolveTabs(body, file.path);
			const noteWindow = parseSavedGroupWindow(frontmatter[SAVED_GROUP_WINDOW_KEY]);
			const bounds = savedGroupStore.getState().placements[id];
			const window =
				options.window ?? noteWindow ?? (bounds?.popout ? "popout" : "main");
			const canOpenURL = !!this.app.internalPlugins.getEnabledPluginById("webviewer");
			const openable = tabs.filter(
				(tab) => tab.kind === "file" || (tab.kind === "url" && canOpenURL)
			);

			const firstLeaf = this.createLeafInNewGroup(
				window === "popout",
				bounds?.popout ? bounds : undefined
			);
			const group = firstLeaf.parent;
			this.restoring.add(group.id);
			savedGroupStore.getActions().link(group.id, id);
			try {
				for (const [index, tab] of openable.entries()) {
					const leaf =
						index === 0
							? firstLeaf
							: this.app.workspace.createLeafInParent(
									group,
									group.children.length
							  );
					this.keepTab(leaf);
					await this.openTab(leaf, tab);
				}
				this.keepTab(firstLeaf);
			} finally {
				this.restoring.delete(group.id);
				this.snapshots.set(group.id, toTabStates(this.serializeGroup(group)));
				this.windowModes.set(group.id, this.isInOwnWindow(group));
				this.refreshOpenGroups();
			}
			const activeIndex = Math.max(
				0,
				group.children.findIndex(
					(leaf) => this.serializeLeaf(leaf)?.key === options.activeKey
				)
			);
			group.selectTabIndex(activeIndex);
			const activeLeaf = group.children[activeIndex] ?? firstLeaf;
			this.app.workspace.setActiveLeaf(activeLeaf, { focus: true });
			// Record an explicit move, and the window of notes saved before it was shared.
			// Mobile cannot open windows, so it does not change the setting.
			if (Platform.isDesktopApp && window !== noteWindow) {
				void this.setSavedGroupWindow(id, window);
			}

			const missing = tabs.filter((tab) => tab.kind === "unresolved").length;
			const webTabs = tabs.filter((tab) => tab.kind === "url").length;
			const reasons = [
				missing > 0 ? `${missing} linked ${missing === 1 ? "note was" : "notes were"} not found` : "",
				webTabs > 0 && !canOpenURL ? `${webTabs} web ${webTabs === 1 ? "page needs" : "pages need"} the Web viewer core plugin` : "",
			].filter(Boolean);
			if (reasons.length > 0) {
				new Notice(`"${savedGroup.name}": ${reasons.join("; ")}. They stay in the saved group.`);
			}
		});
	}

	private async openTab(leaf: WorkspaceLeaf, tab: SavedTab) {
		await this.openTabContent(leaf, tab);
		if (tab.pinned) leaf.setPinned(true);
	}

	private async openTabContent(leaf: WorkspaceLeaf, tab: SavedTab) {
		if (tab.kind === "file") {
			const file = this.app.vault.getFileByPath(tab.target);
			// No open state, so that tab deduplication does not redirect the file.
			if (file) await leaf.openFile(file);
		} else if (tab.kind === "url") {
			await leaf.setViewState({
				type: "webviewer",
				state: { url: tab.target, navigate: true },
			});
		}
	}

	// Opens a group in its own window, at its last size and position on this
	// device if known. Otherwise reuses the only group in the main window if it
	// just holds empty tabs, e.g. right after startup, or splits off a new group.
	private createLeafInNewGroup(
		popout: boolean,
		bounds?: SavedGroupPlacement
	): WorkspaceLeaf {
		const { workspace } = this.app;
		if (popout && Platform.isDesktopApp) {
			const { x, y, width, height } = bounds ?? {};
			const data: WorkspaceWindowInitData = {};
			// Screen coordinates span all monitors, so this also restores the monitor.
			// If that monitor is gone, let Obsidian pick a position.
			if (x !== undefined && y !== undefined && isPointOnScreen(x, y)) {
				data.x = x;
				data.y = y;
			}
			if (width && height) data.size = { width, height };
			return workspace.openPopoutLeaf(data);
		}
		const groups = new Map<Identifier, WorkspaceParent>();
		workspace.iterateLeaves(workspace.rootSplit, (leaf) => {
			groups.set(leaf.parent.id, leaf.parent);
		});
		const [onlyGroup] = groups.size === 1 ? Array.from(groups.values()) : [];
		if (
			onlyGroup &&
			!savedGroupStore.getActions().isGroupSaved(onlyGroup.id) &&
			onlyGroup.children.every((leaf) => leaf.view.getViewType() === "empty")
		) {
			const [first, ...rest] = onlyGroup.children;
			rest.forEach((leaf) => leaf.detach());
			if (first) return first;
		}
		// Split off the main window even when the focus is in a popout window.
		const anchor = workspace.getMostRecentLeaf(workspace.rootSplit);
		return runWithCanSplit(() =>
			anchor
				? workspace.createLeafBySplit(anchor, "vertical")
				: workspace.getLeaf("split")
		);
	}

	private focusGroup(group: WorkspaceParent) {
		const leaf = group.children[group.currentTab] ?? group.children[0];
		if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private async assignID(savedGroup: SavedGroup, file: TFile): Promise<SavedGroupID> {
		const id = nanoid();
		await this.app.fileManager.processFrontMatter(file, (frontmatter: FrontMatter) => {
			frontmatter[SAVED_GROUP_ID_KEY] = id;
		});
		savedGroupStore.getActions().setSavedGroup({ ...savedGroup, id });
		return id;
	}

	async closeGroup(group: WorkspaceParent) {
		const savedGroup = savedGroupStore.getActions().getSavedGroupOf(group.id);
		if (savedGroup) {
			const placement = this.getPlacement(group);
			if (placement.popout) {
				savedGroupStore.getActions().setPlacement(savedGroup.id, placement);
			}
			await this.enqueue(() => this.syncGroup(savedGroup.id, group));
		}
		this.snapshots.delete(group.id);
		group.detach();
	}

	// Moves an open saved group to its own window or back to the main window.
	// The tabs are reopened there, and every device opens the group there from now on.
	async moveSavedGroup(group: WorkspaceParent, window: SavedGroupWindow) {
		const savedGroup = savedGroupStore.getActions().getSavedGroupOf(group.id);
		if (!savedGroup) return;
		const activeLeaf = group.children[group.currentTab];
		const activeKey = activeLeaf ? this.serializeLeaf(activeLeaf)?.key : undefined;
		await this.closeGroup(group);
		await this.openSavedGroup(savedGroup.id, { window, activeKey });
	}

	deleteSavedGroup(savedGroupID: SavedGroupID): Promise<void> {
		return this.enqueue(async () => {
			const { savedGroups, openGroups } = savedGroupStore.getState();
			const savedGroup = savedGroups[savedGroupID];
			if (!savedGroup) return;
			const groupID = openGroups[savedGroupID];
			if (groupID) {
				this.copyAppearanceToGroup(groupID, savedGroup);
				this.snapshots.delete(groupID);
			}
			const actions = savedGroupStore.getActions();
			actions.unlink(savedGroupID);
			actions.removeSavedGroup(savedGroupID);
			actions.removePlacement(savedGroupID);
			const file = this.app.vault.getFileByPath(savedGroup.path);
			if (file) await this.app.fileManager.trashFile(file);
			new Notice(`Deleted saved tab group "${savedGroup.name}"`);
		});
	}

	confirmDeleteSavedGroup(savedGroupID: SavedGroupID) {
		const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
		if (!savedGroup) return;
		const isOpen = !!savedGroupStore.getState().openGroups[savedGroupID];
		const listFile = `"${savedGroup.path}"`;
		const message = isOpen
			? `"${savedGroup.name}" will no longer be saved. Its tabs stay open, and the notes in it are not changed. Only the group's list, ${listFile}, is moved to the trash, which removes the saved group for everyone who shares this vault.`
			: `"${savedGroup.name}" will be removed from your saved groups. The notes in it are not changed. Only the group's list, ${listFile}, is moved to the trash, which removes the saved group for everyone who shares this vault.`;
		new ConfirmModal(this.app, {
			title: "Delete saved tab group?",
			message,
			confirmText: "Delete",
			onConfirm: () => void this.deleteSavedGroup(savedGroupID),
		}).open();
	}

	promptToRenameSavedGroup(savedGroupID: SavedGroupID) {
		const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
		if (!savedGroup) return;
		new GroupNameModal(
			this.app,
			(name) => void this.renameSavedGroup(savedGroupID, name),
			{ title: "Rename saved tab group", value: savedGroup.name, confirmText: "Rename" }
		).open();
	}

	renameSavedGroup(savedGroupID: SavedGroupID, name: string): Promise<void> {
		return this.enqueue(async () => {
			const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
			const file = savedGroup && this.app.vault.getFileByPath(savedGroup.path);
			const displayName = name.trim();
			if (!savedGroup || !file || !displayName) return;
			const folder = file.parent?.path ?? this.getFolder();
			const path = this.getAvailablePath(folder, displayName, file.path);
			const noteName = basenameOf(path) === displayName ? undefined : displayName;
			savedGroupStore
				.getActions()
				.setSavedGroup({ ...savedGroup, name: displayName, noteName });
			if (noteName !== savedGroup.noteName) {
				await this.app.fileManager.processFrontMatter(file, (frontmatter: FrontMatter) => {
					if (noteName) frontmatter[SAVED_GROUP_NAME_KEY] = noteName;
					else delete frontmatter[SAVED_GROUP_NAME_KEY];
				});
			}
			if (path !== file.path) await this.app.fileManager.renameFile(file, path);
		});
	}

	setSavedGroupColor(savedGroupID: SavedGroupID, color?: string) {
		return this.updateAppearance(savedGroupID, "color", color);
	}

	setSavedGroupIcon(savedGroupID: SavedGroupID, icon?: string) {
		return this.updateAppearance(savedGroupID, "icon", icon);
	}

	private setSavedGroupWindow(savedGroupID: SavedGroupID, window: SavedGroupWindow) {
		const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
		if (savedGroup?.window === window) return Promise.resolve();
		return this.updateAppearance(savedGroupID, "window", window);
	}

	private updateAppearance(
		savedGroupID: SavedGroupID,
		property: "color" | "icon" | "window",
		value: string | undefined
	): Promise<void> {
		const keys = {
			color: SAVED_GROUP_COLOR_KEY,
			icon: SAVED_GROUP_ICON_KEY,
			window: SAVED_GROUP_WINDOW_KEY,
		};
		const key = keys[property];
		return this.enqueue(async () => {
			const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
			const file = savedGroup && this.app.vault.getFileByPath(savedGroup.path);
			if (!savedGroup || !file) return;
			savedGroupStore.getActions().setSavedGroup({ ...savedGroup, [property]: value });
			await this.app.fileManager.processFrontMatter(file, (frontmatter: FrontMatter) => {
				if (value) frontmatter[key] = value;
				else delete frontmatter[key];
			});
		});
	}

	revealSavedGroupNote(savedGroupID: SavedGroupID) {
		const savedGroup = savedGroupStore.getState().savedGroups[savedGroupID];
		const file = savedGroup && this.app.vault.getFileByPath(savedGroup.path);
		const fileExplorer = this.app.internalPlugins.getEnabledPluginById("file-explorer");
		if (file && fileExplorer) fileExplorer.revealInFolder(file);
	}

	/* Commands */

	private registerCommands(plugin: ObsidianVerticalTabs) {
		const { isGroupSaved } = savedGroupStore.getActions();
		plugin.addCommand({
			id: "save-current-group",
			name: "Save current tab group",
			checkCallback: (checking) => {
				const group = this.getCurrentGroup();
				if (!group || isGroupSaved(group.id)) return false;
				if (!checking) this.promptToSaveGroup(group);
				return true;
			},
		});
		plugin.addCommand({
			id: "close-current-saved-group",
			name: "Close current tab group and keep it saved",
			checkCallback: (checking) => {
				const group = this.getCurrentGroup();
				if (!group || !isGroupSaved(group.id)) return false;
				if (!checking) void this.closeGroup(group);
				return true;
			},
		});
		plugin.addCommand({
			id: "open-saved-group",
			name: "Open saved tab group",
			callback: () => {
				new SavedGroupSuggestModal(this.app, (savedGroup) => {
					void this.openSavedGroup(savedGroup.id);
				}).open();
			},
		});
	}
}

export const savedGroupManager = new SavedGroupManager();
