import type { StoryChapter } from '../types';

export default {
  id: 'coit',
  revision: 1,
  residents: [
    {
      id: 'ada-bell',
      speaker: { id: 'ada-bell', name: 'Ada Bell', title: 'Retired music teacher' },
      activity: 'watch',
      seed: 'A brisk retired music teacher who leads a small amateur band from a chair.',
      greeting: `Take a breath. The hill isn't going to award you extra credit for pretending it was easy. I used to teach children the recorder; I recognize a person running out of air.`,
      returnGreeting: `There you are again. No examination today either. I'm enjoying the view beside Coit Tower and allowing myself to have absolutely no useful observations about it. You're welcome to join me.`,
      everyday: {
        question: "Still teaching music?",
        text: `A little neighborhood band, in Farah's sewing workroom after hours. We move the cutting table and try not to sit on pins. Our arrangements depend on who arrives. A waltz with no bass is simply a waltz having difficulties.`,
      },
      reflection: {
        question: "Has teaching changed?",
        text: `My knees ended the marching part. I worried sitting down would make me disappear from the band. Then Mika held one clear clarinet note, looked over, and waited for my nod. I still had a job. Listen closely, then let the other person hear that you heard.`,
      },
      connection: {
        residentId: 'nico-bell',
        name: 'Nico Bell',
        place: 'the Wave Organ',
        thread: 'workroom-band',
        question: "Any musical family?",
        unheard: `My nephew Nico Bell records sounds out at the Wave Organ. Water, footsteps, things I'd once have told a class to stop making. He's collecting something for our band, though the kettle gets more rehearsal time than I do.`,
        heard: `You've heard why Nico keeps the kettle click. He played me that recording and I laughed before I recognized my own kitchen. All those years asking for quiet, and the boy was listening to the house.`,
      },
      farewell: `Off you go. You may breathe loudly on the way down as well. Nobody here is grading your lungs, and I have officially put my pencil away.`,
    },
    {
      id: 'rosa-salazar',
      speaker: { id: 'rosa-salazar', name: 'Rosa Salazar', title: 'Upholsterer' },
      activity: 'read',
      seed: 'An upholsterer studying fabric swatches, unapologetic about her own orange armchair.',
      greeting: `You're all right; your shadow isn't bothering me. I'm looking at fabric samples up here by Coit Tower. If a color can survive this much daylight, it can survive somebody's breakfast nook.`,
      returnGreeting: `Hello again. The orange is still winning. You don't need to know what it's competing against; frankly, neither does the orange. I've put the samples aside for a minute.`,
      everyday: {
        question: "Most difficult repair?",
        text: `A sofa that had swallowed fourteen teaspoons. The owner blamed her grandchildren. Those children were six months old. I don't investigate households; I restore their furniture and return the cutlery in a discreet envelope.`,
      },
      reflection: {
        question: "Why the orange?",
        text: `I spent thirty years advising customers to choose something they'd never tire of. Beige, mostly. Then I covered my own chair in a tremendous orange. My nephew Eddie said, "Will that sell?" It isn't for sale. Some mornings I drink my coffee and admire that fact.`,
      },
      connection: {
        residentId: 'miles-reed',
        name: 'Miles Reed',
        place: 'Salesforce',
        thread: 'repair-circle',
        question: "Do you teach repairs?",
        unheard: `Miles Reed, who takes his lunch walks around Salesforce, joins our repair circle. Works with software, arrived afraid of a screwdriver. Very careful hands. He can tell you about his first crooked shelf without anybody else's version helping.`,
        heard: `Miles told you about keeping the crooked shelf? Good. He asked me once whether he ought to hide the brackets. I said, "Does it hold your books?" People pay extra for invisible work. They needn't demand it from themselves.`,
      },
      farewell: `I'll let you get on. If you ever choose upholstery, sit on the sample first. A surprisingly large number of beautiful fabrics are personally opposed to trousers.`,
    },
  ],
} satisfies StoryChapter;
