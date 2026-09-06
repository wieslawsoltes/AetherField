# Architecture and invariants

## Data ownership

The project is a serializable schema-v1 JSON document. Primitive objects, materials, boundary conditions and probes have stable identities. The mutable UI works through bounded immutable snapshot transactions: clone → mutate → validate → commit. Pointer movement is a preview; pointer completion is one transaction. Undo/redo is deterministic for project inputs, not a simulation of reverse solver execution.

Project inputs and computed datasets are separate. A dataset owns a mesh, per-frame typed arrays, probe samples and recorded solve diagnostics. `.afield` stores the input project only. Full result JSON serializes typed arrays as ordinary JSON arrays. There is no opaque proprietary binary payload.

## Invalidations

Geometry, ordering, geometric parameters and mesh size invalidate the mesh and solution. Material, physical-load, boundary and study changes invalidate the solution. Presentation/probe changes can retain fields. The numerical core additionally compares evaluated geometry signatures before using a supplied mesh; correctness does not depend solely on the UI classifying a parameter name.

Sweeps always remesh each case. This deliberately favors correctness over optimizing “obviously non-geometric” parameters. A later dependency-aware cache can refine the policy without changing the solve contract.

The current implementation rebuilds assembly/scatter contexts per solve case and matrices per equation/step. It is not advertised as fully incremental assembly. GPU pipelines live for a worker job; matrix/vector buffers are currently scoped to individual linear solves rather than a long-lived allocation pool.

## Worker protocol

A job sends `{id, action, project, mesh}`. Actions are mesh, solve and benchmarks. A worker returns progress messages, a typed-array result, or a structured error. The main thread ignores IDs other than the current job. Cancellation and an input edit terminate the worker rather than relying on the solver to eventually yield to a cancel callback.

Transferred result buffers are collected and deduplicated before posting. Each worker job has its own GPU compute instance. The renderer uses a separate GPU device/context on the UI thread. Device availability for one does not imply availability for the other. Core CPU modules can also be imported directly in Node.js without any DOM.

## Rendering

Rendering is demand-driven through coalesced `requestAnimationFrame`, not a permanent busy loop. Field vertices are rebuilt when the mesh/frame/field changes; GPU capacity is reused when sufficient. The camera remains independent of physical field data. A spatial hash supports pointer probes without an all-triangle search.

Native WebGPU renders interpolated fields; Canvas2D overlays draw annotations, topology, vectors and edit handles. The numerical CPU fallback uses the same triangulation and nodal values and performs barycentric rasterization. Its cached raster is capped at 1000 pixels per dimension. Exports retain full numeric resolution and are not made from that raster.

## Input safety and resource bounds

Expressions are parsed into a restricted AST. Property access, assignments, arbitrary calls, `eval`, `Function` and prototype name resolution are absent. Dimensional quantities use five SI exponents. Named parameter evaluation detects cycles and reserved/duplicate names. Text injected into the DOM is escaped.

Project JSON is capped at 2 MB. Collection, geometry, iteration, node and retained-frame limits bound interactive workloads. These limits are practical guards, not a proof against every denial-of-service input. Local project files should still be treated as untrusted input; this is not a sandbox security product.

The Node server is read-only, binds loopback, blocks traversal and methods other than GET/HEAD, and serves with a restrictive local-only CSP. The standalone document uses no external fetches and embeds a Blob worker. Its local-file storage capabilities depend on browser policy.

## Extension points

The coefficient/assembly boundary is the natural location for anisotropic tensor terms, consistent domain-specific source expressions or Robin quadrature improvements. The CSR abstraction can host stronger preconditioners or sparse direct solvers. A production-scale mesh replacement should preserve nodes, triangles, region indices, boundary tags, gradients, areas and the evaluated-geometry signature contract.

For adaptive studies, add an explicit error estimator and remesh/projection operation; do not infer an error bound from element quality. For Newton coupling, introduce coupled residual/Jacobian assembly rather than labeling Picard updates as Newton steps. For circuit/electromagnetic transients, introduce their actual state equations rather than reusing quasistatic frames.
