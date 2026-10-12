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

export type SavedTabKind = "file" | "url" | "unresolved";

export interface SavedTab {
	key: string;
	kind: SavedTabKind;
	// File path, URL, or the link path of a link that does not resolve (yet).
	target: string;
	title?: string;
	// The original markdown line, so entries we did not touch are written back verbatim.
	line?: string;
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

export function dedupeTabs(tabs: SavedTab[]): SavedTab[] {
	const seen = new Set<string>();
	return tabs.filter((tab) => {
		if (seen.has(tab.key)) return false;
		seen.add(tab.key);
		return true;
	});
}

export function haveSameKeys(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((key, index) => key === b[index]);
}

// Three-way merge of a tab list.
// `base` is the list of keys this device last synced, `local` is what the group
// has now, and `remote` is what the note currently contains (possibly edited
// by someone else in the meantime). Local additions and removals are applied
// on top of the remote list, so remote edits are not lost.
export function mergeTabs(
	base: string[],
	local: SavedTab[],
	remote: SavedTab[]
): SavedTab[] {
	const remoteKeys = remote.map((tab) => tab.key);
	if (haveSameKeys(remoteKeys, base)) return dedupeTabs(local);

	const baseKeys = new Set(base);
	const localKeys = new Set(local.map((tab) => tab.key));
	const removedLocally = new Set(base.filter((key) => !localKeys.has(key)));
	const result = remote.filter((tab) => !removedLocally.has(tab.key));

	local.forEach((tab, index) => {
		if (baseKeys.has(tab.key)) return;
		if (result.some((existing) => existing.key === tab.key)) return;
		let insertAt = 0;
		for (let i = index - 1; i >= 0; i--) {
			const previousKey = local[i]?.key;
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

// Replaces the block of tab list items in a note body with new lines,
// keeping any text before and after the list.
export function replaceTabList(body: string, lines: string[]): string {
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
