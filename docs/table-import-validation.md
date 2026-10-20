# Invalid table imports

Imported tables must have integer `rows` and `cols` between 1 and 40, matching the table editor's existing limit. Invalid tables reject the entire import before it replaces the current document or undo history. Counts are not silently rounded or clipped, which could hide cells containing work.

Canvas and SVG rendering also skip invalid tables. Linked-board exports skip a linked board that fails import validation, as they do for unreadable boards.

## Regression tests

The normal desktop smoke suite includes these tests:

```sh
npm run smoke:builtin
```

To run only the table checks on Windows PowerShell, use a disposable profile:

```powershell
$env:GAZBOARD_USER_DATA = Join-Path $env:TEMP ('gazboard-table-test-' + [guid]::NewGuid())
$env:GAZBOARD_TEST = (Resolve-Path test/table-import.js).Path
try {
    npm run smoke:builtin
} finally {
    Remove-Item Env:GAZBOARD_USER_DATA
    Remove-Item Env:GAZBOARD_TEST
}
```

Coverage includes both axes, non-finite numbers (including JSON `1e309`), zero, negative/fractional/oversized counts, numeric strings, null/missing counts, legacy object collections, canvas/SVG safeguards, linked exports, valid 1×1/3×3/40×40 tables and save/reopen behavior. The real app also rejects an invalid import and continues drawing its previous board.

## Manual local check

Run the fixed source with `npm start` in a disposable `GAZBOARD_USER_DATA` profile. Make a board with a note, then open a `.gazboard` file containing:

```json
{"id":"invalid-table-test","name":"Invalid table","schema":2,"pages":[],"objects":[{"id":"t","type":"table","x":0,"y":0,"w":200,"h":100,"cols":1e309,"rows":1}]}
```

The app should report that it could not open the board, keep the previous note and remain responsive. Repeat with an oversized row count. Finally create and resize an ordinary table, export it to SVG, save and reopen it: valid tables should behave as before.

Use this malformed fixture only with the fixed source; older versions can freeze. Physical Android and iPad testing is separate from these desktop regression tests.
