import { useStoreWithActions } from "src/models/StoreWithActions";
import { Identifier } from "src/models/VTWorkspace";
import {
	isSamePlacement,
	SavedGroup,
	SavedGroupID,
	SavedGroupPlacement,
	SavedTab,
} from "src/models/SavedGroup";
import { STORAGE_KEYS } from "src/constants/StorageKeys";
import { localStorageService } from "./LocalStorageService";

// Saved groups themselves live in the vault and are shared. Which of them are
// open, and in which tab group, is per device and lives in local storage.
interface SavedGroupState {
	savedGroups: Record<SavedGroupID, SavedGroup>;
	// Tab group ID -> saved group ID. May contain groups that are not open anymore,
	// e.g. groups in another workspace layout, so they reconnect when restored.
	links: Record<Identifier, SavedGroupID>;
	// Saved group ID -> tab group ID, only for groups that are currently open.
	openGroups: Record<SavedGroupID, Identifier>;
	// Saved group ID -> where it was last open on this device, so it reopens there.
	placements: Record<SavedGroupID, SavedGroupPlacement>;
	isListCollapsed: boolean;
	// Bumped when hotkeys change, so hotkey labels re-render.
	hotkeyRevision: number;
	// Tab group ID -> recently closed tabs (most recent first) of groups that
	// are not saved. Saved groups keep theirs in their note.
	recentlyClosed: Record<Identifier, SavedTab[]>;
}

interface SavedGroupActions {
	hydrate: () => void;
	setSavedGroup: (savedGroup: SavedGroup) => void;
	removeSavedGroup: (id: SavedGroupID) => void;
	removeSavedGroupAtPath: (path: string) => void;
	link: (groupID: Identifier, savedGroupID: SavedGroupID) => void;
	unlink: (savedGroupID: SavedGroupID) => void;
	setOpenGroups: (openGroups: Record<SavedGroupID, Identifier>) => void;
	setPlacement: (id: SavedGroupID, placement: SavedGroupPlacement) => void;
	removePlacement: (id: SavedGroupID) => void;
	toggleListCollapsed: () => void;
	bumpHotkeyRevision: () => void;
	setRecentlyClosed: (groupID: Identifier, tabs: SavedTab[]) => void;
	getSavedGroupOf: (groupID: Identifier) => SavedGroup | undefined;
	isGroupSaved: (groupID: Identifier) => boolean;
}

type SavedGroupStore = SavedGroupState & { actions: SavedGroupActions };

const saveLinks = (links: Record<Identifier, SavedGroupID>) =>
	localStorageService.save(STORAGE_KEYS.SAVED_GROUP_LINKS, links);

const savePlacements = (placements: Record<SavedGroupID, SavedGroupPlacement>) =>
	localStorageService.save(STORAGE_KEYS.SAVED_GROUP_PLACEMENTS, placements);

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
	const aKeys = Object.keys(a);
	return (
		aKeys.length === Object.keys(b).length &&
		aKeys.every((key) => a[key] === b[key])
	);
};

export const savedGroupStore = useStoreWithActions<SavedGroupStore>(
	(set, get) => ({
		savedGroups: {},
		links: {},
		openGroups: {},
		placements: {},
		isListCollapsed: false,
		hotkeyRevision: 0,
		recentlyClosed: {},
		actions: {
			hydrate: () => {
				const links =
					localStorageService.load<Record<Identifier, SavedGroupID>>(
						STORAGE_KEYS.SAVED_GROUP_LINKS
					) ?? {};
				const placements =
					localStorageService.load<Record<SavedGroupID, SavedGroupPlacement>>(
						STORAGE_KEYS.SAVED_GROUP_PLACEMENTS
					) ?? {};
				const isListCollapsed =
					localStorageService.load<boolean>(
						STORAGE_KEYS.SAVED_GROUPS_COLLAPSED
					) ?? false;
				set({ links, placements, isListCollapsed });
			},
			setSavedGroup: (savedGroup) => {
				set((state) => {
					const savedGroups = { ...state.savedGroups };
					// The same note may have been indexed under another ID before.
					for (const [id, existing] of Object.entries(savedGroups)) {
						if (existing.path === savedGroup.path) delete savedGroups[id];
					}
					savedGroups[savedGroup.id] = savedGroup;
					return { savedGroups };
				});
			},
			removeSavedGroup: (id) => {
				set((state) => {
					if (!state.savedGroups[id]) return state;
					const savedGroups = { ...state.savedGroups };
					delete savedGroups[id];
					return { savedGroups };
				});
			},
			removeSavedGroupAtPath: (path) => {
				const entry = Object.values(get().savedGroups).find(
					(savedGroup) => savedGroup.path === path
				);
				if (entry) get().actions.removeSavedGroup(entry.id);
			},
			link: (groupID, savedGroupID) => {
				const links = Object.fromEntries(
					Object.entries(get().links).filter(
						([, id]) => id !== savedGroupID
					)
				);
				links[groupID] = savedGroupID;
				saveLinks(links);
				set((state) => ({
					links,
					openGroups: { ...state.openGroups, [savedGroupID]: groupID },
				}));
			},
			unlink: (savedGroupID) => {
				const links = Object.fromEntries(
					Object.entries(get().links).filter(
						([, id]) => id !== savedGroupID
					)
				);
				saveLinks(links);
				set((state) => {
					const openGroups = { ...state.openGroups };
					delete openGroups[savedGroupID];
					return { links, openGroups };
				});
			},
			setOpenGroups: (openGroups) => {
				if (sameRecord(openGroups, get().openGroups)) return;
				set({ openGroups });
			},
			setPlacement: (id, placement) => {
				if (isSamePlacement(get().placements[id], placement)) return;
				const placements = { ...get().placements, [id]: placement };
				savePlacements(placements);
				set({ placements });
			},
			removePlacement: (id) => {
				if (!get().placements[id]) return;
				const placements = { ...get().placements };
				delete placements[id];
				savePlacements(placements);
				set({ placements });
			},
			setRecentlyClosed: (groupID, tabs) =>
				set((state) => {
					const recentlyClosed = { ...state.recentlyClosed };
					if (tabs.length > 0) recentlyClosed[groupID] = tabs;
					else delete recentlyClosed[groupID];
					return { recentlyClosed };
				}),
			bumpHotkeyRevision: () =>
				set((state) => ({ hotkeyRevision: state.hotkeyRevision + 1 })),
			toggleListCollapsed: () => {
				const isListCollapsed = !get().isListCollapsed;
				localStorageService.save(
					STORAGE_KEYS.SAVED_GROUPS_COLLAPSED,
					isListCollapsed
				);
				set({ isListCollapsed });
			},
			getSavedGroupOf: (groupID) => {
				const { links, savedGroups } = get();
				const savedGroupID = links[groupID];
				return savedGroupID ? savedGroups[savedGroupID] : undefined;
			},
			isGroupSaved: (groupID) =>
				!!get().actions.getSavedGroupOf(groupID),
		},
	})
);
