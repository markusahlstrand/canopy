---
"@canopy/scope-drive": minor
"@canopy/drive-vertical": minor
---

Every space now has a to-do list and a calendar, under Tasks and Calendar in the sidebar. Tasks is one shared list per space: add a task with an optional due date, tick it off, open it to change the title, date or notes, or delete it. Open tasks come first, soonest due first, with overdue dates flagged; "Show completed" adds the ones finished most recently, and the list records who ticked each one off and when. Calendar shows a month, Monday first, with the space's events and the open tasks due on each day. A task is not copied into the calendar: it appears on its due date, so changing the date in the list moves it there too. Events are all-day (on dates, the same for everyone) or timed (stored as instants with the zone they were planned in, shown in each viewer's own time), with a location and notes.

Anyone who reads the space reads its tasks and calendar; editors and owners change them, and a folder share reaches neither. Every change names the revision it was made against, so when two people edit the same task or event the second is refused and the view reads the latest instead of overwriting. Both are new entities in the space's own database (migration 0021), shaped after JSCalendar (RFC 8984) so an iCal export later is a projection. Like every drive operation they are also tools for the assistant over MCP. Recurrence, participants, resources and links to files and people come in later slices.
