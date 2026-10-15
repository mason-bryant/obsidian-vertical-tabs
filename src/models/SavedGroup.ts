// Saved tab groups are stored as notes in the vault so that they sync with
// the vault and can be shared. This module holds the pure (Obsidian-free)
// parts: the data model, parsing the tab list, and merging concurrent edits.

export type SavedGroupID = string;

export const SAVED_GROUP_ID_KEY = "vertical-tabs-id";
export const SAVED_GROUP_COLOR_KEY = "vertical-tabs-color";
export const SAVED_GROUP_ICON_KEY = "vertical-tabs-icon";
export const SAVED_GROUP_WINDOW_KEY = "vertical-tabs-window";
export const SAVED_GROUP_NAME_KEY = "vertical-tabs-name";
export const DEFAULT_SAVED_GROUPS_FOLDER = "Vertical Tab Groups";
export const DEFAULT_RECENTLY_CLOSED_LIMIT = 20;

export type SavedTabKind = "file" | "url" | "unresolved";

export interface SavedTab {
	key: string;
	kind: SavedTabKind;
	// File path, URL, or the link path of a link that does not resolve (yet).
	target: string;
	title?: string;
	pinned?: boolean;
	// The original markdown line, so entries we did not touch are written back verbatim.
	line?: string;
}

// What this device last synced for a tab: which tab, its position, and whether it was pinned.
export interface TabState {
	key: string;
	pinned: boolean;
}

export const toTabStates = (tabs: SavedTab[]): TabState[] =>
	tabs.map((tab) => ({ key: tab.key, pinned: !!tab.pinned }));

export function haveSameTabs(a: TabState[], b: TabState[]): boolean {
	return (
		a.length === b.length &&
		a.every((tab, index) => tab.key === b[index]?.key && tab.pinned === b[index]?.pinned)
	);
}

// Whether a saved group opens in the main window or in its own window.
// Shared through the note, so every device opens it the same way.
export type SavedGroupWindow = "main" | "popout";

export function parseSavedGroupWindow(value: unknown): SavedGroupWindow | undefined {
	return value === "main" || value === "popout" ? value : undefined;
}

export interface SavedGroup {
	id: SavedGroupID;
	path: string;
	name: string;
	// The exact name, stored in the note when the file name cannot hold it
	// (punctuation such as ":" or "/", or a numbered duplicate).
	noteName?: string;
	color?: string;
	icon?: string;
	window?: SavedGroupWindow;
	tabs: SavedTab[];
	// Most recent first.
	recentlyClosed: SavedTab[];
}

// Size and position of the window a saved group was last in on this device.
export interface SavedGroupPlacement {
	popout: boolean;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export function isSamePlacement(a?: SavedGroupPlacement, b?: SavedGroupPlacement) {
	return (
		a?.popout === b?.popout &&
		a?.x === b?.x &&
		a?.y === b?.y &&
		a?.width === b?.width &&
		a?.height === b?.height
	);
}

export type ParsedLink =
	| { type: "internal"; linkpath: string }
	| { type: "url"; url: string; title?: string };

// The web viewer normalizes URLs (e.g. adds a trailing slash), so compare normalized URLs.
export function normalizeURL(url: string): string {
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
}

export const fileTabKey = (path: string) => `file:${path}`;
export const urlTabKey = (url: string) => `url:${normalizeURL(url)}`;
export const unresolvedTabKey = (linkpath: string) => `link:${linkpath}`;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*)$/;
const WIKI_LINK = /!?\[\[([^\]]+)\]\]/;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/i;
const BARE_URL = /\bhttps?:\/\/[^\s<>()]+/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WEB_URL = /^https?:\/\//i;

function stripSubpath(linkpath: string): string {
	const index = linkpath.indexOf("#");
	return (index === -1 ? linkpath : linkpath.slice(0, index)).trim();
}

function safeDecodeURI(value: string): string {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
}

