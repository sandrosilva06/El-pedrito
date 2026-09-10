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
  const db = await import('../db/database');
  const { planStrategy } = await import('../services/strategist');
  const { writeReply, splitIntoBubbles } = await import('../services/writer');
  const { detectCanton } = await import('../utils/canton');
  const { env } = await import('../config/env');

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

    // Espelha o que o bot faz em runFunnelTurn. Sem isto o harness nunca
    // gravava o cantao e dava a impressao de que a persistencia estava
    // partida quando o que faltava era o teste passar por aqui.
    if (!lead.canton) {
      const detected = detectCanton(incoming) ?? detectCanton(directive.canton);
      if (detected) db.setCanton(CHAT_ID, detected);
    }

    console.log(dim(`\n  ┌─ DIRETRIZ (estrategista, ${t1 - t0}ms)`));
    console.log(dim(`  │ estagio    ${directive.stage}   temp ${directive.temperature}/100`));
    console.log(dim(`  │ perfil     ${directive.profile}`));
    console.log(dim(`  │ cantao     ${db.getLead(CHAT_ID)?.canton ?? '(desconhecido)'}`));
    console.log(dim(`  │ intencao   ${directive.intent}`));
    console.log(dim(`  │ objecao    ${directive.objection}`));
    console.log(dim(`  │ instrucao  ${directive.directive}`));
    console.log(dim(`  │ cta        ${directive.cta}`));
    console.log(dim(`  │ link       ${directive.includeLink}   parar ${directive.shouldStop}`));
    console.log(dim('  └─'));
    const bubbles = splitIntoBubbles(answer, env.MAX_BUBBLES);
    console.log(`\n${bold('BOT')} ${dim(`(redator, ${t2 - t1}ms — ${bubbles.length} mensagens)`)}`);
    bubbles.forEach((bubble, index) => {
      console.log(dim(`  ${index + 1}.`) + ` ${bubble.replace(/\n/g, '\n     ')}`);
    });
    console.log();
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
