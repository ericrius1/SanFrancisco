export type BehindTheScenesHandle = {
  readonly isOpen: boolean;
  open(sub?: string): void;
  setOpen(open: boolean): void;
  whenReady(): Promise<void>;
};

type ToggleListener = (open: boolean) => void;

let reader: BehindTheScenesHandle | null = null;
let readerLoad: Promise<BehindTheScenesHandle> | null = null;
const toggleListeners = new Set<ToggleListener>();

function notifyToggle(open: boolean): void {
  // `body.reading` is only for a reader opened before game entry. Normal
  // in-world opens must keep the rest of the HUD visible.
  if (!open) document.body.classList.remove("reading");
  for (const listener of toggleListeners) listener(open);
}

/** One reader instance shared by the early route and the in-world launcher. */
export function ensureBehindTheScenes(): Promise<BehindTheScenesHandle> {
  if (reader) return Promise.resolve(reader);
  if (!readerLoad) {
    readerLoad = import("./behindTheScenes")
      .then(({ BehindTheScenes }) => {
        reader ??= new BehindTheScenes(notifyToggle);
        return reader;
      })
      .catch((error) => {
        readerLoad = null;
        throw error;
      });
  }
  return readerLoad;
}

export function getBehindTheScenes(): BehindTheScenesHandle | null {
  return reader;
}

export function subscribeBehindTheScenes(listener: ToggleListener): () => void {
  toggleListeners.add(listener);
  // An early reading route can already be open by the time main.ts is loaded.
  if (reader) listener(reader.isOpen);
  return () => toggleListeners.delete(listener);
}

export async function openBehindTheScenes(sub?: string, waitForChapter = false): Promise<void> {
  const instance = await ensureBehindTheScenes();
  instance.open(sub);
  if (waitForChapter) await instance.whenReady();
}
