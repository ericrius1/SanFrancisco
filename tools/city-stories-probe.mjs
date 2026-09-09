// Run: node --experimental-strip-types tools/city-stories-probe.mjs
// Pure Node contract probe: no renderer, places.ts, DOM, or real localStorage.
// Type stripping does not type-check interfaces; validate authored data below.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { ListeningMemory } from '../src/gameplay/cityStories/memory.ts';
import { createResidentProvider } from '../src/gameplay/cityStories/provider.ts';

const chapterDirectory = new URL('../src/gameplay/cityStories/chapters/', import.meta.url);
const filenames = (await readdir(chapterDirectory, { withFileTypes: true }))
  .filter(file => file.isFile() && file.name.endsWith('.ts') && !file.name.endsWith('.d.ts'))
  .map(file => file.name).sort();
// Keep import failures local so memory tests still run while content is landing.
const imports = await Promise.allSettled(filenames.map(file => import(new URL(file, chapterDirectory).href)));
const chapters = imports.flatMap((result, i) => result.status === 'fulfilled'
  ? [{ file: filenames[i], chapter: result.value.default }] : []);
const roster = chapters.flatMap(({ chapter }) => Array.isArray(chapter?.residents)
  ? chapter.residents.map(resident => ({ resident, chapter })) : []);
const byId = new Map(roster.map(pair => [pair.resident.id, pair]));
const storageKey = 'sf.city-stories.v1';
const branchIds = ['everyday', 'reflection', 'connection', 'leave'];
const nodeIds = ['hello', 'everyday', 'reflection', 'connection'];

