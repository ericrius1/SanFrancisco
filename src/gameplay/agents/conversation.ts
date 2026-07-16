import * as THREE from "three/webgpu"
import { interactKeyLabel } from "../../core/input"
import {
  ProjectedDialogueUI,
  type DialogueVector3Like,
  type DialogueWorldAnchor,
  type ProjectedDialogueOptions
} from "../../ui/projectedDialogue"
import {
  NoopVoiceOutput,
  type DialogueProvider,
  type DialogueSpeaker,
  type DialogueTurn,
  type VoiceOutput
} from "./dialogue"

/**
 * NpcConversation — the reusable talk-to-an-NPC session every stationary
 * speaker in the world shares (the Corona Heights buskers are the pilot).
 *
 * It owns the projected prompt/card UI, the provider lifecycle (fresh provider
 * per conversation, abort-safe for future model-backed providers), and the
 * player-decision layer: turns that carry `choices` pause on a selectable
 * list, ↑/↓ (or pad nav) moves the highlight, and the interact key confirms.
 * A confirmed choice's `action` fires through `onAction` *before* the next
 * turn is requested, so the world can react while the reply appears.
 *
 * Hosts drive it with four calls:
 *   - `tryInteract(player, mode)` on the interact press (returns true if consumed)
 *   - `navigate(dy)` from the nav keys (returns true while a choice list is up)
 *   - `update(playerPos)` once per sim frame
 *   - `project(camera)` once per rendered frame
 *
 * Per-place personality comes from the dialogue graph content and the
 * `ui.className` theme hook — not from subclassing.
 */

export type NpcConversationPhase = "idle" | "talking"

type PlayerPositionLike = DialogueVector3Like

export interface NpcConversationOptions {
  readonly speaker: DialogueSpeaker
  readonly conversationId: string
  /** World anchor the prompt/card pins to (object, point, or getter). */
  readonly anchor: DialogueWorldAnchor
  readonly worldOffset?: DialogueVector3Like
  /** Built fresh at the start of every conversation. */
  readonly createProvider: () => DialogueProvider
  /** Prompt copy while idle (a getter keeps live state, e.g. "Ask for another"). */
  readonly promptLabel: string | (() => string)
  /** Extra gate on the idle prompt (e.g. hide while the band is mid-song). */
  readonly available?: () => boolean
  readonly voiceOutput?: VoiceOutput
  readonly ui?: ProjectedDialogueOptions
  /** Show the prompt / accept the opening interact inside this range. */
  readonly startRange?: number
  /** Keep an active conversation alive inside this range; walking out cancels. */
  readonly cardRange?: number
  /** Interact is only honored in these player modes. Defaults to ["walk"]. */
  readonly modes?: readonly string[]
  /** Fired for choice `action`s (on confirm) and `action:*` turn tags (on show). */
  readonly onAction?: (action: string, turn: DialogueTurn | null) => void
  readonly onEnd?: (reason: "finished" | "cancelled") => void
}

const DEFAULT_START_RANGE = 8.5
const DEFAULT_CARD_RANGE = 15
const tmpAnchor = new THREE.Vector3()

