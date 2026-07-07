# Joint Dynamics

Interactive JointDynamicsSystem example.

This demo shows several bone-chain and cloth-like setups driven by Zephyr3D's
joint dynamics solver. Each mode builds a different constraint topology and
updates it against animated colliders, optional wind, floor collision, and a
mouse-controlled grabber.

Modes:

- `Bone Chain`: an 8-bone pendulum chain with a sphere collider.
- `Cloth Grid`: a 6 by 6 surface with structural, shear, bending, and surface
  collision constraints.
- `Barrel`: a looped skirt-like cloth layout around a capsule body collider.
- `Closed Chain`: an open chain whose endpoints are fixed together to behave
  like a necklace around a capsule collider.

Controls:

- Use the mode buttons to switch between demos.
- Use `Toggle Wind` to apply an oscillating wind force.
- Use `Broad-Phase On/Off` to compare broad-phase collider filtering.
- Use `Reset` to restore the current simulation.
- In cloth modes, use `Release Next`, `Release All`, and `Fix All` to change
  which top-row points are pinned.
- Right-click and drag in the viewport to move the grabber through the active
  simulation.
- Orbit the camera with the default orbit camera controls.

Key APIs:

- `new JointDynamicsSystem()`
- `JointDynamicsSystem.update()`
- `createTransformAccess()`
- `controller.fixPoint()`
- `controller.releasePoint()`
- `controller.setWindForce()`
- `controller.setBroadPhaseEnabled()`
- `controller.setGrabberEnabledAt()`

Build:

```text
rushx build
```

The build copies `index.html` and bundles the TypeScript entry point into
`dist/js/main.js`.
