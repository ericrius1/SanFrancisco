/** Stable speaker identity shared by scripted and model-backed dialogue. */
export interface DialogueSpeaker {
  readonly id: string
  readonly name: string
  readonly title?: string
}

/** Optional ordered-position data for a topic, tour, or conversation chapter. */
export interface DialogueProgress {
  readonly current: number
  readonly total: number
  readonly label?: string
}

/**
 * Presentation-friendly metadata that remains open to future agent/model data.
 * Known fields drive the projected dialogue UI; extra fields travel untouched.
 */
export interface DialogueTurnMetadata {
  readonly topic?: string
  readonly progress?: DialogueProgress
  readonly nextHint?: string
  readonly landmarkId?: string
  readonly source?: string
  readonly tags?: readonly string[]
  readonly [key: string]: unknown
}

/** One complete, speaker-attributed piece of dialogue. */
export interface DialogueTurn {
  readonly id: string
  readonly speaker: DialogueSpeaker
  readonly text: string
  readonly metadata?: DialogueTurnMetadata
}

/** Input passed to a provider for each requested turn. */
export interface DialogueRequest {
  readonly agentId: string
  readonly conversationId: string
  readonly input?: string
  readonly history: readonly DialogueTurn[]
  readonly context?: Readonly<Record<string, unknown>>
}

/**
 * Async seam for deterministic scripts, remote models, or local models.
 * Implementations must pass `signal` through to fetch/model work and reject
 * promptly when it is aborted. `null` means the conversation is exhausted.
 */
export interface DialogueProvider {
  nextTurn(request: DialogueRequest, signal: AbortSignal): Promise<DialogueTurn | null>
  reset?(): void | Promise<void>
}

/** Pluggable speech output; text presentation does not depend on this existing. */
export interface VoiceOutput {
  speak(turn: DialogueTurn, signal: AbortSignal): Promise<void>
  stop(): void | Promise<void>
  dispose(): void | Promise<void>
}

/** Default voice implementation for silent/text-only conversations. */
export class NoopVoiceOutput implements VoiceOutput {
  async speak(_turn: DialogueTurn, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
  }

  stop(): void {}

  dispose(): void {}
}

export interface ScriptedDialogueProviderOptions {
  /** Repeat from the first turn after the final turn. Defaults to false. */
  readonly loop?: boolean
}

/** Ordered static dialogue with the same async contract as a model provider. */
export class ScriptedDialogueProvider implements DialogueProvider {
  readonly #turns: readonly DialogueTurn[]
  readonly #loop: boolean
  #cursor = 0

  constructor(
    turns: readonly DialogueTurn[],
    options: ScriptedDialogueProviderOptions = {}
  ) {
    this.#turns = [...turns]
    this.#loop = options.loop ?? false
  }

  get position(): number {
    return this.#cursor
  }

  get remaining(): number {
    if (this.#loop && this.#turns.length > 0) return Number.POSITIVE_INFINITY
    return Math.max(0, this.#turns.length - this.#cursor)
  }

  async nextTurn(
    _request: DialogueRequest,
    signal: AbortSignal
  ): Promise<DialogueTurn | null> {
    signal.throwIfAborted()
    if (this.#turns.length === 0) return null

    if (this.#cursor >= this.#turns.length) {
      if (!this.#loop) return null
      this.#cursor = 0
    }

    const turn = this.#turns[this.#cursor]
    this.#cursor += 1
    signal.throwIfAborted()
    return turn
  }

  reset(): void {
    this.#cursor = 0
  }
}
