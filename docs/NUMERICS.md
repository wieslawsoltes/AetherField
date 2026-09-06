# Numerical formulation

## Domain, fields and sign conventions

A two-dimensional planar domain Ω is extruded through a uniform out-of-plane thickness d. Geometry coordinates are metres. Temperature T is kelvin; electric potential V is volts. Scalar, positive material coefficients are used. Material interfaces are part of the planar straight-line constraint graph before triangulation.

Thermal conduction:

```text
rho cp dT/dt − div(k grad(T)) = Q + Qj
q = −k grad(T)
```

Dielectric electrostatics:

```text
−div(epsilon grad(V)) = rho_charge
E = −grad(V)
D = epsilon E
```

DC electric currents:

```text
−div(sigma(T) grad(V)) = 0
J = −sigma(T) grad(V)
Qj = J · E = sigma(T) |grad(V)|²
sigma(T) = sigma_ref / (1 + alpha (T − Tref))
```

Joule heat is nonnegative and comes from electric currents, not the dielectric equation. The denominator in the conductivity law must remain strictly positive. Heat capacity is rho times cp. The electric and dielectric equations are elliptic, including in a time-dependent study; only temperature has a time derivative.

A user-defined “inward flux” g contributes **positively** to the load vector. For heat, g = −q·n = k grad(T)·n, where n is the outward normal. Positive g heats the domain. For current and displacement flux, g = −J·n and g = −D·n respectively. Convection uses outward heat flux `h(T − Tamb)` and contributes `+h T` on the matrix side, `+h Tamb` on the load side.

No assigned rule means zero natural flux. Essential conditions are imposed on all nodes of matching exposed boundary edges. At a shared corner, incompatible prescribed values are rejected. Nonessential rules that overlap on an edge are rejected rather than counted twice.

## Mesh construction

Rectangles and simple polygons supply linear segments; circles supply 24–256 segments according to requested element size. Ordered CSG classifies additive regions, material overwrites and cuts. The mesher:

1. Normalizes coordinates by the domain scale and splits all primitive edges at pairwise intersections and collinear endpoints.
2. Subdivides constraints to the requested spacing, deduplicates points, and adds a hexagonal interior seed grid with constraint clearance.
3. Performs deterministic shuffled Bowyer–Watson triangulation.
4. Recovers every constraint through admissible convex edge flips; unrecoverable constraints are errors.
5. Relaxes unconstrained edges, classifies conforming faces, removes exterior/hole triangles and compacts nodes.
6. Verifies positive Jacobians, manifold edge incidence and that every exposed edge corresponds to a retained geometric boundary.

Therefore holes and material boundaries are geometric constraints, not centroid-only raster masks. Face classification occurs **after** constraints have been recovered. Circular geometry remains polygonal, so convergence relative to a true circle also involves geometry refinement.

Per-element quality is

```text
quality = 4 sqrt(3) area / (a² + b² + c²)
```

It is one for an equilateral triangle and tends toward zero for a degenerate triangle. The UI reports minimum/mean quality and a histogram. Float64 predicates are normalized, but are not mathematically exact. Arbitrarily degenerate or extremely poorly scaled arrangements are outside the validated envelope.

The mesh signature contains evaluated geometry, operation order, tags and target size. A parameter change that changes geometry invalidates a supplied cached mesh. Material property changes can reuse topology; element region indices refer to the current ordered shape/material table. Sweeps intentionally remesh each case even when a parameter appears to be electrical only.

## P1 triangular Galerkin assembly

For a positively oriented triangle e of area Ae, linear shape functions Ni have constant gradients. For scalar conductivity ce (k, sigma or epsilon):

```text
Ke_ij = d Ae ce grad(Ni) · grad(Nj)
Me_ij = d Ae rho cp / 12 * (2 if i == j else 1)
```

The thermal mass matrix is **consistent**, not lumped. The assembled equation is

```text
M dT/dt + (K + H) T = F
```

with convection H. Sources use three barycentric quadrature locations `(2/3,1/6,1/6)` and permutations, each of weight Ae/3. This is degree-two exact quadrature; higher-order/nonpolynomial source expressions are quadrature approximations.

For an edge of length L, constant/midpoint-evaluated coefficients give:

```text
Hedge = d h L / 6 * [[2,1],[1,2]]
Fambient = d h Tamb L / 2 * [1,1]
Fflux = d g L / 2 * [1,1]
```

Spatially varying boundary flux/convection uses midpoint coefficient sampling. Essential boundary values are evaluated at nodes. Piecewise constant material coefficients are evaluated per element. The conductivity temperature is the element-average nodal temperature. The mass and stiffness matrices share the precomputed CSR sparsity and element scatter maps.

## Essential elimination and solvability

Partition the system into free and fixed DOFs. Solve

```text
Aff xf = bf − Afc xc
```

and reconstruct xc exactly. This is reduced symmetric elimination; no penalty constant and no nonsymmetric row-only replacement are used.

For each connected stationary thermal component there must be a prescribed temperature or a positive convection coefficient. For each stationary/quasistatic electric component there must be a prescribed potential. Pure-Neumann stationary components are rejected with a nullspace diagnostic; this version does not insert an arbitrary gauge or solve compatible mean-zero problems.

Transient thermal mass removes the constant nullspace, so a fully insulated transient component is allowed. Its uniform-state conservation is tested. Empty selections, nonpositive material values, invalid conductivity denominators and negative absolute temperatures are rejected.

## Float64 sparse solver

The CSR solver uses preconditioned conjugate gradients with a Jacobi diagonal. Dot products use compensated accumulation; all matrix entries, vectors and authoritative residuals are Float64. The acceptance norm is

