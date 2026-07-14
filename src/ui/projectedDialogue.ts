import * as THREE from "three/webgpu"
import type {
  DialogueProgress,
  DialogueSpeaker,
  DialogueTurn
} from "../gameplay/agents/dialogue"
import { interactKeyLabel, localizeInteractText } from "../core/input"
import "./projectedDialogue.css"

export interface DialogueVector3Like {
  readonly x: number
  readonly y: number
  readonly z: number
}

export type DialogueAnchorSource = THREE.Object3D | DialogueVector3Like
export type DialogueWorldAnchor = DialogueAnchorSource | (() => DialogueAnchorSource)

export interface ProjectedDialogueOptions {
  /** Overlay host. Defaults to `#hud`, then `document.body`. */
  readonly parent?: HTMLElement
  /** Added to the resolved world anchor, useful for placing UI above a head. */
  readonly worldOffset?: DialogueVector3Like
  /** Used when a turn does not include `metadata.topic`. */
  readonly defaultTopic?: string
  /** Used when a turn does not include `metadata.nextHint`. */
  readonly defaultNextHint?: string
  /** Optional additional class for scene-specific styling. */
  readonly className?: string
}

export interface DialoguePromptOptions {
  readonly speaker?: DialogueSpeaker
  readonly key?: string
  readonly label?: string
}

export interface DialogueTurnViewOptions {
  readonly topic?: string | null
  readonly progress?: DialogueProgress | null
  readonly nextHint?: string | null
}

type ViewMode = "hidden" | "prompt" | "turn"

const DEFAULT_OFFSET: DialogueVector3Like = { x: 0, y: 0, z: 0 }
const MIN_SAFE_INSET = 14
let projectedDialogueId = 0

function readPixel(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) * 0.5
  return Math.min(max, Math.max(min, value))
}

function visibleText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * DOM dialogue that follows a world-space NPC anchor without touching renderer
 * internals. Call `update(camera)` once per rendered frame while it is visible.
 */
export class ProjectedDialogueUI {
  readonly #parent: HTMLElement
  readonly #root: HTMLDivElement
  readonly #pin: HTMLDivElement
  readonly #prompt: HTMLDivElement
  readonly #promptKey: HTMLElement
  readonly #promptLabel: HTMLSpanElement
  readonly #card: HTMLElement
  readonly #mark: HTMLSpanElement
  readonly #speakerName: HTMLSpanElement
  readonly #speakerTitle: HTMLSpanElement
  readonly #progress: HTMLSpanElement
  readonly #body: HTMLParagraphElement
  readonly #topic: HTMLSpanElement
  readonly #nextHint: HTMLSpanElement
  readonly #worldOffset = new THREE.Vector3()
  readonly #world = new THREE.Vector3()
  readonly #cameraSpace = new THREE.Vector3()
  readonly #screen = new THREE.Vector3()
  readonly #defaultTopic: string
  readonly #defaultNextHint: string

  #anchor: DialogueWorldAnchor
  #mode: ViewMode = "hidden"
  #disposed = false

