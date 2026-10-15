# Board search

Use **Boards → Find a board…** to find saved boards by name across every folder. Search is available in both the full-page gallery and the side-panel list.

## Find a board

1. Open **Boards**.
2. Enter part of a board name in **Find a board…**.
3. Choose a result to open that board. The folder path below each result helps distinguish boards with similar names.

Search ignores capitalization and leading or trailing spaces. Every search word must match the board name. Exact names rank first, followed by name prefixes and word matches. Equally ranked results show the most recently modified boards first.

For example, `algebra` finds both **Algebra** and **Algebra notes**, even when they are in different folders. Searching `notes algebra` also finds **Algebra notes**.

Search includes the current board and has no eight-result limit. It searches names only; text, handwriting, and imported document contents are not indexed.

## Clear a search

Clear the field or press **Escape** while it contains a query to return to the folder you were browsing. Pressing Escape again with an empty field closes Boards. Selecting another folder clears the query.

The input keeps focus as results update. Use **Tab** to move to a result and **Enter** to open it. A result count or **No matching boards** message announces the current search state.

## Select, move, and export results

**Select all** selects only the boards in the current results. Changing the query clears the selection so hidden boards are not included in a later move or export.

Selected results can be moved or exported using the existing controls. When the selected boards come from different folders, the move dialog allows any destination, including **My boards**. A move or deletion refreshes the results while keeping the query.

## Verify locally

Run the existing editor smoke suite from the repository root:

```sh
npm run smoke:builtin
```

The search checks exercise both gallery and list views: nested folders, ranking, capitalization, spaces, multiple search words, input focus, empty results, Escape, query persistence after refresh, selection counts, and moving results from different folders.

For a manual check, create **Algebra** in **Maths / Lectures**, **Algebra notes** in **Maths**, and **Geometry** at the top level. Search from inside **Lectures**, confirm that both Algebra boards appear with their paths, then clear the query and confirm that only the current folder's boards return. Repeat with **Settings → My boards as a full page** turned off.
