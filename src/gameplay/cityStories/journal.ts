import type { ListeningEntry } from './memory';
import './journal.css';

interface StoryJournalOptions {
  entries: () => ListeningEntry[];
  places: readonly { id: string; label: string; x: number; z: number }[];
  onVisit: (placeId: string) => void;
  onClose: () => void;
}

let nextJournalId = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Loaded by the notebook shell on demand; reads only local memory and place metadata. */
export class StoryJournal {
  readonly #options: StoryJournalOptions;
  readonly #dialog = element('dialog', 'story-journal');
  readonly #pages = element('div', 'story-journal__pages');
  readonly #closeButton = element('button', 'story-journal__button', 'Close');
  readonly #listeners = new AbortController();
  #priorFocus: HTMLElement | SVGElement | null = null;
  #isOpen = false;
  #disposed = false;

  constructor(options: StoryJournalOptions) {
    this.#options = options;
    const id = `story-journal-${++nextJournalId}`;
    const header = element('header', 'story-journal__header');
    const heading = element('h1', 'story-journal__title', 'People of the city');
    heading.id = `${id}-title`;
    const intro = element('p', 'story-journal__intro',
      'Every place holds a life. Walk up to someone and press E to listen.');
    intro.id = `${id}-intro`;
    this.#dialog.setAttribute('aria-labelledby', heading.id);
    this.#dialog.setAttribute('aria-describedby', intro.id);
    this.#closeButton.type = 'button';
    this.#closeButton.autofocus = true;
    this.#closeButton.setAttribute('aria-label', 'Close journal');
    header.append(heading, this.#closeButton);
    this.#dialog.append(header, this.#pages);
    this.#pages.before(intro);

    const listenerOptions = { signal: this.#listeners.signal };
    this.#closeButton.addEventListener('click', () => this.close(), listenerOptions);
    // Keep key presses out of gameplay. Releases must reach Input so a key
    // held before opening cannot remain stuck after the modal closes.
    for (const type of ['keydown', 'keypress'] as const) {
      this.#dialog.addEventListener(type, event => event.stopPropagation(), listenerOptions);
    }
    this.#dialog.addEventListener('cancel', event => {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }, listenerOptions);
    this.#dialog.addEventListener('close', () => {
      // A queued close event from an earlier opening must not close a new one.
      if (!this.#dialog.open) this.#finishClose();
    }, listenerOptions);
  }

  open(): void {
    if (this.#disposed || this.#isOpen) return;
    this.#render();
    const active = document.activeElement;
    this.#priorFocus = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    if (!this.#dialog.isConnected) document.body.append(this.#dialog);
    this.#dialog.showModal();
    this.#isOpen = true;
    this.#pages.scrollTop = 0;
    this.#closeButton.focus({ preventScroll: true });
  }

  close(): boolean {
    if (!this.#isOpen) return false;
    this.#dialog.close();
    this.#finishClose();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.close();
    } finally {
      this.#listeners.abort();
      this.#dialog.remove();
      this.#pages.replaceChildren();
      this.#priorFocus = null;
    }
  }

  #finishClose(): void {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    const priorFocus = this.#priorFocus;
    this.#priorFocus = null;
    if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
    this.#options.onClose();
  }

  #render(): void {
    const notes = element('section', 'story-journal__section');
    notes.append(element('h2', 'story-journal__heading', 'People you remember'));
    const entries = this.#options.entries();
    if (entries.length === 0) {
      notes.append(element('p', 'story-journal__empty',
        'These pages are still quiet. Find someone in the city and take a moment to listen. Their words will stay here.'));
    } else {
      const list = element('ul', 'story-journal__notes');
      for (const entry of entries) {
        const item = element('li', 'story-journal__note');
        item.append(
          element('h3', 'story-journal__name', entry.name),
          element('p', 'story-journal__place', entry.place),
          element('p', 'story-journal__text', entry.lastText),
        );
        list.append(item);
      }
      notes.append(list);
    }

    const discovery = element('section', 'story-journal__section');
    discovery.append(element('h2', 'story-journal__heading', 'Places to wander'));
    const places = element('ul', 'story-journal__places');
    for (const place of this.#options.places) {
      const row = element('li', 'story-journal__destination');
      const visit = element('button', 'story-journal__button', 'Visit');
      visit.type = 'button';
      visit.setAttribute('aria-label', `Visit ${place.label}`);
      visit.addEventListener('click', () => {
        this.close();
        this.#options.onVisit(place.id);
      }, { once: true });
      row.append(element('span', 'story-journal__destination-name', place.label), visit);
      places.append(row);
    }
    if (this.#options.places.length) discovery.append(places);
    else discovery.append(element('p', 'story-journal__empty', 'Let a walk through the city lead you to a conversation.'));
    this.#pages.replaceChildren(notes, discovery);
  }
}
