# Quick Chat Selector

A SillyTavern extension that makes switching between a character's chats fast.

## Features

1. **Character editor section** – Adds a collapsible *Chats* section to the character
   management drawer, right after the tags and before the Creator's Notes. It lists
   all chats sorted by last activity, highlights the active one, and switches to a
   chat with a single click. The header has buttons to open SillyTavern's full
   "Manage chat files" dialog and to refresh the list.
2. **Recent chats under cards** – In the character list, the most recent chats are
   shown as a single non-wrapping line of chips under each card (characters and
   groups). Clicking a chip selects that character and opens that chat. The line is
   horizontally scrollable when it overflows.
3. **Chat picker on the favorite star** – Right-click (or long-press on touch) the
   favorite star on a card to open a popup with that character's chats and jump
   straight to one. The star is revealed on card hover; favorited characters always
   show it.

## Settings

Found in **Extensions → Quick Chat Selector**:

- Show chat selector in character editor (default: on)
- Show recent chats under cards in the list (default: on)
- Chat picker on favorite star (default: on)
- Chats shown per card, 1–10 (default: 5)

## Performance notes

Chat lists are fetched from SillyTavern's own `/api/chats/search` endpoint, only for
cards that scroll into view, at most 4 requests at a time, and cached for 60 seconds
(cache is invalidated when chats are created, renamed, deleted or switched). No core
files are modified – everything is injected at runtime.

## Compatibility

SillyTavern 1.18.0 (uses `window.SillyTavern.getContext()`).
