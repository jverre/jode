// Shell layout constants. These MUST match ViewManager in the main process so
// the renderer-drawn bordered frame lines up with the native agent pane (which
// is floated 1px inside the frame).

// --- Rail geometry (drives the sidebar width) ---
/** Gap from the window's left edge to the icon squares. */
export const RAIL_INSET = 10
/** Square selector size (X). */
export const ICON_CELL = 44
/** Icon size inside the square (Y) — strictly smaller than ICON_CELL. */
export const ICON_SIZE = 26
/** Sidebar width is DERIVED from the constraints above, never fixed. */
export const SIDEBAR_WIDTH = RAIL_INSET + ICON_CELL

// --- Pane geometry ---
export const TITLEBAR_HEIGHT = 32
export const MARGIN = 12
/** Width of the frame border the pane is inset within. Both pane hosts inset by
 *  this so the frame's border shows as a ring: the desktop native view via
 *  ViewManager.setBounds. */
export const BORDER = 1
// Pane corners are square so the active tab merges into a straight left edge
// (a rounded corner here would create a notch where the tab joins).
export const FRAME_RADIUS = 0

// First item is flush with the pane's top so an active first item merges into
// the pane's top-left corner as one continuous shape.
export const FIRST_ITEM_TOP = TITLEBAR_HEIGHT
