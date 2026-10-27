export const MAX_HISTORY_TURNS = 400
export const MAX_HISTORY_ITEMS_PER_TURN = 500
export const MAX_HISTORY_TEXT = 20_000
// The Swift transport rejects frames above 8 MiB. Reserve 2 MiB for the wire
// response envelope and JSON framing so every accepted history result remains
// deliverable instead of repeatedly failing as one oversized all-or-nothing page.
export const MAX_HISTORY_RESPONSE_BYTES = 6 * 1024 * 1024
export const MAX_HISTORY_PAGE_BYTES = 256 * 1024
export const MAX_HISTORY_SNAPSHOT_BYTES = 256 * 1024 * 1024
export const MAX_HISTORY_PREVIEW_BYTES = 16 * 1024
export const MAX_HISTORY_PREVIEW_TURNS = 2
export const MAX_HISTORY_PREVIEW_ITEMS = 2
export const MAX_HISTORY_PREVIEW_TEXT_BYTES = 1_024
