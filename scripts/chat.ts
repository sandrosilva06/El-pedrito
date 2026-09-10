/**
 * Harness de terminal para exercitar a cadeia estrategista -> redator, sem o
 * Telegram.
 *
 *   npm run chat                       # REPL interativo
 *   npm run chat -- "quanto custa?"    # turnos roteirizados
 *
 * Cada turno imprime a diretriz do estrategista antes da resposta do redator,
 * que e o que interessa ao calibrar os prompts.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import 'dotenv/config';

// O banco tem de ser escolhido ANTES de db/database ser carregado — ele
// resolve o caminho no import. Um `import` estatico seria icado para cima
// desta linha e o harness escreveria no banco do bot, herdando conversas
// antigas e testando o funil no estagio errado. Dai o import dinamico dentro
// do main().
process.env.DATABASE_PATH = process.env.CHAT_DB ?? './data/chat-harness.sqlite';

const CHAT_ID = Number(process.env.CHAT_ID ?? -1);
const NAME = process.env.LEAD_NAME ?? 'Sandro';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function main(): Promise<void> {
  const db = await import('../src/db/database');
  const { planStrategy } = await import('../src/services/strategist');
  const { writeReply } = await import('../src/services/writer');

  async function turn(incoming: string): Promise<void> {
    const history = db.getRecentMessages(CHAT_ID);
    const lead = db.upsertLead({ chatId: CHAT_ID, firstName: NAME });

    const t0 = Date.now();
    const directive = await planStrategy({ lead, history, incoming });
    const t1 = Date.now();
    const answer = await writeReply({ lead, history, incoming, directive });
    const t2 = Date.now();

    db.addMessage({ chatId: CHAT_ID, role: 'user', content: incoming });
    db.addMessage({
      chatId: CHAT_ID,
      role: 'assistant',
      content: answer,
      directive: JSON.stringify(directive),
    });
    db.advanceStage(CHAT_ID, directive.shouldStop ? 'perdido' : directive.stage);

    console.log(dim(`\n  ┌─ DIRETRIZ (estrategista, ${t1 - t0}ms)`));
    console.log(dim(`  │ estagio    ${directive.stage}   temp ${directive.temperature}/100`));
    console.log(dim(`  │ perfil     ${directive.profile}`));
    console.log(dim(`  │ intencao   ${directive.intent}`));
    console.log(dim(`  │ objecao    ${directive.objection}`));
    console.log(dim(`  │ instrucao  ${directive.directive}`));
    console.log(dim(`  │ cta        ${directive.cta}`));
    console.log(dim(`  │ link       ${directive.includeLink}   parar ${directive.shouldStop}`));
    console.log(dim('  └─'));
    console.log(`\n${bold('BOT')} ${dim(`(redator, ${t2 - t1}ms)`)}\n${answer}\n`);
  }

  const scripted = process.argv.slice(2);

  if (scripted.length > 0) {
    for (const line of scripted) {
      console.log(`${bold('LEAD')} ${line}`);
      await turn(line);
    }
    process.exit(0);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(dim('Cadeia estrategista -> redator. Ctrl+C para sair.\n'));

  for (;;) {
    const line = (await rl.question(bold('LEAD  '))).trim();
    if (line.length === 0) continue;
    await turn(line);
  }
}

void main();
