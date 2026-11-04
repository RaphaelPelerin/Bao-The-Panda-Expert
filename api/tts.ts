import { handleTts } from "../server/tts.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

/** Vercel serverless: speech for one sentence, key from LLM_API_KEY env. */
export default handleTts;
