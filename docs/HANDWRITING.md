# Gleaner notation card

Print this or keep it as the first page of your Daily notebook. Gleaner extracts items **only** from these marks
or an explicit commitment ("I'll send…"). Ordinary notes stay notes, so the task list stays clean.

| Write | Means |
|---|---|
| `10/16` in the top corner | Page date. Without it, the notebook's last-modified date is used. |
| `☐ thing` | Action you own |
| `→ Tom: thing` | Follow-up you owe Tom |
| `← Tom: thing` or `WF Tom` | Waiting on Tom |
| `DEC: thing` | Decision made (logged, not nagged) |
| `Q: thing` or circled `?` | Open question |
| `!` in the left margin | Priority |
| `by Fri` · `@10/22` · `EOW` | Due date (relative to the page date) |
| `2pm` · `@2:30` · `Fri 3pm` on an item line | Due time. A time with no date means the page's date. |
| `@Jen thing` · `Jen to …` · `owner: Jen` | Assigned to Jen (shown as waiting on others) |
| `#kite-study` or a circled word | Project tag. Any alias listed in `projects.yaml` (say `#kites` for `kite-study`) is stored as the canonical tag |
| checked box `☑` | That item is done |
| strike through a line | That item is cancelled (a struck line that was never an item creates none) |

Short names work too: if `projects.yaml` lists `Pat` under a person's `write_as`, `→ Pat: …` is stored with the
full name. A first name two people share stays as written and is flagged, so write a short form that tells them apart
(`Alex O`, `Alex T`) when it matters.

## Closing items from the Today sheet

Every open item has a number, which is printed on the `_Today` sheet each morning. Write these on **today's notebook page**,
not on the sheet. The sheet is replaced every morning and its annotations are not read.

| Write | Effect |
|---|---|
| `✓14` · `done 14` | Item 14 done |
| `x14` · `drop 14` | Item 14 dropped |
| `14 → Fri` · `snooze 14 10/23` | Item 14 hidden until then |

Rewriting the same item on a new day is fine. Gleaner links it to the original and counts the days you've carried it.
Moving a line to another page (lasso, or cut and paste) keeps its number too, as long as it's on the new page by the
next sync (within a few hours). Erasing a line drops its task; writing it back within those few hours brings the same
task back. Striking a line through cancels its task. For a task written on more than one page, strike its newest line:
striking an older copy only retires that copy, and a struck line written again elsewhere is a new item. A task you
tick, strike or erase and write again (or whose tick you erase) is a new item each time.
At 3+ days, the Today sheet calls it out.

Anything you set with **Edit** in the browser (text, due date and time, assignee) wins over the page from then on:
re-reading the page won't overwrite it.

## Task-list notebooks

In a notebook listed as a task list (by default, the one named **To do**), every line you write is a to-do, so no
box or arrow is needed. Headings are skipped, a ticked line is recorded as done, and a crossed-out line cancels its
task. The list of task-list notebooks is `notebooks.taskLists` in `config.json`.
