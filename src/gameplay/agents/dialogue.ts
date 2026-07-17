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

/**
 * One selectable reply the player can pick while a turn is showing. `action`
 * names a game-side effect fired the moment the choice is confirmed — before
 * the provider is asked for the follow-up turn — so the world can react
 * (start the song, open the gate) while the reply text appears.
 */
export interface DialogueChoice {
  readonly id: string
  readonly label: string
  readonly action?: string
}

/** One complete, speaker-attributed piece of dialogue. */
export interface DialogueTurn {
  readonly id: string
  readonly speaker: DialogueSpeaker
  readonly text: string
  readonly metadata?: DialogueTurnMetadata
  /** When present the turn waits on a player decision instead of a plain
   * continue; the confirmed choice's id is passed back as the next
   * `DialogueRequest.input`. */
  readonly choices?: readonly DialogueChoice[]
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

/** A choice inside a graph node: the base choice plus where it leads.
 * `to: null` (or omitted) ends the conversation after the choice. */
export interface DialogueGraphChoice extends DialogueChoice {
  readonly to?: string | null
}

/**
 * One authored beat in a branching conversation. `text` may be a function so
 * lines can reference live game state (the song about to play, the time of
 * day) at the moment the turn is delivered — after any choice `action` has
 * already fired.
 */
export interface DialogueGraphNode {
  readonly id: string
  readonly text: string | (() => string)
  readonly speaker?: DialogueSpeaker
  readonly metadata?: DialogueTurnMetadata
  readonly choices?: readonly DialogueGraphChoice[]
  /** Linear continuation for choice-less nodes; null/omitted ends here. */
  readonly next?: string | null
}

export interface DialogueGraphOptions {
  readonly speaker: DialogueSpeaker
  readonly nodes: readonly DialogueGraphNode[]
  /** Node id to start from. Defaults to the first node. */
  readonly entry?: string
}

/**
 * Branching scripted dialogue with the same async contract as a model
 * provider. Advancing a choice-less node follows `next`; advancing a node
 * with choices routes through the choice whose id matches `request.input`.
 * Exhausted (or dead-end) paths resolve null, ending the conversation.
 */
export class DialogueGraphProvider implements DialogueProvider {
  readonly #speaker: DialogueSpeaker
  readonly #nodes = new Map<string, DialogueGraphNode>()
  readonly #entry: string
  #current: DialogueGraphNode | null = null
  #started = false

  constructor(options: DialogueGraphOptions) {
    this.#speaker = options.speaker
    for (const node of options.nodes) this.#nodes.set(node.id, node)
    this.#entry = options.entry ?? options.nodes[0]?.id ?? ""
  }

  async nextTurn(
    request: DialogueRequest,
    signal: AbortSignal
  ): Promise<DialogueTurn | null> {
    signal.throwIfAborted()

    let nextId: string | null | undefined
    if (!this.#started) {
      this.#started = true
      nextId = this.#entry
    } else if (this.#current?.choices?.length) {
      const chosen = this.#current.choices.find((choice) => choice.id === request.input)
      nextId = chosen ? chosen.to ?? null : this.#current.choices[0]?.to ?? null
    } else {
      nextId = this.#current?.next ?? null
    }

    const node = nextId ? this.#nodes.get(nextId) ?? null : null
    this.#current = node
    if (!node) return null

    signal.throwIfAborted()
    return {
      id: node.id,
      speaker: node.speaker ?? this.#speaker,
      text: typeof node.text === "function" ? node.text() : node.text,
      metadata: node.metadata,
      choices: node.choices
    }
  }

  reset(): void {
    this.#current = null
    this.#started = false
  }
}
