import type { StoryChapter } from '../types';

export default {
  id: 'mission',
  revision: 1,
  residents: [
    {
      id: 'tomas-navarro',
      speaker: { id: 'tomas-navarro', name: 'Tomas Navarro', title: 'Night nurse, dinner host' },
      activity: 'watch',
      seed: 'Ines’s son, a night nurse near Mission Dolores who hosts a flexible Sunday supper for friends.',
      greeting: `If I say good morning at entirely the wrong time, forgive me. Night shifts. I walk near Mission Dolores before going home, just to remind my body there's a world outside fluorescent lighting.`,
      returnGreeting: `Hello again. I remember your face; my internal clock is less reliable. I've got time for a little conversation. It's nice having one where neither person is checking a chart.`,
      everyday: {
        question: "Big plans at home?",
        text: `Sleep, then a very optimistic inspection of the refrigerator. I host Sunday dinners when my shifts allow. The fridge contains six people's containers and no six matching lids. We may have accidentally founded a lending library for plastic.`,
      },
      reflection: {
        question: "How did the dinners start?",
        text: `I missed my friends, so I made Sunday dinner into a weekly obligation. Then I got hurt when people couldn't come. June works shifts; Dev has a baby. Now I offer a date and keep an extra chair handy. Dinner happens often enough. I don't take attendance anymore.`,
      },
      connection: {
        residentId: 'june-park',
        name: 'June Park',
        place: 'Ocean Beach',
        thread: 'sunday-table',
        question: "Who's June?",
        unheard: `June Park is my neighbor, a bus operator. She unwinds at Ocean Beach. Ask her about the supermarket pie she brought over. My mother Ines and a round dessert somehow turned it into a geometry lesson.`,
        heard: `You heard June's side of the pie evening. I remember everyone debating whether a circle could have a best corner. She looked so tired coming in. By dessert she had her shoes off under the chair. That's my favorite measure of a successful dinner.`,
      },
      farewell: `I should get home before my second wind makes unreasonable suggestions. Thanks for the company. Have a good whatever part of the day we're officially calling this.`,
    },
    {
      id: 'vic-cole',
      speaker: { id: 'vic-cole', name: 'Vic Cole', title: 'Appliance repair technician' },
      activity: 'chat',
      seed: 'An appliance technician and proud father learning to be the student beside his daughter Imani.',
      greeting: `Vic. I'm between repair calls, taking a walk near Mission Dolores. If your refrigerator is making a funny noise, please let it remain funny for another five minutes. I'm eating my lunch in installments.`,
      returnGreeting: `Hey, good to see you again. Nothing's ringing, nothing's leaking, as far as this particular patch of sidewalk knows. I can spare a minute. It's a nice change of working conditions.`,
      everyday: {
        question: "Strangest repair call?",
        text: `A washing machine that only rattled on Tuesdays. Turned out Tuesday was dog-blanket day, and the dog's metal tag kept going through the wash. I told the owner her machine was fine and her dog was exceptionally clean by proxy.`,
      },
      reflection: {
        question: "Do you teach Imani?",
        text: `These days she teaches me about skateboard bearings. First time, I kept interrupting with what I thought came next. Agnes at our repair circle suggested sitting on my hands. So I did. Imani finished the whole explanation. I asked a question I didn't know the answer to. Good lesson.`,
      },
      connection: {
        residentId: 'jo-park',
        name: 'Jo Park',
        place: 'the Embarcadero',
        thread: 'repair-circle',
        question: "Who brings things to fix?",
        unheard: `Jo Park, a bicycle courier, takes breaks on the Embarcadero. Comes to our repair circle with a bag held together by several generations of stitching. Ask about the yellow thread. There's a mother involved, and she takes credit.`,
        heard: `You know why Jo keeps those big yellow stitches. I used to make every repair look like nobody had touched it. That bag looks like people cared enough to keep working on it. Jo's mother has a right to be pleased.`,
      },
      farewell: `Back to the appliances soon. Good talking with a person who isn't standing beside a puddle for once. Hope the rest of your day runs without a service appointment.`,
    },
  ],
} satisfies StoryChapter;