// Returns the link of a list item line, or null if the line is not a list item with a link.
export function parseListItemLink(line: string): ParsedLink | null {
	const item = LIST_ITEM.exec(line.replace(/\r$/, ""));
	if (!item) return null;
	const text = item[1] ?? "";

	const wikiLink = WIKI_LINK.exec(text);
	if (wikiLink) {
		const inner = wikiLink[1] ?? "";
		const linkpath = stripSubpath(inner.split("|")[0] ?? "");
		return linkpath ? { type: "internal", linkpath } : null;
	}

	const markdownLink = MARKDOWN_LINK.exec(text);
	if (markdownLink) {
		const title = (markdownLink[1] ?? "").trim() || undefined;
		const target = (markdownLink[2] ?? "").replace(/^<|>$/g, "").trim();
		if (URL_SCHEME.test(target)) {
			return WEB_URL.test(target) ? { type: "url", url: target, title } : null;
		}
		const linkpath = stripSubpath(safeDecodeURI(target));
		return linkpath ? { type: "internal", linkpath } : null;
	}

	const url = AUTOLINK.exec(text)?.[1] ?? BARE_URL.exec(text)?.[0];
	return url ? { type: "url", url } : null;
}

// Pinned tabs are marked with a pin right after the list marker: "- 📌 [[Note]]".
export const PIN_MARKER = "📌";
const LIST_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)/;
const PINNED_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)📌\uFE0F?\s*/;

export function isPinnedLine(line: string): boolean {
	return PINNED_PREFIX.test(line);
}

export function setPinnedInLine(line: string, pinned: boolean): string {
	const unpinned = line.replace(PINNED_PREFIX, "$1");
	if (!pinned) return unpinned;
	const prefix = LIST_PREFIX.exec(unpinned)?.[1];
	return prefix === undefined
		? unpinned
		: `${prefix}${PIN_MARKER} ${unpinned.slice(prefix.length)}`;
}

export function dedupeTabs(tabs: SavedTab[]): SavedTab[] {
	const seen = new Set<string>();
	return tabs.filter((tab) => {
		if (seen.has(tab.key)) return false;
		seen.add(tab.key);
		return true;
	});
}

// Three-way merge of a tab list.
// `base` is what this device last synced, `local` is what the group has now, and
// `remote` is what the note currently contains (possibly edited elsewhere since).
// - Tabs open here keep this device's order, minus tabs removed in the note since.
// - Entries only in the note (added elsewhere, or that cannot open here, like a
//   missing note) keep their place after the entry that precedes them in the note.
// - Entries closed here are removed.
// - A pin or unpin made here wins; otherwise the note's pinned state is kept.
export function mergeTabs(
	base: TabState[],
	local: SavedTab[],
	remote: SavedTab[]
): SavedTab[] {
	const basePinned = new Map(base.map((tab) => [tab.key, tab.pinned]));
	const localKeys = new Set(local.map((tab) => tab.key));
	const remoteByKey = new Map(remote.map((tab) => [tab.key, tab]));

	const result: SavedTab[] = local
		.filter((tab) => !basePinned.has(tab.key) || remoteByKey.has(tab.key))
		.map((tab) => {
			const remoteTab = remoteByKey.get(tab.key);
			const pinnedAtBase = basePinned.get(tab.key);
			if (!remoteTab || pinnedAtBase === undefined) return tab;
			const pinnedHere = !!tab.pinned !== pinnedAtBase;
			return pinnedHere ? tab : { ...tab, pinned: !!remoteTab.pinned };
		});

	remote.forEach((tab, index) => {
		if (localKeys.has(tab.key) || basePinned.has(tab.key)) return;
		let insertAt = 0;
		for (let i = index - 1; i >= 0; i--) {
			const previousKey = remote[i]?.key;
			const position = result.findIndex((t) => t.key === previousKey);
			if (position !== -1) {
				insertAt = position + 1;
				break;
			}
		}
		result.splice(insertAt, 0, tab);
	});

	return dedupeTabs(result);
}

