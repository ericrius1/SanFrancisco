import { DialogueGraphProvider, type DialogueProvider } from '../agents/dialogue.ts';
import type { ListeningMemory } from './memory.ts';
import type { ResidentStory, StoryChapter } from './types.ts';

/** Content selection is separate from identity, embodiment, memory and UI.
 * A later chapter resolver/provider can use time and world events here without
 * replacing the city's resident runtime or migrating its stable speaker IDs. */
export function createResidentProvider(
  resident: ResidentStory, chapter: StoryChapter, memory: ListeningMemory
): DialogueProvider {
  const returning = memory.hasMet(resident.id);
  const connected = memory.hasHeard(resident.connection.residentId);
  const choices = [
    { id: 'everyday', label: resident.everyday.question, to: 'everyday' },
    { id: 'reflection', label: resident.reflection.question, to: 'reflection' },
    { id: 'connection', label: resident.connection.question, to: 'connection' },
    { id: 'leave', label: 'I’ll let you get back to it.', to: 'farewell' }
  ];
  const metadata = (beat: string) => ({
    topic: beat.startsWith('connection') ? resident.connection.thread.replaceAll('-', ' ') : 'A life in the city',
    source: `authored:${chapter.id}@${chapter.revision}`,
    tags: [`action:remember:${beat}`]
  });
  return new DialogueGraphProvider({ speaker: resident.speaker, nodes: [
    { id: 'hello', text: returning ? resident.returnGreeting : resident.greeting,
      choices, metadata: metadata('hello') },
    { id: 'everyday', text: resident.everyday.text, choices, metadata: metadata('everyday') },
    { id: 'reflection', text: resident.reflection.text, choices, metadata: metadata('reflection') },
    { id: 'connection', text: connected ? resident.connection.heard : resident.connection.unheard,
      choices, metadata: metadata(connected ? 'connection-heard' : 'connection') },
    { id: 'farewell', text: resident.farewell, metadata: { topic: 'Until next time' } }
  ] });
}