```text
rrel = ||b − A x||₂ / max(||b||₂, 1e−300)
```

on the reduced free-DOF system. Zero right-hand-side systems return the exact zero free solution. Positive matrix diagonals and positive search-direction curvature are checked. Residual replacement with restart occurs every 160 iterations, and an apparent recurrence convergence is checked against an explicitly recomputed residual. Acceptance permits a 1.1 factor on the requested linear tolerance for floating-point checking. Iteration exhaustion is an error, not a successful study.

Warm starts are used across nonlinear iterations and time steps. A warm start that already satisfies tolerance legitimately records zero additional iterations. The UI defaults to a recorded solve with substantial history and provides a selector for all solves, including zero-iteration ones.

## Mixed-precision WebGPU path

With `S = diag(A)^(−1/2)`, solve

```text
B = S A S
c = S b
x = S y
B y = c
```

The matrix and vector arena are uploaded as f32. Rows/columns remain u32 CSR indices. Each iteration comprises six ordered compute dispatches: sparse matrix-vector multiplication; partial p·Ap reduction; scalar alpha; x/r update with partial r·r reduction; scalar beta/convergence state; p update. Workgroups have 128 invocations. Two-level reductions avoid floating-point atomics. A shared explicit bind-group layout avoids the incompatibility of automatically inferred layouts across different entry points.

Twelve iterations are submitted per scalar readback batch. Once the on-device convergence flag is set, subsequent batched update passes become no-ops. Reported GPU iteration counts are **scheduled batch iterations**, potentially including those trailing no-ops; dispatch counts count encoded/submitted compute passes, not elapsed-time speedup.

The GPU recurrence targets at least approximately 3e−6 relative precision. The candidate is unscaled and then passed as a warm start to the original Float64 PCG system. This is the acceptance authority. Invalid/nonfinite GPU candidates do not bypass the Float64 checks. Small systems and unavailable/rejected GPU devices fall back to the CPU. Compute buffers are disposed in `finally`; worker termination handles cancellation and invalidated jobs.

The render pipeline is separate: expanded triangle vertices carry field values, the vertex shader transforms model coordinates, and the fragment shader applies an interpolated palette and derivative-based contour antialiasing. Labels, mesh edges, vector arrows and interaction adorners are Canvas2D overlays. The fallback actually rasterizes the same P1 fields with barycentric interpolation; it is not an unrelated decorative gradient.

**Verification status:** WGSL paths are supplied but hardware execution was not available in the delivery environment. Run `tests/gpu-check.html` on the target adapter. No f64-GPU or universal performance claim is implied.

## Time integration and nonlinear coupling

At each backward-Euler step:

```text
(M/dt + K + H) T[n+1] = F[n+1] + (M/dt) T[n]
```

Boundary/source expressions are evaluated at the new time. The last step is shortened to end exactly at the requested final time. Initial essential temperatures are applied to the initial state before the first step. The consistent mass includes contributions from all previous-state nodes; elimination of the new prescribed nodes therefore includes the effect of changing Dirichlet data.

For Joule heating, Picard iterations are:

1. Evaluate sigma from the temperature guess and solve the current-conduction system.
2. Compute element Qj from that potential and conductivity.
3. Solve the thermal stationary/implicit system with Qj.
4. Reevaluate conductivity at the candidate new temperature, reassemble the electric and thermal equations, and compute their true free-DOF residuals.
5. Accept only when both the maximum coupled residual and relative temperature change satisfy the nonlinear tolerance; otherwise under-relax the temperature and repeat.

Constant conductivity reduces to a one-way electric → thermal solve. Temperature change alone is never sufficient to declare two-way convergence. Nonlinear iteration exhaustion rejects the step. There is no adaptive time step, Newton tangent, or general-purpose arbitrary multiphysics graph in this version.

## Derived quantities, conservation and probes

Nodal T/V are continuous piecewise-linear fields. Gradients, heat flux, electric field, current density and Joule heat are elementwise quantities; they are not smoothed across discontinuous materials. Volume integrals include the physical thickness. Stored dielectric energy is `integral(0.5 epsilon |E|² dΩ) d`.

For each linear system, reactions are `A x − b` before essential elimination. Thermal diagnostics record source, prescribed inward flux, essential reactions, convection outflow, storage rate and algebraic balance:

```text
balance = source + inwardFlux + essentialReaction − convectionOut − storage
```

For electric systems, the corresponding balance has electrical units rather than watts. Do not interpret every generic `balance` entry as heat power. These diagnostics belong to the assembled linear systems used in the accepted iteration; final temperature-dependent derived Joule power may differ by nonlinear-tolerance effects.

A uniform spatial hash accelerates triangle location. Point probes use barycentric interpolation and retain samples for every frame and sweep case. A point in a hole or outside the domain is null, not an extrapolated field. Nodal CSV exports Kelvin; plot screenshots show Celsius. Element VTK/CSV retain native discontinuous fields.

## Accuracy and tests

Tests include linear patches; a quadratic-source solution with observed L2 order near two; inward-flux and Robin cases; parallel-plate and layered-dielectric fields; analytical transient sine decay; insulated conservation; a constant-conductivity Joule parabola; temperature-dependent coupling; Boolean-hole area/topology; invalid nullspaces/conflicting values; parameter power scaling; units; and history.

A small algebraic residual is not an error estimator. Independent spatial/time-step convergence, exact geometry checks, material validation and physical model verification remain necessary. No claim is made that the included test suite covers every possible shape, degeneracy, browser, GPU driver or load expression.
