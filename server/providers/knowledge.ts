import type { Lang, Turn } from "../../shared/protocol";
import { REFUSALS } from "../prompt";

// Offline fallback: a small rule-based panda expert used when Qwen is not
// configured or unreachable. It keeps the demo working and is fully testable.

interface Fact {
  id: string;
  /** Normalized keywords (lowercase, no accents). Each hit adds one point. */
  keywords: string[];
  answer: Record<Lang, string>;
}

const FACTS: Fact[] = [
  {
    id: "diet",
    keywords: ["eat", "eats", "food", "diet", "meal", "hungry", "mange", "mangent", "nourriture", "alimentation", "regime", "manger"],
    answer: {
      en: "Bamboo, bamboo and more bamboo! It makes up about ninety-nine percent of what we eat. Once in a while a wild panda will snack on a small animal or some fruit, but bamboo is the main course.",
      fr: "Du bambou, du bambou et encore du bambou ! Il représente environ quatre-vingt-dix-neuf pour cent de notre alimentation. Parfois, un panda sauvage grignote un petit animal ou un fruit, mais le bambou reste le plat principal.",
    },
  },
  {
    id: "bamboo-amount",
    keywords: ["how much", "much bamboo", "per day", "every day", "a day", "kilos", "kg", "combien", "par jour", "chaque jour", "quantite"],
    answer: {
      en: "A grown panda eats somewhere between twelve and thirty-eight kilos of bamboo every single day. Bamboo isn't very nutritious, so we spend up to fourteen hours a day munching. It's basically a full-time job!",
      fr: "Un panda adulte mange entre douze et trente-huit kilos de bambou par jour. Le bambou n'est pas très nourrissant, alors on passe jusqu'à quatorze heures par jour à mâcher. C'est un vrai travail à plein temps !",
    },
  },
  {
    id: "habitat",
    keywords: ["where", "live in", "habitat", "country", "china", "wild", "forest", "mountain", "ou vivent", "ou vit", "habitat", "chine", "pays", "foret", "montagne"],
    answer: {
      en: "Wild giant pandas live only in the misty mountain forests of central China, mostly in Sichuan, Shaanxi and Gansu. We like cool, wet bamboo forests between about fifteen hundred and three thousand meters up.",
      fr: "Les pandas géants sauvages vivent uniquement dans les forêts de montagne brumeuses du centre de la Chine, surtout au Sichuan, au Shaanxi et au Gansu. On aime les forêts de bambous fraîches et humides, entre environ mille cinq cents et trois mille mètres d'altitude.",
    },
  },
  {
    id: "lifespan",
    keywords: ["how long", "lifespan", "life span", "old", "age", "years", "live for", "die", "combien de temps", "esperance", "duree de vie", "ans", "age", "vivre"],
    answer: {
      en: "In the wild, a giant panda usually lives around fifteen to twenty years. In zoos we can reach about thirty, and the record holder, Jia Jia, lived to thirty-eight!",
      fr: "Dans la nature, un panda géant vit en général entre quinze et vingt ans. En zoo, on peut atteindre une trentaine d'années, et la recordwoman, Jia Jia, a vécu jusqu'à trente-huit ans !",
    },
  },
  {
    id: "colors",
    keywords: ["black and white", "black", "white", "color", "colour", "fur", "patches", "noir et blanc", "noir", "blanc", "couleur", "pelage", "taches"],
    answer: {
      en: "Scientists think our black and white coat is camouflage: the white helps us hide in snow, and the black blends into shady forest. The dark ears and eye patches may also help us recognize each other and look a bit tougher.",
      fr: "Les scientifiques pensent que notre pelage noir et blanc sert de camouflage : le blanc aide à se cacher dans la neige, et le noir se fond dans l'ombre de la forêt. Les oreilles et les taches autour des yeux nous aideraient aussi à nous reconnaître entre nous.",
    },
  },
  {
    id: "status",
    keywords: ["endangered", "extinct", "extinction", "vulnerable", "threatened", "how many", "population", "left", "conservation", "protect", "danger", "menace", "menaces", "disparition", "combien reste", "protection", "population"],
    answer: {
      en: "Good news: giant pandas are no longer listed as endangered. In twenty sixteen we moved to vulnerable, thanks to protected reserves and replanted forests. There are roughly eighteen hundred of us in the wild, so we still need protecting.",
      fr: "Bonne nouvelle : les pandas géants ne sont plus classés en danger. En deux mille seize, on est passés au statut vulnérable grâce aux réserves protégées et à la replantation des forêts. On est environ mille huit cents dans la nature, donc il faut encore nous protéger.",
    },
  },
  {
    id: "cubs",
    keywords: ["baby", "babies", "cub", "cubs", "born", "birth", "newborn", "bebe", "bebes", "petit", "petits", "naissance", "naissent"],
    answer: {
      en: "Panda cubs are tiny! A newborn weighs only about one hundred to two hundred grams, around one nine-hundredth of its mom's weight. They're born pink, blind and almost hairless, and get their black and white coat after a few weeks.",
      fr: "Les bébés pandas sont minuscules ! À la naissance, ils pèsent seulement cent à deux cents grammes, environ neuf cents fois moins que leur maman. Ils naissent roses, aveugles et presque sans poils, et leur pelage noir et blanc apparaît après quelques semaines.",
    },
  },
  {
    id: "size",
    keywords: ["weigh", "weight", "heavy", "big", "size", "tall", "large", "poids", "pese", "lourd", "taille", "grand", "gros"],
    answer: {
      en: "An adult giant panda weighs about seventy to one hundred twenty-five kilos, and big males can go even heavier. Standing on all fours we're around seventy to eighty centimeters tall at the shoulder.",
      fr: "Un panda géant adulte pèse environ soixante-dix à cent vingt-cinq kilos, et les gros mâles peuvent dépasser ça. À quatre pattes, on mesure environ soixante-dix à quatre-vingts centimètres au garrot.",
    },
  },
  {
    id: "thumb",
    keywords: ["thumb", "paw", "paws", "hold", "grip", "pouce", "patte", "pattes", "tenir"],
    answer: {
      en: "We have a secret sixth finger! It's actually an enlarged wrist bone that works like a thumb, so we can grip bamboo stems while we strip and munch them.",
      fr: "On a un sixième doigt secret ! C'est en fait un os du poignet allongé qui fonctionne comme un pouce, pour bien tenir les tiges de bambou pendant qu'on les épluche et les mange.",
    },
  },
  {
    id: "sleep",
    keywords: ["sleep", "sleeps", "nap", "rest", "hibernate", "hibernation", "winter", "dort", "dormir", "sommeil", "sieste", "hiberne", "hibernation", "hiver"],
    answer: {
      en: "We don't hibernate, because bamboo is around all year. Instead we take naps of two to four hours between our long meals, often curled up against a tree or in its branches.",
      fr: "On n'hiberne pas, parce que le bambou est disponible toute l'année. À la place, on fait des siestes de deux à quatre heures entre nos longs repas, souvent blottis contre un arbre ou dans ses branches.",
    },
  },
  {
    id: "bear",
    keywords: ["bear", "red panda", "related", "family", "species", "raccoon", "kind", "ours", "panda roux", "espece", "famille", "cousin"],
    answer: {
      en: "Giant pandas are real bears, part of the bear family. Red pandas share the name and a love of bamboo, but they're a completely separate family, closer to raccoons and weasels than to us.",
      fr: "Les pandas géants sont de vrais ours, de la famille des ursidés. Les pandas roux partagent notre nom et notre amour du bambou, mais ils forment une famille à part, plus proche des ratons laveurs et des belettes que de nous.",
    },
  },
  {
    id: "abilities",
    keywords: ["climb", "climbing", "swim", "swimming", "run", "fast", "tree", "trees", "grimper", "grimpe", "nager", "nage", "courir", "arbre", "arbres"],
    answer: {
      en: "We may look chunky, but we're great climbers and decent swimmers. Cubs start climbing trees at around five months old, and trees are our favorite place to escape danger or take a nap.",
      fr: "On a l'air un peu dodus, mais on grimpe très bien et on nage pas mal. Les petits commencent à grimper aux arbres vers cinq mois, et les arbres sont notre endroit préféré pour échapper au danger ou faire la sieste.",
    },
  },
  {
    id: "sounds",
    keywords: ["sound", "sounds", "noise", "roar", "talk", "communicate", "bleat", "son", "bruit", "cri", "rugir", "communiquer"],
    answer: {
      en: "Pandas don't really roar. We bleat a bit like goats, honk, huff, and chirp, and we also leave scent marks on trees to tell other pandas who's around.",
      fr: "Les pandas ne rugissent pas vraiment. On bêle un peu comme des chèvres, on klaxonne, on souffle et on gazouille, et on laisse aussi des marques d'odeur sur les arbres pour dire aux autres pandas qui est dans le coin.",
    },
  },
];