function distanceXZ(a: PlayerPositionLike, b: THREE.Vector3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

export class NpcConversation {
  readonly #opts: NpcConversationOptions
  readonly #ui: ProjectedDialogueUI
  readonly #voice: VoiceOutput
  readonly #startRange: number
  readonly #cardRange: number
  readonly #modes: readonly string[]
  readonly #history: DialogueTurn[] = []

  #phase: NpcConversationPhase = "idle"
  #provider: DialogueProvider | null = null
  #turn: DialogueTurn | null = null
  #choiceIndex = 0
  #playerDistance = Number.POSITIVE_INFINITY
  #worldVisible = true
  #busy = false
  #disposed = false
  #requestSerial = 0
  #requestAbort: AbortController | null = null
  #voiceAbort: AbortController | null = null

  constructor(options: NpcConversationOptions) {
    this.#opts = options
    this.#voice = options.voiceOutput ?? new NoopVoiceOutput()
    this.#startRange = options.startRange ?? DEFAULT_START_RANGE
    this.#cardRange = options.cardRange ?? DEFAULT_CARD_RANGE
    this.#modes = options.modes ?? ["walk"]
    this.#ui = new ProjectedDialogueUI(options.anchor, {
      worldOffset: options.worldOffset,
      ...options.ui
    })
  }

  get phase(): NpcConversationPhase {
    return this.#phase
  }

  get active(): boolean {
    return this.#phase === "talking"
  }

  /** True while a choice list is on screen awaiting a decision. */
  get choosing(): boolean {
    return this.#phase === "talking" && (this.#turn?.choices?.length ?? 0) > 0
  }

  setWorldVisible(visible: boolean): void {
    this.#worldVisible = visible
    if (!visible) this.#ui.hide()
  }

  /** Interact-key press. Returns true when this conversation consumed it. */
  tryInteract(player: PlayerPositionLike, mode: string): boolean {
    if (this.#disposed || !this.#worldVisible || !this.#modes.includes(mode)) return false
    this.#playerDistance = this.#anchorDistance(player)

    if (this.#phase === "idle") {
      if (this.#playerDistance > this.#startRange) return false
      if (this.#opts.available && !this.#opts.available()) return false
      this.#begin()
      return true
    }

    if (this.#playerDistance > this.#cardRange) return false
    // Consume repeated presses while a provider is still working so nearby
    // doors/vehicles never receive an intent aimed at this speaker.
    if (this.#busy) return true
    this.#advance()
    return true
  }

  /**
   * Confirm the highlighted reply / advance the current turn without the
   * interact key — wired to Enter as the primary "select" gesture, so the same
   * key that submits a choice list everywhere else works here. Talking only;
   * consumes the key whenever a card is open (even mid-request) so Enter never
   * leaks to chat/minimap while the conversation owns the screen.
   */
  confirm(): boolean {
    if (this.#disposed || !this.active) return false
    if (!this.#busy) this.#advance()
    return true
  }

  /** Leave the conversation immediately (wired to Esc). True if one was open. */
  close(): boolean {
    if (this.#disposed || !this.active) return false
    this.#end("cancelled")
    return true
  }

  #advance(): void {
    const choices = this.#turn?.choices
    if (choices?.length) {
      const chosen = choices[Math.min(this.#choiceIndex, choices.length - 1)]
      if (chosen?.action) this.#opts.onAction?.(chosen.action, this.#turn)
      void this.#requestNextTurn(chosen?.id)
    } else {
      void this.#requestNextTurn()
    }
  }

  /** ↑/↓ (or pad nav) while a choice list is showing. True when consumed. */
  navigate(dy: number): boolean {
    if (!this.choosing || dy === 0) return false
    const count = this.#turn?.choices?.length ?? 0
    if (count === 0) return false
    this.#choiceIndex = (this.#choiceIndex + (dy > 0 ? 1 : -1) + count) % count
    return true
  }

  /** Per-sim-frame: distance bookkeeping + walk-away cancellation. */
  update(player: PlayerPositionLike): void {
    if (this.#disposed) return
    this.#playerDistance = this.#anchorDistance(player)
    if (this.#phase === "talking" && this.#playerDistance > this.#cardRange) {
      this.#end("cancelled")
    }
  }

  /** Per-rendered-frame: refresh presentation and reproject onto the screen. */
  project(camera: THREE.Camera): void {
    if (this.#disposed) return
    this.#syncPresentation()
    this.#ui.update(camera)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#requestSerial += 1
    this.#requestAbort?.abort()
    this.#stopVoice()
    void this.#voice.dispose()
    this.#ui.dispose()
  }

  #anchorDistance(player: PlayerPositionLike): number {
    const source = typeof this.#opts.anchor === "function" ? this.#opts.anchor() : this.#opts.anchor
    const point = source instanceof THREE.Object3D ? source.getWorldPosition(tmpAnchor) : source
    return distanceXZ(player, point)
  }

  #begin(): void {
    this.#requestAbort?.abort()
    this.#requestAbort = null
    this.#history.length = 0
    this.#provider = this.#opts.createProvider()
    this.#turn = null
    this.#choiceIndex = 0
    this.#phase = "talking"
    void this.#requestNextTurn()
  }

  #end(reason: "finished" | "cancelled"): void {
    this.#requestSerial += 1
    this.#requestAbort?.abort()
    this.#requestAbort = null
    this.#stopVoice()
    this.#provider = null
    this.#turn = null
    this.#choiceIndex = 0
    this.#busy = false
    this.#phase = "idle"
    this.#ui.hide()
    this.#opts.onEnd?.(reason)
  }

  async #requestNextTurn(input?: string): Promise<void> {
    if (!this.#provider || this.#busy || this.#disposed) return
    this.#busy = true
    this.#stopVoice()
    this.#requestAbort?.abort()
    const controller = new AbortController()
    this.#requestAbort = controller
    const serial = ++this.#requestSerial

    try {
      const next = await this.#provider.nextTurn(
        {
          agentId: this.#opts.speaker.id,
          conversationId: this.#opts.conversationId,
          input,
          history: this.#history
        },
        controller.signal
      )
      if (this.#disposed || controller.signal.aborted || serial !== this.#requestSerial) return
      if (!next) {
        this.#busy = false
        if (this.#requestAbort === controller) this.#requestAbort = null
        this.#end("finished")
        return
      }
      this.#turn = next
      this.#choiceIndex = 0
      this.#history.push(next)
      for (const tag of next.metadata?.tags ?? []) {
        if (tag.startsWith("action:")) this.#opts.onAction?.(tag.slice("action:".length), next)
      }
      this.#startVoice(next)
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn(`[conversation:${this.#opts.conversationId}] provider failed`, error)
        this.#end("cancelled")
      }
    } finally {
      if (serial === this.#requestSerial) {
        this.#busy = false
        if (this.#requestAbort === controller) this.#requestAbort = null
      }
    }
  }

  #syncPresentation(): void {
    if (!this.#worldVisible) {
      this.#ui.hide()
      return
    }

    if (this.#phase === "idle") {
      const available = !this.#opts.available || this.#opts.available()
      if (available && this.#playerDistance <= this.#startRange) {
        // Re-shown every frame so a mid-prompt kb↔pad switch refreshes glyphs.
        const label = this.#opts.promptLabel
        this.#ui.showPrompt({
          speaker: this.#opts.speaker,
          key: interactKeyLabel(),
          label: typeof label === "function" ? label() : label
        })
      } else {
        this.#ui.hide()
      }
      return
    }

    if (this.#playerDistance > this.#cardRange) {
      this.#ui.hide()
      return
    }
    if (this.#busy && !this.#turn) {
      this.#ui.showPrompt({ speaker: this.#opts.speaker, key: "", label: "…" })
      return
    }
    if (this.#turn) {
      this.#ui.showTurn(this.#turn, { choiceIndex: this.#choiceIndex })
    }
  }

  #stopVoice(): void {
    this.#voiceAbort?.abort()
    this.#voiceAbort = null
    void this.#voice.stop()
  }

  #startVoice(turn: DialogueTurn): void {
    this.#stopVoice()
    const controller = new AbortController()
    this.#voiceAbort = controller
    void this.#voice.speak(turn, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn(`[conversation:${this.#opts.conversationId}] voice failed`, error)
      }
    })
  }
}
