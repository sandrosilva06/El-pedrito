/**
 * Envio pontual de uma mensagem de validacao a leads que acabaram de depositar.
 *
 *   npx tsx scripts/notify-ftd.ts --dry-run   # mostra o que faria, sem enviar
 *   npx tsx scripts/notify-ftd.ts             # envia
 *
 * Executa uma vez so: cada envio bem sucedido fica registado num recibo em
 * disco e, numa segunda execucao, esses destinatarios sao saltados. Correr o
 * script duas vezes por engano manda a mesma mensagem duas vezes a pessoas
 * reais, e isso nao se desfaz.
 */
import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';
import { Api, GrammyError } from 'grammy';

interface Target {
  chatId: number;
  name: string;
}

const TARGETS: Target[] = [
  { chatId: 1222882479, name: 'Gilberto' },
  { chatId: 558645729, name: 'Diogo' },
  { chatId: 8419987514, name: 'Marcelino' },
];

const MESSAGE =
  'Boas mano! Já confirmei aqui o teu depósito e a tua conta está 100% validada. 🤝\n\n' +
  'Daqui a nada já te envio o link de acesso direto ao nosso grupo VIP de sinais. ' +
  'Fica atento às mensagens por aqui!';

const RECEIPT_PATH = path.resolve(process.cwd(), 'data/ftd-notified.json');

interface Receipt {
  chatId: number;
  name: string;
  sentAt: string;
  messageId: number;
}

function loadReceipts(): Receipt[] {
  try {
    return JSON.parse(fs.readFileSync(RECEIPT_PATH, 'utf8')) as Receipt[];
  } catch {
    return [];
  }
}

function appendReceipt(entry: Receipt): void {
  const all = [...loadReceipts(), entry];
  fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN em falta.');
    process.exit(1);
  }

  const api = new Api(token);

  // Confirma de que bot se esta a falar antes de enviar seja o que for: com
  // duas personas no repositorio, enganar-se no token manda a mensagem do
  // influencer errado.
  const me = await api.getMe();
  console.log(`Bot: @${me.username} (${me.id})`);
  console.log(`Modo: ${dryRun ? 'DRY RUN (nao envia)' : 'ENVIO REAL'}\n`);

  const alreadySent = new Set(loadReceipts().map((entry) => entry.chatId));
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of TARGETS) {
    const label = `${target.name} (${target.chatId})`;

    if (alreadySent.has(target.chatId)) {
      console.log(`  SALTADO   ${label} — ja consta do recibo`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  ENVIARIA  ${label}`);
      continue;
    }

    try {
      const message = await api.sendMessage(target.chatId, MESSAGE, {
        link_preview_options: { is_disabled: true },
      });

      appendReceipt({
        chatId: target.chatId,
        name: target.name,
        sentAt: new Date().toISOString(),
        messageId: message.message_id,
      });

      console.log(`  ENVIADO   ${label} — message_id ${message.message_id}`);
      sent += 1;
    } catch (error) {
      const description =
        error instanceof GrammyError ? error.description : String(error);
      console.error(`  FALHOU    ${label} — ${description}`);
      failed += 1;
    }

    // O Telegram limita a ~30 mensagens por segundo; com tres destinatarios
    // sobra folga, mas o intervalo mantem-se por habito.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`\nEnviadas: ${sent} | Saltadas: ${skipped} | Falhadas: ${failed}`);
  if (!dryRun) console.log(`Recibo: ${RECEIPT_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

void main();