const PANDA_TERMS = ["panda", "pandas", "bamboo", "bambou", "bambous", "ailurus", "ailuropoda", "jia jia"];

// "pandas" is also a Python library; these mean the user wants code or data help.
const UNRELATED_PANDA_TERMS = ["dataframe", "python", "library", "librairie", "bibliotheque", "code", "import", "pip", "csv", "numpy", "sql"];

const FOLLOW_UP_TERMS = [
  "they", "them", "their", "it", "its", "and", "what about", "how about",
  "ils", "elles", "leur", "leurs", "eux", "et", "quoi", "comment",
];

const GENERIC: Record<Lang, string> = {
  en: "Great panda question! My offline notes don't cover that one, but you can ask me what pandas eat, where they live, how long they live, or why they're black and white.",
  fr: "Super question sur les pandas ! Mes notes hors ligne ne couvrent pas celle-là, mais tu peux me demander ce que mangent les pandas, où ils vivent, combien de temps ils vivent ou pourquoi ils sont noir et blanc.",
};

export function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function hasTerm(normalized: string, term: string): boolean {
  return normalized.includes(` ${term} `);
}

function bestFact(normalized: string): Fact | null {
  let best: Fact | null = null;
  let bestScore = 0;
  for (const fact of FACTS) {
    const score = fact.keywords.filter((k) => hasTerm(normalized, k)).length;
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }
  return best;
}

export interface OfflineAnswer {
  inScope: boolean;
  /** Present only when in scope. */
  text?: string;
}

export function answerOffline(question: string, lang: Lang, history: Turn[]): OfflineAnswer {
  const q = normalize(question);
  const mentionsPanda = PANDA_TERMS.some((t) => hasTerm(q, t));

  if (mentionsPanda && UNRELATED_PANDA_TERMS.some((t) => hasTerm(q, t))) {
    return { inScope: false };
  }

  const fact = bestFact(q);
  const lastAssistant = [...history].reverse().find((t) => t.role === "assistant");
  // A follow-up only counts when the panda's last reply was a real answer, not a refusal.
  const followsPandaTalk = lastAssistant !== undefined && !Object.values(REFUSALS).includes(lastAssistant.text);
  const looksLikeFollowUp = FOLLOW_UP_TERMS.some((t) => hasTerm(q, t)) && fact !== null;

  if (!mentionsPanda && !(followsPandaTalk && looksLikeFollowUp)) {
    return { inScope: false };
  }

  return { inScope: true, text: fact ? fact.answer[lang] : GENERIC[lang] };
}
