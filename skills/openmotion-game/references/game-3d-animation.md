> See [source and execution notes](../PROVENANCE.md).

# 3D Assets, Animation & Payload Discipline (Three.js + GLB)

Use for 3D characters, vehicles, props, environments, and animations in Three.js. Pair with [game-stylization.md](game-stylization.md) for cohesive lighting, textures, and skyboxes.

## 1. Capability-Driven 3D Asset Selection (Screen-Dominance Budget)

Always check live capability discovery (`openmotion_capability_discover` / `openmotion_media_use`) first — noting each model's live rigging, quality tier, multi-view support, latency, and cost — then allocate 3D budget strictly by **Screen-Dominance × Gameplay-Focus** rather than choosing whichever static background prop is easiest to place:

- **P0 — Focal Interactive Subjects (mandatory first priority for 3D generation):** Concentrate high-fidelity 3D models on near-camera subjects the player watches continuously (player character/vehicle, primary boss/rival, signature handheld weapon or core interactive piece). **Hard Anti-Pattern:** Never spend 3D generation budget on a peripheral/corner/overhead decorative prop while P0 focal subjects are still assembled from procedural primitive stacks. **Batch-1 Concept Alignment:** Tag each 3D target in `design/assets.csv` with `priority` (`P0-focal` / `P1-instanced`) and `reuse_count`, and generate clean isolated studio concept sheets (neutral uncluttered background, full uncropped silhouette, or split orthographic 3-view turnaround per `game-meshy-input-rules.md`) for every P0/P1 target in Batch 1 (`text-to-image`) before launching Image-to-3D so style and proportions stay locked.
- **P1 — Reusable Primary-Sightline Landmarks (1–2 instanced props):** After P0 subjects are covered, invest remaining 3D budget in 1–2 foreground landmarks repeated across the arena (`reuse_count >= 2`, e.g., braziers, carved pillars, archways, track gates, turrets) instanced via `InstancedMesh` or clones — one reusable foreground GLB lifts the entire frame far more than a single peripheral ornament.
- **P2 — Arenas, terrain, obstacles & VFX → procedural geometry + generated 2D PBR textures + lighting:** Keep large architecture, floors, mirror water, collision geometry, skyboxes, and dynamic effects in Three.js code with seamless generated textures so silhouettes stay crisp up close and colliders match visuals 1:1. Keep 3D generation wired as a live-gated slot: if 3D generation is unavailable, swap only the mesh route to the table fallbacks below (imported user/CC0 `.glb` or procedural Three.js) while keeping standard `image`/`audio` discovery and sign-in/subscription onboarding per `SKILL.md` §2.
- **Low-Friction Character 3D Ladder (avoid rigging paralysis):** Do not abandon 3D generation for P0 heroes/bosses just to avoid skeletal complexity. Choose the lightest viable tier: (a) rigged/animated GLB when full humanoid locomotion/combat clips are needed; (b) static PBR Image-to-3D GLB for vehicles, weapons, rigid/armored bosses, or stylized actors animated cleanly via hierarchical pivots, lunge/lean/recoil curves, and slash/impact VFX (see [game-procedural-animation.md](game-procedural-animation.md)).

| Priority | Route | Best For | Notes |
| :---: | :--- | :--- | :--- |
| **1** | **Rigged & animated GLB** (live 3D gateway model once available, or user/CC0 `.glb` imported into Asset Library) | Humanoid heroes, NPCs, creatures with full action sets | Inspect via `game-glb-inspect.mjs`; clone with `SkeletonUtils.clone()`, drive with `AnimationMixer` cross-fades |
| **2** | **Static high-fidelity PBR GLB** (live Image-to-3D model once available, or user/CC0 `.glb` imported via `action:"import"`) | Focal heroes/equipment (with lightweight runtime skinning), realistic vehicles, landmarks | Prepare clean inputs per `game-meshy-input-rules.md`; inspect before wiring; add runtime skeletal/procedural motion where needed (see [game-procedural-animation.md](game-procedural-animation.md)) |
| **3** | **Procedural PBR Three.js geometry + generated 2D textures/skybox** | Modular environments, roads/bridges, mechanical/non-humanoid props, stylized low-poly worlds | Use bevelled/extruded profiles, PBR `MeshStandardMaterial`/`MeshPhysicalMaterial`, generated seamless tiles + IBL skybox (`PMREMGenerator`) |
| **4** | **Bundled CC0 fallback** (`templates/game-kits/characters/Mage.glb`, `Knight.glb`, 12 clips, 41 bones) | Stylized fantasy/action humanoids when no 3D generation or supplied model is available | Keep `LICENSE-KayKit.txt`; retint materials and attach procedural accessories to bones; state realism ceiling honestly |