// Recently closed tabs live in their own section after the tab list.
export const RECENTLY_CLOSED_HEADING = "## Recently closed";
const RECENTLY_CLOSED_HEADING_LINE = /^#{1,6}\s+recently closed\s*$/i;
const HEADING_LINE = /^#{1,6}\s/;

// Splits a note body into the tab list part, the "Recently closed" section
// (its lines up to the next heading), and whatever follows that section.
export function splitRecentlyClosed(body: string) {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => RECENTLY_CLOSED_HEADING_LINE.test(line.trim()));
	if (start === -1) return { tabs: body, recent: [] as string[], rest: null };
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (HEADING_LINE.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	return {
		tabs: lines.slice(0, start).join("\n"),
		recent: lines.slice(start + 1, end),
		rest: lines.slice(end).join("\n"),
	};
}

// Adds newly closed tabs (most recent first) to the list, drops entries that
// are open again or forgotten, removes duplicates, and keeps at most `limit`.
export function updateRecentlyClosed(
	current: SavedTab[],
	closed: SavedTab[],
	removeKeys: Set<string>,
	limit: number
): SavedTab[] {
	return dedupeTabs([...closed, ...current])
		.filter((tab) => !removeKeys.has(tab.key))
		.slice(0, Math.max(0, limit));
}

// Replaces the "Recently closed" section with new lines, adding it after the
// tab list if needed, or removing it when there is nothing to list.
export function replaceRecentlyClosedList(body: string, lines: string[]): string {
	const { tabs, rest } = splitRecentlyClosed(body);
	const parts = [tabs.replace(/\s+$/, "")];
	if (lines.length > 0) parts.push(`${RECENTLY_CLOSED_HEADING}\n${lines.join("\n")}`);
	if (rest) parts.push(rest.trim());
	const joined = parts.filter(Boolean).join("\n\n");
	return joined ? `${joined}\n` : "";
}

// Replaces the block of tab list items in a note body with new lines,
// keeping any text before and after the list.
export function replaceTabList(body: string, lines: string[]): string {
	const bodyLines = body.split("\n");
	const start = bodyLines.findIndex((line) =>
		RECENTLY_CLOSED_HEADING_LINE.test(line.trim())
	);
	if (start === -1) return replaceTabListIn(body, lines);
	const head = replaceTabListIn(bodyLines.slice(0, start).join("\n"), lines).replace(/\s+$/, "");
	const section = bodyLines.slice(start).join("\n");
	return head ? `${head}\n\n${section}` : section;
}

function replaceTabListIn(body: string, lines: string[]): string {
	const bodyLines = body.split("\n");
	const isTabLine = (line: string) => parseListItemLink(line) !== null;
	const first = bodyLines.findIndex(isTabLine);
	if (first === -1) {
		const text = body.replace(/\s+$/, "");
		if (lines.length === 0) return text ? `${text}\n` : "";
		return `${text ? `${text}\n\n` : ""}${lines.join("\n")}\n`;
	}
	let last = first;
	bodyLines.forEach((line, index) => {
		if (isTabLine(line)) last = index;
	});
	return [
		...bodyLines.slice(0, first),
		...lines,
		...bodyLines.slice(last + 1),
	].join("\n");
}

// Characters that are invalid in file names or that break wiki links.
const INVALID_NAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

// The file name (without extension) used for a group name.
export function fileNameForGroup(name: string, fallback: string): string {
	return sanitizeGroupName(name) || fallback;
}

// The name to show: the exact name stored in the note, unless the file was
// renamed since (e.g. in the file explorer), in which case the file name wins.
export function resolveGroupName(
	noteName: string | undefined,
	basename: string,
	fallback: string
): string {
	if (!noteName) return basename;
	const base = fileNameForGroup(noteName, fallback);
	if (basename === base) return noteName;
	const suffix = basename.startsWith(`${base} `) ? basename.slice(base.length + 1) : "";
	return /^\d+$/.test(suffix) ? noteName : basename;
}

export function sanitizeGroupName(name: string): string {
	return name
		.replace(INVALID_NAME_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.trim();
}
