import type { Lang } from "../../shared/protocol";
import type { Phase } from "../state/machine";

export const STRINGS = {
  en: {
    tagline: "your panda expert",
    status: {
      idle: "Tap the mic and ask me about pandas",
      listening: "Listening…",
      thinking: "Hmm, let me think…",
      speaking: "Tap to interrupt",
      error: "",
    } satisfies Record<Phase, string>,
    you: "You",
    placeholder: "Ask a question about pandas…",
    send: "Send",
    typeInstead: "Type instead",
    useMic: "Use the microphone",
    micStart: "Start talking",
    micStop: "Stop",
    noVoice: "Voice input isn't supported in this browser, so type your question below. Chrome, Edge or Safari support it.",
    suggestions: [
      "What do pandas eat?",
      "Where do giant pandas live?",
      "Why are pandas black and white?",
      "Are pandas endangered?",
      "What's the weather today?",
    ],
    debug: "Latency (press D)",
  },
  fr: {
    tagline: "ton expert des pandas",
    status: {
      idle: "Appuie sur le micro et pose-moi une question sur les pandas",
      listening: "Je t'écoute…",
      thinking: "Hmm, je réfléchis…",
      speaking: "Appuie pour m'interrompre",
      error: "",
    } satisfies Record<Phase, string>,
    you: "Toi",
    placeholder: "Pose une question sur les pandas…",
    send: "Envoyer",
    typeInstead: "Écrire plutôt",
    useMic: "Utiliser le micro",
    micStart: "Parler",
    micStop: "Arrêter",
    noVoice: "La saisie vocale n'est pas disponible dans ce navigateur : écris ta question ci-dessous. Chrome, Edge et Safari la prennent en charge.",
    suggestions: [
      "Que mangent les pandas ?",
      "Où vivent les pandas géants ?",
      "Pourquoi les pandas sont noir et blanc ?",
      "Les pandas sont-ils menacés ?",
      "Quel temps fait-il aujourd'hui ?",
    ],
    debug: "Latence (touche D)",
  },
} satisfies Record<Lang, unknown>;
