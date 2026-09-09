import type { StoryChapter } from '../types';

export default {
  id: 'salesforce',
  revision: 1,
  residents: [
    {
      id: 'lila-mehta',
      speaker: { id: 'lila-mehta', name: 'Lila Mehta', title: 'Facilities coordinator' },
      activity: 'stretch',
      seed: 'A facilities coordinator finding company beyond introductions about work.',
      greeting: `I'm trying a lunch break without an errand hidden inside it. Apparently you can just come outside around Salesforce and stand here. Nobody sends an agenda. It's unsettling, but I see the appeal.`,
      returnGreeting: `Welcome back to my extremely informal outdoor office. No meeting rooms available, no refreshments promised. I do have a few minutes, though, and it's nice to recognize someone without checking a badge.`,
      everyday: {
        question: "What do you coordinate?",
        text: `Rooms, keys, deliveries, the delicate ecosystem of office refrigerators. A person once labeled an entire shelf "Kevin." Not Kevin's lunch. Kevin. I had to write an email acknowledging his territorial claim without recognizing it.`,
      },
      reflection: {
        question: "Why the proper break?",
        text: `Our office keeps reorganizing. I started introducing myself as my job even at parties, like I needed to prove the job still existed. At Tomas's dinner, Ruth asked whether I liked beets. I got to be a person who hates beets for a whole evening. Lovely.`,
      },
      connection: {
        residentId: 'ruth-okafor',
        name: 'Ruth Okafor',
        place: 'outside the Japanese Tea Garden',
        thread: 'sunday-table',
        question: "Who is Ruth?",
        unheard: `Ruth Okafor likes to read outside the Japanese Tea Garden. We share Tomas's Sunday table. She brings a beet salad with a family history, and she accepts criticism about neither the beets nor the amount of vinegar.`,
        heard: `You know why Ruth still makes Peter's salad, then. I love that she simply likes it. I keep expecting family recipes to come with solemn instructions. Hers comes with a serving spoon and permission to take something else.`,
      },
      farewell: `I'm giving myself another minute before going back. You can have one too, if there's nobody waiting. I won't count it toward your lunch or put it on a calendar.`,
    },
    {
      id: 'miles-reed',
      speaker: { id: 'miles-reed', name: 'Miles Reed', title: 'Software tester' },
      activity: 'read',
      seed: 'A software tester learning to work with physical things at a monthly repair circle.',
      greeting: `This is a paper manual. I get enough screens at work. I'm reading it out here near Salesforce because at home the shelf it's about is watching me, and I find that accusatory.`,
      returnGreeting: `Hey again. I've reached the diagram where a cheerful outline person owns exactly the right tool. Good for them. I can put it down; the shelf isn't going anywhere quickly.`,
      everyday: {
        question: "What are you reading?",
        text: `A guide to wall fixings. My professional skill is finding ways software breaks. It does not transfer to plaster. Plaster has no undo button, and my landlord has specifically requested that I stop saying "unexpected behavior."`,
      },
      reflection: {
        question: "How did the shelf go?",
        text: `The first shelf leans a little. Safely fastened, just visibly mine. I almost took it down before a friend visited. At the repair circle, Rosa asked if it held my books. It does. I've kept it, with the fattest dictionary on the lower end.`,
      },
      connection: {
        residentId: 'agnes-wu',
        name: 'Agnes Wu',
        place: 'the Palace of Fine Arts',
        thread: 'repair-circle',
        question: "Who's helping you learn?",
        unheard: `Agnes Wu is a retired mechanical drafter who likes the Palace of Fine Arts. At our repair circle she's the one who can explain a hinge with two pencil marks. Ask her about leaving the screwdriver in someone else's hand.`,
        heard: `Agnes told you about learning to wait? I benefit from that waiting. She watches me line up a screw without reaching over. Sometimes I get it wrong twice. She still lets the third try belong to me.`,
      },
      farewell: `I'll get back to my cheerful diagram person. They're about to drill, without even checking the instructions again. Terrifying confidence. Enjoy the rest of your time out here.`,
    },
  ],
} satisfies StoryChapter;
