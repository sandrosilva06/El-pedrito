/**
 * Harness de terminal para exercitar a cadeia Gemini -> Claude sem o Telegram.
 *
 *   npm run chat
 *
 * Cada turno imprime a diretriz do estrategista antes da resposta do redator,
 * que e o que interessa ao calibrar os prompts. Usa um SQLite proprio, em
 * ./data/chat-harness.sqlite, para nao sujar o banco do bot.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

process.env.DATABASE_PATH ??= './data/chat-harness.sqlite';

import { addMessage, advanceStage, getRecentMessages, upsertLead } from '../src/db/database';
import { planStrategy } from '../src/services/gemini';
import { writeReply } from '../src/services/claude';

const CHAT_ID = Number(process.env.CHAT_ID ?? -1);
const NAME = process.env.LEAD_NAME ?? 'Sandro';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function turn(incoming: string): Promise<void> {
  const history = getRecentMessages(CHAT_ID);
  const lead = upsertLead({ chatId: CHAT_ID, firstName: NAME });

  const t0 = Date.now();
  const directive = await planStrategy({ lead, history, incoming });
  const t1 = Date.now();
  const answer = await writeReply({ lead, history, incoming, directive });
  const t2 = Date.now();

  addMessage({ chatId: CHAT_ID, role: 'user', content: incoming });
  addMessage({
    chatId: CHAT_ID,
    role: 'assistant',
    content: answer,
    directive: JSON.stringify(directive),
  });
  advanceStage(CHAT_ID, directive.shouldStop ? 'perdido' : directive.stage);

  console.log(dim('\n  ┌─ DIRETRIZ (Gemini, ' + (t1 - t0) + 'ms)'));
  console.log(dim(`  │ estagio    ${directive.stage}   temp ${directive.temperature}/100`));
  console.log(dim(`  │ intencao   ${directive.intent}`));
  console.log(dim(`  │ objecao    ${directive.objection}`));
  console.log(dim(`  │ instrucao  ${directive.directive}`));
  console.log(dim(`  │ cta        ${directive.cta}`));
  console.log(dim(`  │ link       ${directive.includeLink}   parar ${directive.shouldStop}`));
  console.log(dim('  └─'));
  console.log(`\n${bold('BOT')} ${dim(`(Claude, ${t2 - t1}ms)`)}\n${answer}\n`);
}

async function main(): Promise<void> {
  const scripted = process.argv.slice(2);

  if (scripted.length > 0) {
    for (const line of scripted) {
      console.log(`${bold('LEAD')} ${line}`);
      await turn(line);
    }
    process.exit(0);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(dim('Cadeia Gemini -> Claude. Ctrl+C para sair.\n'));

  for (;;) {
    const line = (await rl.question(bold('LEAD  '))).trim();
    if (line.length === 0) continue;
    await turn(line);
  }
}

void main();
