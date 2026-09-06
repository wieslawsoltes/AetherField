# Verification record

This record describes tests actually run for the delivered source. It does not claim commercial certification, exhaustive test coverage, or successful execution on hardware that was not available.

## Numerical tests: 16 / 16 passed

`npm test` imports exactly the core modules used by the browser worker. `tests/results.json` records individual tolerances, metrics and timings. Representative results:

| Check | Observed metric |
|---|---:|
| Linear thermal patch | Maximum nodal error 4.15e−8 K |
| Poisson source refinement | Observed L2 order 1.9823 |
| Inward-flux sign | Maximum nodal error 2.49e−8 K |
| Robin analytical profile | Maximum nodal error 2.02e−8 K |
| Dielectric parallel plate | Maximum potential error 9.78e−11 V |
| Dielectric interface | Maximum potential error 2.63e−11 V |
| Transient sine decay, 21 frames | Spatial L2 error 9.08e−3 K·m |
| Uniform insulated transient | Measured drift 0 K |
| Coupled Joule parabola | Spatial L2 error 2.59e−4 K·m |
| Two-way conductivity case | 9 Picard iterations, coupled residual 8.33e−10 |
| Polygonized circular-hole area | Error 2.78e−17 m² |
| Voltage doubling at constant conductivity | Joule power ratio 4 |

The nonlinear benchmark intentionally uses 4 mm target elements, while the startup example uses 2.5 mm. Their peak temperatures need not be identical. Geometric area tests compare with the actual 24-sided hole polygons, not an exact circle.

The remaining tests cover dimensional expressions/cyclic parameters, Boolean intersections, invalid stationary nullspaces/conflicting essential values, and atomic history.

## Browser tests: 11 / 11 passed

`tests/browser.py` recorded `tests/browser-results.json`. It checks startup numerical results and actual convergence samples; six field choices; overlay changes; valid and invalid probe placement; real CSV/VTK downloads; project export/upload and identity preservation; a picked hole-edge convection condition; rectangle construction/movement/deletion/undo/redo/remeshing; thermal and electrostatic model-library solves; transient slider/playback; sweep results and dataset switching; and all 16 numerical tests in the actual worker.

The recorded browser was Linux HeadlessChrome 144, 1512 × 982 viewport. It rendered the self-contained document in an offline `about:blank` context. The context exposed no WebGPU API. No page errors were recorded. File-origin/localStorage persistence was unavailable there; portable project file round trips were tested instead. The modular static server was checked at the HTTP/source level, not navigated through that browser's blocked URL policy.

`docs/screenshot.png` and `docs/mesh-vectors.png` are real captures of computed fields, not image-generation mockups. Their displayed backend is Canvas2D fallback.

## GPU status: not executed in delivery environment

The implementation includes native WGSL compute and rendering, but these tests do not validate shader compilation, GPU numerical behavior or GPU performance. This is an explicit unverified platform boundary, not a hidden CPU implementation presented as GPU execution.

`tests/gpu-check.html` is supplied for target-machine validation. It compares actual GPU-backed solves with CPU references, rejects fallback-only execution, checks true residuals, requires compute dispatches and creates the GPU renderer. Run it on localhost or HTTPS in a browser exposing a usable WebGPU adapter. Its results are not included as passing evidence in this package because that test could not execute on an adapter here.

## Reproduction

```sh
npm test
npm run examples
npm run build:standalone
python tests/browser.py --chromium /path/to/chromium
```

Wall-clock timings in the JSON files are observations of this environment only. They are not cross-platform performance guarantees. Mesh/time convergence and independent physical validation remain the user's responsibility before consequential engineering decisions.