  constructor(anchor: DialogueWorldAnchor, options: ProjectedDialogueOptions = {}) {
    this.#anchor = anchor
    this.#parent = options.parent ?? document.getElementById("hud") ?? document.body
    const offset = options.worldOffset ?? DEFAULT_OFFSET
    this.#worldOffset.set(offset.x, offset.y, offset.z)
    this.#defaultTopic = options.defaultTopic ?? "Conversation"
    this.#defaultNextHint = options.defaultNextHint ?? `${interactKeyLabel("kb")} · Continue`

    projectedDialogueId += 1
    const speakerId = `projected-dialogue-speaker-${projectedDialogueId}`

    this.#root = document.createElement("div")
    this.#root.className = "projected-dialogue"
    if (options.className) this.#root.classList.add(options.className)
    this.#root.dataset.state = "hidden"
    this.#root.hidden = true
    this.#root.setAttribute("aria-hidden", "true")

    this.#pin = document.createElement("div")
    this.#pin.className = "projected-dialogue__pin"

    this.#prompt = document.createElement("div")
    this.#prompt.className = "projected-dialogue__prompt projected-dialogue__panel"
    this.#prompt.setAttribute("role", "status")
    this.#prompt.setAttribute("aria-live", "polite")

    this.#promptKey = document.createElement("kbd")
    this.#promptKey.className = "projected-dialogue__key"
    this.#promptLabel = document.createElement("span")
    this.#promptLabel.className = "projected-dialogue__prompt-label"
    this.#prompt.append(this.#promptKey, this.#promptLabel)

    this.#card = document.createElement("section")
    this.#card.className = "projected-dialogue__card projected-dialogue__panel"
    this.#card.setAttribute("role", "status")
    this.#card.setAttribute("aria-live", "polite")
    this.#card.setAttribute("aria-atomic", "true")
    this.#card.setAttribute("aria-labelledby", speakerId)

    const header = document.createElement("header")
    header.className = "projected-dialogue__header"
    this.#mark = document.createElement("span")
    this.#mark.className = "projected-dialogue__mark"
    this.#mark.setAttribute("aria-hidden", "true")

    const identity = document.createElement("span")
    identity.className = "projected-dialogue__identity"
    this.#speakerName = document.createElement("span")
    this.#speakerName.id = speakerId
    this.#speakerName.className = "projected-dialogue__speaker"
    this.#speakerTitle = document.createElement("span")
    this.#speakerTitle.className = "projected-dialogue__speaker-title"
    identity.append(this.#speakerName, this.#speakerTitle)

    this.#progress = document.createElement("span")
    this.#progress.className = "projected-dialogue__progress"
    header.append(this.#mark, identity, this.#progress)

    this.#body = document.createElement("p")
    this.#body.className = "projected-dialogue__body"

    const footer = document.createElement("footer")
    footer.className = "projected-dialogue__footer"
    this.#topic = document.createElement("span")
    this.#topic.className = "projected-dialogue__topic"
    this.#nextHint = document.createElement("span")
    this.#nextHint.className = "projected-dialogue__next"
    footer.append(this.#topic, this.#nextHint)

    this.#card.append(header, this.#body, footer)
    this.#pin.append(this.#prompt, this.#card)
    this.#root.appendChild(this.#pin)
    this.#parent.appendChild(this.#root)
  }

  /** Swap the followed NPC or marker without allocating another view. */
  setAnchor(anchor: DialogueWorldAnchor): void {
    if (this.#disposed) return
    this.#anchor = anchor
  }

  setWorldOffset(offset: DialogueVector3Like): void {
    if (this.#disposed) return
    this.#worldOffset.set(offset.x, offset.y, offset.z)
  }

  showPrompt(options: DialoguePromptOptions = {}): void {
    if (this.#disposed) return
    const key = visibleText(options.key ?? interactKeyLabel())
    const label = visibleText(options.label ?? "Talk") ?? "Talk"
    const speakerName = visibleText(options.speaker?.name)

    this.#promptKey.textContent = key ?? ""
    this.#promptKey.hidden = key === null
    this.#promptKey.classList.toggle("is-pad-face", key === "Y" || key === "A" || key === "B" || key === "X")
    this.#promptKey.dataset.face = key === "Y" || key === "A" || key === "B" || key === "X" ? key : ""
    this.#promptLabel.textContent = label
    this.#prompt.setAttribute(
      "aria-label",
      `${key ? `Press ${key} to ` : ""}${label.toLowerCase()}${speakerName ? ` with ${speakerName}` : ""}`
    )
    this.#setMode("prompt")
  }

  showTurn(turn: DialogueTurn, options: DialogueTurnViewOptions = {}): void {
    if (this.#disposed) return
    const speakerName = visibleText(turn.speaker.name) ?? "Unknown speaker"
    const speakerTitle = visibleText(turn.speaker.title)
    const topic = visibleText(
      options.topic === undefined ? turn.metadata?.topic ?? this.#defaultTopic : options.topic
    )
    const progress = options.progress === undefined
      ? turn.metadata?.progress
      : options.progress ?? undefined
    const rawHint = visibleText(
      options.nextHint === undefined
        ? turn.metadata?.nextHint ?? this.#defaultNextHint
        : options.nextHint
    )
    const nextHint = rawHint ? localizeInteractText(rawHint) : null

    this.#mark.textContent = Array.from(speakerName)[0]?.toLocaleUpperCase() ?? "•"
    this.#speakerName.textContent = speakerName
    this.#speakerTitle.textContent = speakerTitle ?? ""
    this.#speakerTitle.hidden = speakerTitle === null
    this.#body.textContent = turn.text
    this.#card.setAttribute("aria-label", `Dialogue from ${speakerName}`)

    this.#setProgress(progress)
    this.#topic.textContent = topic ?? ""
    this.#topic.hidden = topic === null
    this.#nextHint.textContent = nextHint ?? ""
    this.#nextHint.hidden = nextHint === null
    this.#setMode("turn")
  }

  hide(): void {
    if (this.#disposed) return
    this.#mode = "hidden"
    this.#root.dataset.state = "hidden"
    this.#root.hidden = true
    this.#root.setAttribute("aria-hidden", "true")
  }

  /** Project and clamp the active prompt/card. Safe to call while hidden. */
  update(camera: THREE.Camera): void {
    if (this.#disposed || this.#mode === "hidden") return
    if (!this.#resolveWorldAnchor()) {
      this.#setProjectionVisible(false)
      return
    }

    camera.updateWorldMatrix(true, false)
    this.#cameraSpace.copy(this.#world).applyMatrix4(camera.matrixWorldInverse)
    this.#screen.copy(this.#world).project(camera)

    const inFront = this.#cameraSpace.z < 0
    const finite = Number.isFinite(this.#screen.x)
      && Number.isFinite(this.#screen.y)
      && Number.isFinite(this.#screen.z)
    const inDepthRange = this.#screen.z >= -1 && this.#screen.z <= 1
    if (!inFront || !finite || !inDepthRange) {
      this.#setProjectionVisible(false)
      return
    }

    const width = Math.max(1, this.#root.clientWidth || this.#parent.clientWidth || window.innerWidth)
    const height = Math.max(1, this.#root.clientHeight || this.#parent.clientHeight || window.innerHeight)
    const projectedX = (this.#screen.x * 0.5 + 0.5) * width
    const projectedY = (-this.#screen.y * 0.5 + 0.5) * height
    const activePanel = this.#mode === "prompt" ? this.#prompt : this.#card
    const panelRect = activePanel.getBoundingClientRect()
    const rootStyle = getComputedStyle(this.#root)
    const panelStyle = getComputedStyle(activePanel)
    const safeTop = readPixel(rootStyle.paddingTop, MIN_SAFE_INSET)
    const safeRight = readPixel(rootStyle.paddingRight, MIN_SAFE_INSET)
    const safeBottom = readPixel(rootStyle.paddingBottom, MIN_SAFE_INSET)
    const safeLeft = readPixel(rootStyle.paddingLeft, MIN_SAFE_INSET)
    const gap = readPixel(panelStyle.getPropertyValue("--projected-dialogue-anchor-gap"), 18)
    const halfPanelWidth = Math.min(panelRect.width * 0.5, Math.max(0, width - safeLeft - safeRight) * 0.5)
    const x = clamp(
      projectedX,
      safeLeft + halfPanelWidth,
      width - safeRight - halfPanelWidth
    )

    const canFitAbove = projectedY - gap - panelRect.height >= safeTop
    const canFitBelow = projectedY + gap + panelRect.height <= height - safeBottom
    const placeBelow = !canFitAbove && (canFitBelow
      || height - safeBottom - projectedY > projectedY - safeTop)
    const minY = placeBelow ? safeTop - gap : safeTop + panelRect.height + gap
    const maxY = placeBelow
      ? height - safeBottom - panelRect.height - gap
      : height - safeBottom + gap
    const y = clamp(projectedY, minY, maxY)

    this.#pin.classList.toggle("is-below", placeBelow)
    this.#pin.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    this.#setProjectionVisible(true)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#mode = "hidden"
    this.#root.remove()
  }

  #setMode(mode: Exclude<ViewMode, "hidden">): void {
    this.#mode = mode
    this.#root.dataset.state = mode
    this.#prompt.hidden = mode !== "prompt"
    this.#card.hidden = mode !== "turn"
    this.#root.hidden = false
    this.#root.classList.add("is-unpositioned")
    this.#root.classList.remove("is-projection-hidden")
    this.#root.setAttribute("aria-hidden", "false")
  }

  #setProgress(progress: DialogueProgress | undefined): void {
    if (!progress || !Number.isFinite(progress.current) || !Number.isFinite(progress.total)) {
      this.#progress.textContent = ""
      this.#progress.hidden = true
      return
    }

    const current = Math.max(0, Math.round(progress.current))
    const total = Math.max(0, Math.round(progress.total))
    const label = visibleText(progress.label)
    this.#progress.textContent = `${label ? `${label} · ` : ""}${current} / ${total}`
    this.#progress.hidden = false
  }

  #resolveWorldAnchor(): boolean {
    const source = typeof this.#anchor === "function" ? this.#anchor() : this.#anchor
    if (source instanceof THREE.Object3D) source.getWorldPosition(this.#world)
    else this.#world.set(source.x, source.y, source.z)
    this.#world.add(this.#worldOffset)
    return Number.isFinite(this.#world.x)
      && Number.isFinite(this.#world.y)
      && Number.isFinite(this.#world.z)
  }

  #setProjectionVisible(visible: boolean): void {
    this.#root.classList.toggle("is-projection-hidden", !visible)
    this.#root.classList.toggle("is-unpositioned", !visible)
    this.#root.setAttribute("aria-hidden", visible ? "false" : "true")
  }
}
