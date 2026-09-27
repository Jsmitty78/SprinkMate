# Field Agent workbench (issues #11 and #12)

The Sprink UI has one login and shared navigation: work packages at `/` (`/api/work-packages`) and field inspections at `/inspections` (`/api/tasks`). Old `/legacy` bookmarks redirect to `/inspections`; the old app shell and stylesheet have been removed. The UI uses custom CSS, without a component-library dependency.

Code: `apps/web/src/workbench/`. The UI calculates nothing: cuts, quantities, routes, deltas and rule findings all come from the server. The UI converts units for display (ft-in to the nearest 1/16 in, plus mm) and says so on screen.

## Workflows

**Prepare from a drawing (#11).** This workflow needs no obstruction or change request.
1. Upload the sheet (PDF, PNG or JPEG) and set the revision and page. Confirm the scale.
2. Enter the run as ordered points: a tie-in or open end at each end, 90° elbows in between. The editor writes the plan contract in the same shape as the server fixture. Nothing is routed or sized on the client.
3. Confirm the run dimensions against the drawing. The server then freezes the baseline.
4. Confirm the end datums, tie-in net cut offsets, joint movement, access, cure plan and project basis.
5. Generate. The panel shows materials, the cut list, assembly steps and checks with their sources.

Selecting a piece on the plan or in the cut list highlights it in both places. The row also shows the server's deductions and the checks for that piece.

**Adapt to site conditions (#12).** This can be opened directly, without running Prepare first.
1. Enter the existing run and the drawing, choose the affected piece, and enter the measured duct box, work boundary, clearance and photos.
2. Generate route alternatives and preview each one on the plan. The comparison shows fittings, the centerline change, pieces and assembly steps. Rejected layouts are listed with their reasons.
3. **Use Route X** records your selection, then builds the revised package. That package has the full quantities and cut list, plus the change from the original taken from the server's `delta`. The original baseline is kept and stated.
4. Export makes the PDF, materials CSV and cut list CSV through the server's exporter, bound to the input revision.

## Field inspections

The Field inspections navigation opens existing task records without conversion. It preserves creation and cancellation, drawing orientation revisions, photo upload and viewing, manual fact corrections with evidence, additional requests and answers (including unavailable reasons), saved measurements, synthetic replays, validation, and JSON report generation/download. Domain panels live under `apps/web/src/workbench/inspections/` and use the shared Sprink controls and colors. The task and package APIs and stored records are unchanged.

## States handled

- **Unknown values:** a cut, quantity or delta the server reports as unknown shows "Unknown" with the server's reason. It is never shown as 0. An empty measurement is saved as unknown.
- **Missing inputs:** a checklist of what is still needed. Generate is blocked only where the server would fail outright (see the gaps below).
- **Server questions:** an open request can be answered as unavailable.
- **Stale results:** results stay visible, labelled with the revision they belong to, beside a Regenerate action. Stale routes are drawn faded.
- **Selection:** selected, applied and previewed routes are labelled differently. Changing inputs while a route is selected clears the selection first (the server keeps it otherwise), and the UI says so.
- **Route results:** no route found, only one route, and a route with an unknown length (which cannot be selected) each have their own state.
- **Run status:** loading, running (with a cancel button), blocked, failed and empty.
- **Approval:** the UI always shows "Not construction approved". The server reports construction approval as not assessed, and no API records it.

## Sample data

**Load sample input** fills an empty package through the real API. It uses the invented confirmations from `apps/server/test/fixtures/integrated-package.ts` and draws a PNG sheet labelled SAMPLE DRAWING. Every sample fact's source starts with `SAMPLE:`, and the package shows a Sample data badge while any sample fact remains. No fixtures are bundled into production code paths.

## Backend gaps found while integrating

1. **Drawing alignment.** `sourceDrawing` has a scale but no origin, rotation or page region. The plan therefore cannot be overlaid on the sheet, and a work area cannot be picked on the drawing. The sheet is shown in its own view, and run coordinates are typed in. A contract for alignment and `scope.region` would close this.
2. **Scale calibration.** Scale is one quantity with a free-text unit. There is no contract for a two-point, known-distance calibration.
3. **`runner_failed` hides the cause.** `fabricationInput` throws on structural problems instead of publishing a gap or request. An open end without a confirmed `physical_pipe_end` datum is one example. The UI pre-checks that case (`runBlockers`) and explains the bare `runner_failed`.
4. **Evidence photos have no field.** Photos are stored as site facts `evidence.photo.N` with `source.assetId`. The adapter ignores unknown fields, so this is safe, but the evidence belongs in the contract.
5. **Selecting a route bumps the input revision.** The candidate set becomes stale right after a choice, so switching routes needs a regenerate. Changing site facts does not clear the selection on the server.
6. **`GET /:id/detail` is not in `docs/contracts/work-package-api.en.md`.** Callouts, centerlines, takeouts and `delta` come from it. The UI treats it as optional and works from the snapshot alone.
7. **Rule findings have no title or rule id,** so findings are grouped by their reason text.
8. **Answers can only mark information unavailable.** Real values go through fact edits, as the server comment says.

## Not done yet

- Selecting a work area or region on the drawing sheet, and an overlay of the plan on the sheet (gap 1).
- Heads, supports and branch trees in the run editor. It handles one open run.
- The route planner does not read photos. They are evidence only.

## Checks

```
pnpm test        # includes apps/web/src/workbench/model.test.ts
pnpm typecheck
pnpm build
```

Browser pass: both workflows were run end to end against `pnpm start` at 1600×1000 and 390×844. Screenshots are in `docs/ui/`.

### Unified UI migration verification

- All 24 test files pass (643 tests passed, 9 skipped); workspace typecheck and production build pass.
- Local browser with an isolated data directory: created an inspection, loaded synthetic observations, edited and saved a fact, created and answered a request with stored evidence, generated a report, and invoked JSON download. The download success state appeared; the browser harness did not return a saved-file event.
- Reloading `/legacy` redirects to `/inspections` and shows the saved inspection with its current revision.
- Drawing preparation generated materials and cuts. Site adaptation generated alternatives, selected Route A, built the revised package, and generated PDF/CSV artifacts through the existing server.
- Desktop (1440 px) and phone (390 px) inspection views checked visually. Phone package panels no longer overlap the canvas; page width stays within 390 px. No browser console errors were reported in the checked session.
- Screenshots: `docs/ui/35-integrated-inspections.png` and `docs/ui/36-inspections-mobile.png`.

### Main drawing-editor integration

- Merged the source-based SVG editor into Field inspections without restoring the legacy shell or stylesheet. New inspections retain the reference drawing / sample selection. The work-package run editor remains a separate workflow with the limitations above.
- All 26 test files pass (660 passed, 9 skipped); workspace typecheck and production build pass.
- Browser check against isolated local data: created an FS-01 reference inspection, changed H1 orientation, saved drawing revision 2, and reloaded to verify the saved orientation in the unified UI.
