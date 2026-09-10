import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
(async () => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const names: string[] = [];
  for await (const m of await ai.models.list()) {
    if (m.name) names.push(m.name.replace('models/', ''));
  }
  const flash = names.filter((n) => /flash/.test(n)).sort();
  console.log('modelos flash disponiveis:\n  ' + flash.join('\n  '));
  console.log('\n1.5-flash presente?', names.some((n) => n.startsWith('gemini-1.5-flash')));
})();
