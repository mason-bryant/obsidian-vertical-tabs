import { Platform } from "obsidian";

interface Rectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ElectronDisplay {
	workArea: Rectangle;
}

type ElectronWindow = Window & {
	require?(module: string): unknown;
};

// Work areas of all connected displays, in global screen coordinates.
// Null when they cannot be determined (e.g. on mobile).
function getDisplayWorkAreas(): Rectangle[] | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const electronWindow = window as ElectronWindow;
		const electron = electronWindow.require?.("electron") as
			| { remote?: { screen?: { getAllDisplays(): ElectronDisplay[] } } }
			| undefined;
		const displays = electron?.remote?.screen?.getAllDisplays();
		return displays ? displays.map((display) => display.workArea) : null;
	} catch {
		return null;
	}
}

// Whether enough of a window placed at this point would be visible to grab it,
// i.e. the monitor it was on is still connected.
export function isPointOnScreen(x: number, y: number): boolean {
	const workAreas = getDisplayWorkAreas();
	if (!workAreas) return true;
	const MARGIN = 40;
	return workAreas.some(
		(area) =>
			x + MARGIN >= area.x &&
			x + MARGIN <= area.x + area.width &&
			y + MARGIN >= area.y &&
			y + MARGIN <= area.y + area.height
	);
}