function nonempty(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must not be blank`);
}

function storage(initial = null) {
  let raw = initial;
  const writes = [];
  return {
    writes,
    getItem(key) { assert.equal(key, storageKey); return raw; },
    setItem(key, value) { assert.equal(key, storageKey); writes.push(value); raw = value; },
  };
}

function entry(overrides = {}) {
  return { id: 'test-resident', name: 'Test Resident', place: 'Test Place', chapter: 'test-chapter',
    revision: 1, heardReflection: false, lastText: 'A greeting.', ...overrides };
}

function session(resident, chapter, memory) {
  const provider = createResidentProvider(resident, chapter, memory);
  const history = [];
  return {
    provider,
    async next(input, signal = new AbortController().signal) {
      const turn = await provider.nextTurn({ agentId: resident.id,
        conversationId: `city:${resident.id}`, history: [...history], input }, signal);
      if (turn) history.push(turn);
      return turn;
    },
  };
}

// The runtime owns this adapter, not the provider. Exercise its public tag ->
// memory seam without importing the world runtime. Place labels are display text;
// chapter IDs suffice here because this probe deliberately never imports places.
function listen(memory, resident, chapter, turn) {
  assert.ok(turn, 'cannot listen to an exhausted conversation');
  for (const tag of turn.metadata?.tags ?? []) {
    if (!tag.startsWith('action:remember:')) continue;
    const beat = tag.slice('action:remember:'.length);
    memory.remember({ id: resident.id, name: resident.speaker.name, place: chapter.id,
      chapter: chapter.id, revision: chapter.revision,
      heardReflection: beat === 'reflection', lastText: turn.text }, beat);
  }
}

function checkTurn(turn, resident, chapter, node, { returning = false, connected = false } = {}) {
  assert.ok(turn, `${resident.id}: missing ${node} turn`);
  assert.equal(turn.id, node);
  assert.deepEqual(turn.speaker, resident.speaker, `${node}: speaker identity changed`);
  const expectedText = {
    hello: returning ? resident.returnGreeting : resident.greeting,
    everyday: resident.everyday.text,
    reflection: resident.reflection.text,
    connection: connected ? resident.connection.heard : resident.connection.unheard,
    farewell: resident.farewell,
  };
  assert.equal(turn.text, expectedText[node], `${resident.id}: wrong ${node} text`);
  if (node === 'farewell') {
    assert.equal(turn.choices?.length ?? 0, 0, 'farewell must terminate');
    assert.ok(!(turn.metadata?.tags ?? []).some(tag => tag.startsWith('action:remember:')),
      'farewell must not record an unspoken story beat');
    return;
  }
  assert.deepEqual(turn.choices?.map(choice => choice.id), branchIds);
  for (const choice of turn.choices) {
    nonempty(choice.label, `${node}/${choice.id} label`);
    if (choice.id !== 'leave') assert.equal(choice.label, resident[choice.id].question);
  }
  const beat = node === 'connection' && connected ? 'connection-heard' : node;
  assert.equal(turn.metadata?.source, `authored:${chapter.id}@${chapter.revision}`);
  assert.deepEqual(turn.metadata?.tags, [`action:remember:${beat}`]);
  // Topic is presentation text, not the stable thread ID used by cross-refs.
  nonempty(turn.metadata?.topic, `${node} topic`);
}

test('type-only contract module imports under Node type stripping', async () => {
  await import('../src/gameplay/cityStories/types.ts');
});

test('all 16 chapters dynamically import via explicit .ts URLs', () => {
  const failures = imports.flatMap((result, i) => result.status === 'rejected'
    ? [`${filenames[i]}: ${result.reason?.stack ?? result.reason}`] : []);
  assert.deepEqual(failures, [], 'chapter import failures');
  assert.equal(filenames.length, 16, `expected 16 chapter files; found ${filenames.join(', ')}`);
  assert.equal(chapters.length, 16);
  assert.equal(new Set(chapters.map(({ chapter }) => chapter.id)).size, 16, 'duplicate chapter IDs');
});

test('32 unique resident IDs and speaker identities', () => {
  assert.equal(roster.length, 32, 'expected two residents per chapter, 32 total');
  assert.equal(byId.size, 32, 'resident IDs must be globally unique');
  assert.equal(new Set(roster.map(({ resident }) => resident.speaker.id)).size, 32,
    'speaker IDs must be globally unique');
});

for (const { file, chapter } of chapters) {
  test(`chapter shape: ${file}`, () => {
    assert.ok(chapter && typeof chapter === 'object', 'missing default chapter export');
    assert.equal(chapter.id, file.slice(0, -3), 'chapter ID must match filename');
    assert.ok(Number.isInteger(chapter.revision) && chapter.revision > 0, 'invalid revision');
    assert.equal(chapter.residents.length, 2);
    for (const resident of chapter.residents) {
      nonempty(resident.id, 'resident.id');
      assert.equal(resident.speaker.id, resident.id);
      nonempty(resident.speaker.name, `${resident.id}.speaker.name`);
      if (resident.speaker.title !== undefined) nonempty(resident.speaker.title, 'speaker.title');
      assert.ok(['watch', 'chat', 'read', 'stretch'].includes(resident.activity), 'invalid activity');
      for (const key of ['seed', 'greeting', 'returnGreeting', 'farewell']) nonempty(resident[key], `${resident.id}.${key}`);
      assert.notEqual(resident.greeting, resident.returnGreeting, 'repeat greeting must be distinct');
      for (const branch of ['everyday', 'reflection']) {
        for (const key of ['question', 'text']) nonempty(resident[branch]?.[key], `${resident.id}.${branch}.${key}`);
      }
      for (const key of ['residentId', 'name', 'place', 'thread', 'question', 'unheard', 'heard']) {
        nonempty(resident.connection?.[key], `${resident.id}.connection.${key}`);
      }
      assert.notEqual(resident.connection.heard, resident.connection.unheard, 'connection variants must differ');
    }
  });
}

for (const { resident, chapter } of roster) {
  test(`cross-reference: ${resident.id} -> ${resident.connection.residentId}`, () => {
    const target = byId.get(resident.connection.residentId);
    assert.ok(target, `missing linked resident ${resident.connection.residentId}`);
    assert.notEqual(target.resident.id, resident.id, 'connection must refer to another resident');
    assert.equal(resident.connection.name, target.resident.speaker.name, 'linked name/identity mismatch');
    // References may form directed rings, not necessarily reciprocal pairs.
    assert.equal(resident.connection.thread, target.resident.connection.thread, 'linked narrative thread mismatch');
  });

  test(`every branch edge, farewell, reset and memory tags: ${resident.id}`, async () => {
    // Every outgoing edge from hello and all three nonterminal branches (16
    // edges per resident), including self-loops and switching branch order.
    for (const source of nodeIds) {
      for (const choice of branchIds) {
        const memory = new ListeningMemory();
        const chat = session(resident, chapter, memory);
        checkTurn(await chat.next(), resident, chapter, 'hello');
        if (source !== 'hello') checkTurn(await chat.next(source), resident, chapter, source);
        const node = choice === 'leave' ? 'farewell' : choice;
        const turn = await chat.next(choice);
        checkTurn(turn, resident, chapter, node);
        assert.deepEqual(memory.entries(), [], 'provider must not persist before the runtime accepts the turn');
        listen(memory, resident, chapter, turn);
        assert.equal(memory.hasMet(resident.id), node !== 'farewell');
        assert.equal(memory.hasHeard(resident.id), node === 'reflection');
        if (node !== 'farewell') {
          const remembered = memory.entries()[0];
          assert.equal(remembered.lastText, turn.text);
          assert.deepEqual(remembered.beats, [`${chapter.id}@${chapter.revision}:${node}`]);
          checkTurn(await chat.next('leave'), resident, chapter, 'farewell');
        }
        assert.equal(await chat.next(), null);
        assert.equal(await chat.next('reflection'), null, 'exhausted provider must stay exhausted');
        await chat.provider.reset();
        // reset restarts this provider's snapshot; a new conversation constructs
        // a new provider to pick up changed memory (as runtime.ts does).
        checkTurn(await chat.next(), resident, chapter, 'hello');
      }
    }
  });

  test(`repeat greetings and connected vs merely met/unheard: ${resident.id}`, async () => {
    const target = byId.get(resident.connection.residentId);
    assert.ok(target, `missing linked resident ${resident.connection.residentId}`);
    const saved = storage();
    let memory = new ListeningMemory(saved);
    const first = session(resident, chapter, memory);
    const hello = await first.next();
    checkTurn(hello, resident, chapter, 'hello');
    listen(memory, resident, chapter, hello);
    const unheard = await first.next('connection');
    checkTurn(unheard, resident, chapter, 'connection');
    listen(memory, resident, chapter, unheard);
    assert.equal(memory.hasMet(target.resident.id), false, 'hearing about somebody does not meet them');
    assert.equal(memory.hasHeard(target.resident.id), false, 'hearing about somebody does not hear their reflection');
    const linked = session(target.resident, target.chapter, memory);
    listen(memory, target.resident, target.chapter, await linked.next());
    listen(memory, target.resident, target.chapter, await linked.next('everyday'));
    assert.equal(memory.hasMet(target.resident.id), true);
    assert.equal(memory.hasHeard(target.resident.id), false);
    const metOnly = session(resident, chapter, memory);
    checkTurn(await metOnly.next(), resident, chapter, 'hello', { returning: true });
    checkTurn(await metOnly.next('connection'), resident, chapter, 'connection');
    listen(memory, target.resident, target.chapter, await linked.next('reflection'));
    // Later everyday beats must not erase the reflection flag.
    listen(memory, target.resident, target.chapter, await linked.next('connection'));
    assert.equal(memory.hasHeard(target.resident.id), true);
    memory = new ListeningMemory(saved);
    const connected = session(resident, chapter, memory);
    checkTurn(await connected.next(), resident, chapter, 'hello', { returning: true });
    const heard = await connected.next('connection');
    checkTurn(heard, resident, chapter, 'connection', { connected: true });
    listen(memory, resident, chapter, heard);
    const remembered = memory.entries().find(item => item.id === resident.id);
    assert.ok(remembered.beats.includes(`${chapter.id}@${chapter.revision}:connection`));
    assert.ok(remembered.beats.includes(`${chapter.id}@${chapter.revision}:connection-heard`));
    assert.equal(memory.hasHeard(resident.id), false, 'connection does not count as own reflection');
  });

  test(`abort rejects without consuming a greeting or branch: ${resident.id}`, async () => {
    const memory = new ListeningMemory();
    const chat = session(resident, chapter, memory);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(chat.next(undefined, aborted.signal), { name: 'AbortError' });
    checkTurn(await chat.next(), resident, chapter, 'hello');
    for (const choice of branchIds) {
      const reason = new Error(`cancel ${choice}`);
      const controller = new AbortController();
      controller.abort(reason);
      await assert.rejects(chat.next(choice, controller.signal), error => error === reason);
      checkTurn(await chat.next(choice), resident, chapter, choice === 'leave' ? 'farewell' : choice);
    }
    assert.deepEqual(memory.entries(), []);
  });
}

test('persistence reload, deduplication, sticky reflection and defensive entry copies', () => {
  const saved = storage();
  const memory = new ListeningMemory(saved);
  assert.deepEqual(memory.entries(), []);
  assert.equal(memory.hasMet('missing'), false);
  assert.equal(memory.hasHeard('missing'), false);
  memory.remember(entry(), 'hello');
  memory.remember(entry({ lastText: 'Duplicate delivery must not replace text.' }), 'hello');
  assert.equal(saved.writes.length, 1, 'duplicate delivery must not rewrite storage');
  assert.equal(memory.entries()[0].lastText, 'A greeting.');
  memory.remember(entry({ heardReflection: true, lastText: 'A reflection.' }), 'reflection');
  memory.remember(entry({ lastText: 'Ordinary life.' }), 'everyday');
  assert.equal(memory.hasHeard('test-resident'), true);
  const snapshot = memory.entries();
  snapshot[0].name = 'Mutated';
  snapshot[0].beats.push('injected');
  snapshot.pop();
  assert.equal(memory.entries()[0].name, 'Test Resident');
  assert.equal(memory.entries()[0].beats.length, 3);
  assert.deepEqual(new ListeningMemory(saved).entries(), memory.entries());
  assert.equal(JSON.parse(saved.writes.at(-1)).version, 1);
});

test('revisions retain remembered identity and reflection but allow new deliveries of the same beat', async () => {
  const saved = storage();
  const memory = new ListeningMemory(saved);
  memory.remember(entry({ heardReflection: true, lastText: 'Original reflection.' }), 'reflection');
  memory.remember(entry({ revision: 2, lastText: 'Revised reflection.' }), 'reflection');
  assert.equal(memory.entries().length, 1, 'a revision must not duplicate identity');
  assert.equal(memory.hasMet('test-resident'), true);
  assert.equal(memory.hasHeard('test-resident'), true);
  assert.deepEqual(memory.entries()[0].beats, ['test-chapter@1:reflection', 'test-chapter@2:reflection']);
  assert.equal(memory.entries()[0].revision, 2);
  assert.equal(memory.entries()[0].lastText, 'Revised reflection.');
  memory.remember(entry({ revision: 2, lastText: 'Not redelivered.' }), 'reflection');
  assert.equal(saved.writes.length, 2);
  memory.remember(entry({ chapter: 'moved-chapter', revision: 2, place: 'New Place' }), 'reflection');
  assert.equal(memory.entries().length, 1);
  assert.equal(memory.entries()[0].beats.length, 3, 'chapter also scopes beat keys');
  assert.deepEqual(new ListeningMemory(saved).entries(), memory.entries());

  assert.ok(roster.length, 'need an authored resident to verify revised provider');
  const { resident, chapter } = roster[0];
  const authored = new ListeningMemory();
  const first = session(resident, chapter, authored);
  listen(authored, resident, chapter, await first.next());
  listen(authored, resident, chapter, await first.next('reflection'));
  const revisedChapter = { ...chapter, revision: chapter.revision + 1 };
  const revisedResident = { ...resident, returnGreeting: 'A revised welcome back.',
    reflection: { ...resident.reflection, text: 'A new reflection from the same person.' } };
  const revised = session(revisedResident, revisedChapter, authored);
  const hello = await revised.next();
  checkTurn(hello, revisedResident, revisedChapter, 'hello', { returning: true });
  listen(authored, revisedResident, revisedChapter, hello);
  const reflection = await revised.next('reflection');
  checkTurn(reflection, revisedResident, revisedChapter, 'reflection');
  listen(authored, revisedResident, revisedChapter, reflection);
  assert.equal(authored.entries().length, 1);
  assert.equal(authored.entries()[0].beats.length, 4);
  assert.equal(authored.entries()[0].id, resident.id);
  assert.equal(authored.entries()[0].name, resident.speaker.name);
  assert.equal(authored.entries()[0].lastText, revisedResident.reflection.text);
  assert.equal(authored.hasHeard(resident.id), true);
});

for (const [label, raw] of [
  ['absent', null], ['empty', ''], ['malformed JSON', '{broken'], ['null', 'null'],
  ['primitive', '42'], ['array', '[]'], ['missing version', '{"entries":[]}'],
  ['wrong entries type', '{"version":1,"entries":{}}'],
  ['future version', JSON.stringify({ version: 2, entries: [{ ...entry(), beats: ['future'] }] })],
  ['string version', JSON.stringify({ version: '1', entries: [{ ...entry(), beats: [] }] })],
]) {
  test(`storage ${label}: safe empty fallback and usable session`, () => {
    const saved = storage(raw);
    const memory = new ListeningMemory(saved);
    assert.deepEqual(memory.entries(), []);
    assert.equal(saved.writes.length, 0, 'constructor must not rewrite rejected data');
    memory.remember(entry(), 'hello');
    assert.equal(memory.hasMet('test-resident'), true);
    assert.deepEqual(new ListeningMemory(saved).entries(), memory.entries());
  });
}

test('malformed saved entries are isolated; valid neighbors load and fields are bounded', () => {
  const valid = { ...entry(), beats: ['hello', 42, null, 'reflection'] };
  const invalid = [null, 42, 'bad', {},
    ...['id', 'name', 'place', 'chapter', 'lastText'].map(key => ({ ...valid, [key]: 42 })),
    { ...valid, revision: 1.5 }, { ...valid, revision: '1' }, { ...valid, heardReflection: 'true' }];
  const raw = JSON.stringify({ version: 1, entries: [
    { ...valid, id: 'before' }, ...invalid, { ...valid, id: 'after' },
    { ...valid, id: 'missing-beats', beats: undefined },
    { ...valid, id: 'invalid-beats', beats: {} },
    { ...valid, id: 'bounded', lastText: 'x'.repeat(2500), beats: Array.from({ length: 80 }, (_, i) => `beat-${i}`) },
  ] });
  const memory = new ListeningMemory(storage(raw));
  assert.deepEqual(memory.entries().map(item => item.id), ['before', 'after', 'missing-beats', 'invalid-beats', 'bounded']);
  assert.deepEqual(memory.entries()[0].beats, ['hello', 'reflection']);
  assert.deepEqual(memory.entries()[2].beats, []);
  assert.deepEqual(memory.entries()[3].beats, []);
  const bounded = memory.entries()[4];
  assert.equal(bounded.lastText.length, 2000);
  assert.deepEqual(bounded.beats, Array.from({ length: 64 }, (_, i) => `beat-${i + 16}`));
});

for (const blocked of ['read', 'write', 'both']) {
  test(`blocked storage (${blocked}) preserves session memory`, () => {
    const saved = storage(JSON.stringify({ version: 1, entries: [{ ...entry({ id: 'existing' }), beats: [] }] }));
    if (blocked !== 'write') saved.getItem = () => { throw new Error('SecurityError: denied'); };
    if (blocked !== 'read') saved.setItem = () => { throw new Error('QuotaExceededError: full'); };
    const memory = new ListeningMemory(saved);
    assert.equal(memory.hasMet('existing'), blocked === 'write');
    assert.doesNotThrow(() => memory.remember(entry(), 'hello'));
    assert.doesNotThrow(() => memory.remember(entry({ heardReflection: true }), 'reflection'));
    assert.equal(memory.hasMet('test-resident'), true);
    assert.equal(memory.hasHeard('test-resident'), true);
    assert.equal(memory.entries().find(item => item.id === 'test-resident').beats.length, 2);
  });
}

test('entry and beat history bounds survive persistence reload', () => {
  const saved = storage();
  const memory = new ListeningMemory(saved);
  for (let i = 0; i < 257; i++) memory.remember(entry({ id: `resident-${i}` }), 'hello');
  assert.equal(memory.entries().length, 256);
  assert.equal(memory.hasMet('resident-0'), false);
  assert.equal(memory.hasMet('resident-256'), true);
  for (let i = 0; i < 70; i++) memory.remember(entry({ id: 'resident-256', lastText: `Line ${i}` }), `beat-${i}`);
  assert.deepEqual(memory.entries().at(-1).beats,
    Array.from({ length: 64 }, (_, i) => `test-chapter@1:beat-${i + 6}`));
  assert.deepEqual(new ListeningMemory(saved).entries(), memory.entries());
  const oversized = storage(JSON.stringify({ version: 1,
    entries: Array.from({ length: 300 }, (_, i) => ({ ...entry({ id: `saved-${i}` }), beats: [] })) }));
  assert.equal(new ListeningMemory(oversized).entries().length, 256);
});