**Importing local/external `.glb` models:** Import a local `.glb` into the workspace Asset Library via `openmotion_asset_manage` / `openmotion_assets_use` (`action:"import"`, `sourcePath:"/abs/path/model.glb"`) — both generated and imported GLB 2 assets are automatically inspected into `version.result.glb` and served via `/motion-api/assets/<assetId>/versions/<versionId>/media` (auto-bundled and WebP-optimized on `web_publish` and `exportZip`). Never encode binaries into `openmotion_game_write_files`. For high-importance focal actors, verify grounding, orientation, materials, and attachments in a clean view before layering heavy arena lighting or combat VFX.

## 2. Pre-Integration GLB Inspection Gate

Before wiring any external or generated `.glb` into a scene, inspect it with `node scripts/game-glb-inspect.mjs <file.glb>` (or read `version.result.glb` from an imported library asset):

- **Scale & grounding:** Check `bounds.size` (real world units) and `bounds.minY` (offset by `-box.min.y * scale` so feet/wheels sit flush on `y = 0`). Confirm forward facing (`+Z` vs `-Z`) and `rootTransforms` visually in a capture.
- **Materials & `alphaMode: BLEND` trap:** Check `materials.blendMaterials`. Third-party GLBs often misflag opaque meshes as `alphaMode: BLEND`, disabling depth-write so interior back faces draw over front faces (looks like inverted normals, except lit brightly instead of black). Force `material.transparent = false; material.depthWrite = true;` on parts meant to be opaque, while preserving genuine glass/windshield transparency and PBR roughness/metalness maps.
- **Animations:** Confirm `skins.length >= 1` and non-zero clip durations before referencing clip names; resolve via `THREE.AnimationClip.findByName` with explicit missing-clip handling. For one-shot hit/death clips, set `LoopOnce` + `clampWhenFinished = true`.

## 3. Payload Budget & CSP-Safe Compression

Inspect `totalBytes` and `textureRatio` in `game-glb-inspect.mjs` before optimizing — **on AI-generated 4K GLBs, 90–95% of file size is usually uncompressed PNG textures, not triangles**:

- **Preserve mesh geometry first, optimize textures:** `web_publish` and `exportZip` automatically transcode embedded PNG/JPEG textures inside `.glb` files to **`EXT_texture_webp`** at original resolution while preserving 100% of vertices, skins, and animations (`vendor/GLTFLoader.js` supports `EXT_texture_webp` natively with zero external decoders).
- **Avoid worker-based Draco decoders:** Game Studio's preview CSP enforces `worker-src 'none'`, which blocks Web Worker WASM decoders and external CDN loaders.
- **Keep raw masters out of delivery:** Archive raw 4K working masters or unused concept files under `assets-raw/` (excluded automatically from `web_publish` and `exportZip`), size procedural/terrain textures to their real on-screen resolution, and lazy-load secondary heavy forms (e.g., unlockable transformations/bosses) after initial boot.

## 4. Visual Craft & Performance Budget

- **Lighting, clarity & multi-pass trade-offs:** Derive key directional light, hemisphere fill, skybox/IBL (`PMREMGenerator`), and matching fog from `design/style.md`. Use `ACESFilmicToneMapping` + `SRGBColorSpace` on color/emissive maps only (linear on normal/roughness/metalness). Post-processing and multi-pass effects (bloom, real-time reflections, heavy clones) must serve sharpness and steady frame rate — prefer crisp direct rendering over washed-out/blurry post-processing or multiplied draw cost.
- **Asset rejection safety valve:** Visual cohesion and close-up clarity outrank asset provenance. If an external or generated 3D model reads blurry, fused, or stylistically jarring in live captures, discard it and replace or fall back to clean procedural geometry + lighting rather than defending sunk cost.
- **Draw calls & lifecycle:** Merge static compatible geometry once (`BufferGeometryUtils.mergeGeometries`), use `InstancedMesh` for swarms/props (never merge skinned meshes), cap DPR ≤ 1.5, keep typical scenes within ~100 draw calls / ~100k rendered triangles where practical, expose `renderer.info.render` (`calls`, `triangles`) in `window.__omGame.getStats()` so playtests surface real draw cost, and dispose detached resources cleanly.
- **Headless check note:** Server playtests run SwiftShader WebGL — FPS there is pacing only, not real GPU performance, but blank canvases, console errors, failed GLB/texture requests, and runaway `renderer.info` counts are real failures to fix.
