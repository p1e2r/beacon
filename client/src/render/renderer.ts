import * as THREE from 'three'
THREE.ColorManagement.enabled = false
import { BlockAssets, Layer } from './assets'
import { meshSection, MeshData } from './mesher'
import { World } from '../world/world'

const VERT = `
in vec3 position;
in vec2 aUv;
in vec3 aColor;
in vec2 aLight;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
out vec3 vColor;
out vec2 vLight;
out float vDist;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vUv = aUv; vColor = aColor; vLight = aLight;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`

const FRAG = `
precision highp float;
uniform sampler2D map;
uniform float daylight;
uniform float alphaTest;
uniform float opacity;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
in vec2 vUv;
in vec3 vColor;
in vec2 vLight;
in float vDist;
out vec4 outColor;
float curve(float l) { return l / (4.0 - 3.0 * l); }
void main() {
  vec4 t = texture(map, vUv);
  if (t.a < alphaTest) discard;
  float sky = curve(vLight.x) * daylight;
  float blk = curve(vLight.y) * 1.05;
  float b = max(max(sky, blk), 0.06);
  vec3 c = t.rgb * vColor * b;
  float f = smoothstep(fogNear, fogFar, vDist);
  outColor = vec4(mix(c, fogColor, f), t.a * opacity);
}`

interface SectionMesh {
  meshes: (THREE.Mesh | null)[]
}

export class Renderer {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  materials: THREE.RawShaderMaterial[] = []
  sections = new Map<string, SectionMesh>()
  texture!: THREE.Texture
  outline: THREE.LineSegments
  entities = new THREE.Group()
  daylight = 1
  viewDistance = 8
  private sky = new THREE.Color()

  constructor(public canvas: HTMLCanvasElement, public world: World, public assets: BlockAssets) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
    // phones have 3x screens; 1.5x keeps them fast and still sharp
    const coarse = window.matchMedia?.('(pointer: coarse)').matches
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2))
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000)
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.entities)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const sun = new THREE.DirectionalLight(0xffffff, 0.6)
    sun.position.set(0.4, 1, 0.3)
    this.scene.add(sun)
    const og = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002))
    this.outline = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }))
    this.outline.visible = false
    this.scene.add(this.outline)
    this.setAssets(assets)
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  reset(world: World, assets: BlockAssets) {
    for (const s of this.sections.values()) for (const m of s.meshes) if (m) { this.scene.remove(m); m.geometry.dispose() }
    this.sections.clear()
    this.world = world
    if (assets !== this.assets) this.setAssets(assets)
  }

  setAssets(assets: BlockAssets) {
    this.assets = assets
    this.texture?.dispose()
    this.texture = new THREE.CanvasTexture(assets.atlas.canvas)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.flipY = false
    for (const m of this.materials) m.dispose()
    const make = (layer: Layer) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        map: { value: this.texture },
        daylight: { value: 1 },
        alphaTest: { value: layer === Layer.Cutout ? 0.5 : layer === Layer.Translucent ? 0.01 : 0.0 },
        opacity: { value: 1 },
        fogColor: { value: new THREE.Color(0x9cc4ff) },
        fogNear: { value: 60 },
        fogFar: { value: 100 }
      },
      transparent: layer === Layer.Translucent,
      depthWrite: layer !== Layer.Translucent,
      side: layer === Layer.Solid ? THREE.FrontSide : THREE.DoubleSide
    })
    this.materials = [make(Layer.Solid), make(Layer.Cutout), make(Layer.Translucent)]
    this.clear()
  }

  clear() {
    for (const s of this.sections.values()) for (const m of s.meshes) if (m) { this.scene.remove(m); m.geometry.dispose() }
    this.sections.clear()
    for (const col of this.world.columns.values()) for (let s = 0; s < this.world.sectionCount; s++) this.world.markSection(col.x, s, col.z)
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  removeColumn(cx: number, cz: number) {
    for (let s = 0; s < this.world.sectionCount; s++) this.dropSection(`${cx},${s},${cz}`)
  }

  private dropSection(key: string) {
    const old = this.sections.get(key)
    if (!old) return
    for (const m of old.meshes) if (m) { this.scene.remove(m); m.geometry.dispose() }
    this.sections.delete(key)
  }

  /** Rebuilds dirty sections nearest to the camera first, within a time budget. */
  updateMeshes(budgetMs = 6) {
    const dirty = this.world.dirty
    if (!dirty.size) return
    const t0 = performance.now()
    const cam = this.camera.position
    const pcx = Math.floor(cam.x / 16), pcz = Math.floor(cam.z / 16), psy = Math.floor((cam.y - this.world.minY) / 16)
    const list = [...dirty].map(k => {
      const [x, y, z] = k.split(',').map(Number)
      return { k, x, y, z, d: (x - pcx) ** 2 + (z - pcz) ** 2 + ((y - psy) * 0.5) ** 2 }
    }).sort((a, b) => a.d - b.d)
    for (const s of list) {
      if (performance.now() - t0 > budgetMs) break
      dirty.delete(s.k)
      if (!this.world.column(s.x, s.z)) { this.dropSection(s.k); continue }
      const data = meshSection(this.world, this.assets, s.x, s.y, s.z)
      this.dropSection(s.k)
      if (!data) continue
      const meshes = data.map((d, layer) => (d ? this.makeMesh(d, layer, s.x, s.y, s.z) : null))
      this.sections.set(s.k, { meshes })
    }
  }

  private makeMesh(d: MeshData, layer: number, cx: number, sy: number, cz: number) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3))
    g.setAttribute('aUv', new THREE.BufferAttribute(d.uv, 2))
    g.setAttribute('aColor', new THREE.BufferAttribute(d.color, 3))
    g.setAttribute('aLight', new THREE.BufferAttribute(d.light, 2))
    g.setIndex(new THREE.BufferAttribute(d.index, 1))
    g.computeBoundingSphere()
    const m = new THREE.Mesh(g, this.materials[layer])
    m.position.set(cx * 16, this.world.minY + sy * 16, cz * 16)
    m.renderOrder = layer
    m.matrixAutoUpdate = false
    m.updateMatrix()
    this.scene.add(m)
    return m
  }

  setTime(dayTime: number, dimension: string) {
    // 0 = sunrise, 6000 noon, 12000 sunset, 18000 midnight
    let d = 1
    if (dimension.includes('nether')) d = 0.35
    else if (dimension.includes('end')) d = 0.45
    else {
      const t = ((dayTime % 24000) + 24000) % 24000
      const angle = (t / 24000) * Math.PI * 2
      d = Math.max(0.12, Math.min(1, Math.cos(angle - Math.PI / 2) * 0.9 + 0.55))
    }
    this.daylight = d
    if (dimension.includes('nether')) this.sky.setRGB(0.2, 0.03, 0.03)
    else if (dimension.includes('end')) this.sky.setRGB(0.08, 0.06, 0.12)
    else this.sky.setRGB(0.47 * d + 0.02, 0.65 * d + 0.02, 1.0 * d + 0.05)
  }

  render() {
    const far = this.viewDistance * 16
    for (const m of this.materials) {
      m.uniforms.daylight.value = this.daylight
      m.uniforms.fogColor.value.copy(this.sky)
      m.uniforms.fogNear.value = far * 0.6
      m.uniforms.fogFar.value = far * 0.95
    }
    this.renderer.setClearColor(this.sky)
    this.renderer.render(this.scene, this.camera)
  }
}
