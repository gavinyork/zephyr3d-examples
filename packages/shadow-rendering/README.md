# Shadow Rendering

Directional, point, and spot shadow mapping example.

The scene renders three side-by-side shadow stations. Each station uses a
different shadow-casting light type, and the runtime controls apply the selected
shadow mode and shadow enable state to all three lights.

Key APIs:

- `DirectionalLight.setCastShadow()`
- `PointLight.setCastShadow()`
- `SpotLight.setCastShadow()`
- `light.shadow.mode`
- `light.shadow.shadowRegion.setRegion()`
- `Mesh.castShadow`
- `PerspectiveCamera.render()`

Run with `?dev=webgl`, `?dev=webgl2`, or `?dev=webgpu` to choose a backend.
